import express from 'express'
import { WebSocketServer } from 'ws'
import { createServer } from 'http'
import { createReadStream } from 'fs'
import { dirname, join } from 'path'
import { homedir, tmpdir } from 'os'
import { appendFile, mkdir, rm, writeFile } from 'fs/promises'
import open from 'open'
import { findAvailablePort as defaultFindAvailablePort, findChromePath as defaultFindChromePath, launchChrome as defaultLaunchChrome, waitForChromeDebugEndpoint as defaultWaitForChromeDebugEndpoint } from '../chrome-launcher.js'
import { RecordingSession as DefaultRecordingSession } from './index.js'
import { shouldClearActiveSession } from './session-state.js'
import { resolveStartOptions } from './start-options.js'
import { hashForTelemetry } from '../telemetry/config.js'
import { randomUUID } from 'crypto'
import { VideoRecorder as DefaultVideoRecorder } from './video-recorder.js'
import { createMediaRange } from './media-response.js'
import { pipeline } from 'stream/promises'
import { generatePoster as defaultGeneratePoster } from './poster-generator.js'

export function createRecorderHttpServer({
  uiRoot,
  port = 0,
  startUrlBase,
  openFolder = open,
  findChromePath = defaultFindChromePath,
  launchChrome = defaultLaunchChrome,
  findAvailablePort = defaultFindAvailablePort,
  waitForChromeDebugEndpoint = defaultWaitForChromeDebugEndpoint,
  RecordingSession = DefaultRecordingSession,
  nativeToolPathOptions = {},
  createVideoRecorder = (options = {}) => new DefaultVideoRecorder({ ...options, nativeToolPathOptions }),
  chromeReadyTimeoutMs = 20000,
  startupLogFile = join(homedir(), 'Library', 'Application Support', 'browser-forge', 'recorder-startup.log'),
  afterChromeLaunch = async () => {},
  recordingLibrary = null,
  chooseExportDirectory = null,
  revealPath = null,
  generatePoster = defaultGeneratePoster,
  telemetry = { track: async () => {} }
} = {}) {
  const app = express()
  const server = createServer(app)
  const wss = new WebSocketServer({ server })

  let chromeProcess = null
  let activeSession = null
  let sessionDir = null
  let activeVideoRecorder = null
  let activeVideoOutputPath = null
  let isStarting = false
  let isClosing = false
  let startSettledPromise = null
  let hasStartedActiveSession = false
  let stoppingPromise = null
  let unexpectedTerminalVideo
  let activeRecordingId = null
  let lastStopResult = null
  let lastStopEvent = null

  function throwIfClosing() {
    if (isClosing) throw Object.assign(new Error('Browser Forge is closing'), { code: 'APP_CLOSING' })
  }

  function broadcast(message) {
    const payload = JSON.stringify(message)
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(payload)
    }
  }

  function toPublicStopResult(stopped) {
    if (recordingLibrary && stopped?.recording) {
      return { ok: true, recordingId: stopped.recordingId, recording: stopped.recording }
    }
    return { ok: true, sessionDir: stopped }
  }

  async function resetStartupLog(lines = []) {
    if (!startupLogFile) return
    await mkdir(dirname(startupLogFile), { recursive: true })
    await writeFile(startupLogFile, `${lines.join('\n')}\n`)
  }

  async function appendStartupLog(line) {
    if (!startupLogFile) return
    await appendFile(startupLogFile, `${line}\n`).catch(() => {})
  }

  async function releaseActiveResources({
    session = activeSession,
    videoRecorder = activeVideoRecorder,
    chrome = chromeProcess,
    videoOutputPath = activeVideoOutputPath,
    stopVideo = true
  } = {}) {
    if (activeVideoRecorder === videoRecorder) activeVideoRecorder = null
    if (activeVideoOutputPath === videoOutputPath) activeVideoOutputPath = null
    if (activeSession === session) {
      activeSession = null
      hasStartedActiveSession = false
      activeRecordingId = null
    }
    if (chromeProcess === chrome) chromeProcess = null
    if (stopVideo) await videoRecorder?.stop?.().catch(() => {})
    await session?._cdp?.disconnect?.().catch(() => {})
    chrome?.kill?.()
    if (videoOutputPath) await rm(videoOutputPath, { force: true }).catch(() => {})
  }

  async function clearActiveSession() {
    if (stoppingPromise) return stoppingPromise
    if (activeSession && hasStartedActiveSession) return stopActiveRecording()
    await releaseActiveResources()
  }

  function stopActiveRecording(options = {}) {
    if (stoppingPromise) return stoppingPromise
    if (!activeSession) return Promise.resolve(null)

    const session = activeSession
    const videoRecorder = activeVideoRecorder
    const chrome = chromeProcess
    const videoOutputPath = activeVideoOutputPath
    const hasTerminalVideo = Object.prototype.hasOwnProperty.call(options, 'video')
    const summary = typeof session.getTelemetrySummary === 'function'
      ? session.getTelemetrySummary()
      : safeTelemetrySummary(session.getLiveSummary?.())
    const recordingId = activeRecordingId

    activeVideoRecorder = null
    const stopPromise = (async () => {
      try {
        const video = hasTerminalVideo ? options.video : await videoRecorder?.stop?.()
        sessionDir = await session.stop({ video })
        let recording = null
        if (recordingLibrary && recordingId) {
          if (['complete', 'partial'].includes(video?.state)) {
            await generatePoster({
              recordingDir: sessionDir,
              durationMs: video.durationMs ?? summary.duration_ms ?? 0,
              nativeToolPathOptions
            }).catch(error => appendStartupLog(`posterGeneration=failed message=${error.message}`))
          }
          recording = await recordingLibrary.promote({ id: recordingId, sessionDir })
        }
        await telemetry.track('recording_stopped', summary)
        const result = recording ? { sessionDir, recordingId, recording } : sessionDir
        lastStopResult = result
        lastStopEvent = recording
          ? { type: 'recording-completed', recordingId, recording }
          : { type: 'recording-completed', sessionDir: result }
        broadcast(lastStopEvent)
        return result
      } finally {
        await releaseActiveResources({ session, videoRecorder, chrome, videoOutputPath, stopVideo: false })
      }
    })()
    stoppingPromise = stopPromise
    stopPromise.finally(() => {
      if (stoppingPromise === stopPromise) stoppingPromise = null
    }).catch(() => {})
    return stopPromise
  }

  function getSummary() {
    return activeSession?.getLiveSummary() ?? {
      type: 'summary',
      startedAt: null,
      updatedAt: Date.now(),
      tabs: [],
      totals: { events: 0, network: 0, console: 0, artifacts: 0 }
    }
  }

  app.use(express.json({ limit: '256kb' }))

  if (recordingLibrary) registerRecordingLibraryRoutes({ app, recordingLibrary, chooseExportDirectory, revealPath })

  app.use(express.static(uiRoot))

  app.get('/api/chrome-path', async (req, res) => {
    const path = await findChromePath()
    res.json({ path })
  })

  app.post('/api/start-recording', async (req, res) => {
    if (isClosing) return res.json({ ok: false, error: 'Browser Forge is closing' })
    await telemetry.track('recording_start_requested', { requested_port_mode: req.body.port ? 'explicit' : 'dynamic' })
    if (shouldClearActiveSession({ activeSession, chromeProcess })) {
      await stopActiveRecording().catch(() => {})
    }
    if (isStarting) return res.json({ ok: false, error: 'Recording is already starting' })
    if (activeSession) return res.json({ ok: false, error: 'Recording is already active' })

    isStarting = true
    lastStopResult = null
    lastStopEvent = null
    let settleStart
    const thisStartSettled = new Promise(resolve => { settleStart = resolve })
    startSettledPromise = thisStartSettled
    let chromePort
    let videoOutputPath
    try {
      chromePort = Number(req.body.port) || await findAvailablePort()
      throwIfClosing()
      const checkedAt = new Date().toISOString()
      await resetStartupLog([
        `[${checkedAt}] Browser Forge recorder startup`,
        `chromePort=${chromePort}`
      ])
      throwIfClosing()
      const staging = recordingLibrary ? await recordingLibrary.createStagingRecording() : null
      throwIfClosing()
      activeRecordingId = staging?.id ?? null
      const startOptions = await resolveStartOptions({
        chromePath: req.body.chromePath,
        ...(recordingLibrary ? {} : { outputDir: req.body.outputDir }),
        port: chromePort,
        findChromePath
      })
      throwIfClosing()
      const { chromePath, outputDir } = startOptions
      const baseUrl = startUrlBase || `http://127.0.0.1:${server.address().port}`
      const userDataDir = join(homedir(), '.browser-forge', 'chrome-profile')
      const recordingToken = randomUUID()
      const recordingTitle = `Browser Forge Recording · ${recordingToken}`
      const startUrl = `${baseUrl}/recording-start.html?bfRecordingTitle=${encodeURIComponent(recordingTitle)}`
      videoOutputPath = join(tmpdir(), `browser-forge-window-${recordingToken}.mp4`)
      activeVideoOutputPath = videoOutputPath
      await appendStartupLog(`chromePath=${chromePath}`)
      await appendStartupLog(`userDataDir=${userDataDir}`)
      await appendStartupLog(`startUrl=${startUrl}`)
      await telemetry.track('chrome_launch_started', { port: chromePort })
      const chromeStartedAt = Date.now()
      throwIfClosing()
      chromeProcess = launchChrome({
        execPath: chromePath,
        port: chromePort,
        userDataDir,
        startUrl
      })
      await appendStartupLog(`chromePid=${chromeProcess.pid ?? 'unknown'}`)
      await appendStartupLog(`chromeArgs=${JSON.stringify(chromeProcess.browserForge?.args ?? [])}`)
      chromeProcess.once?.('exit', (code, signal) => {
        appendStartupLog(`chromeExit code=${code ?? ''} signal=${signal ?? ''}`).catch(() => {})
        if (activeSession || stoppingPromise) stopActiveRecording().catch(() => {})
      })
      chromeProcess.once?.('error', error => {
        appendStartupLog(`chromeSpawnError=${error.message}`).catch(() => {})
      })
      await waitForChromeDebugEndpoint({
        port: chromePort,
        chromeProcess,
        timeoutMs: chromeReadyTimeoutMs
      })
      throwIfClosing()
      await appendStartupLog('chromeDebugEndpoint=ready')
      await telemetry.track('chrome_launch_succeeded', { duration_ms: Date.now() - chromeStartedAt, chrome_pid_present: Boolean(chromeProcess.pid) })
      await afterChromeLaunch()
      throwIfClosing()
      unexpectedTerminalVideo = undefined
      let videoRecorder
      videoRecorder = createVideoRecorder({
        onUnexpectedTerminal: video => {
          if (activeVideoRecorder !== videoRecorder) return
          unexpectedTerminalVideo = video
          if (hasStartedActiveSession) stopActiveRecording({ video }).catch(() => {})
        }
      })
      activeVideoRecorder = videoRecorder
      const video = await activeVideoRecorder.start({
        chromePid: chromeProcess.pid,
        expectedWindowTitle: recordingTitle,
        outputPath: videoOutputPath
      })
      throwIfClosing()
      await appendStartupLog(`videoRecorder=started startEpochMs=${video.startEpochMs}`)
      activeSession = new RecordingSession({
        port: chromePort,
        ...(recordingLibrary ? { sessionDir: staging.path } : { outputDir }),
        video
      })
      await activeSession.start()
      throwIfClosing()
      sessionDir = null
      hasStartedActiveSession = true
      if (unexpectedTerminalVideo !== undefined) stopActiveRecording({ video: unexpectedTerminalVideo }).catch(() => {})
      await appendStartupLog('recordingSession=started')
      await telemetry.track('recording_started', { port: chromePort })
      res.json({ ok: true, port: chromePort, ...(activeRecordingId ? { recordingId: activeRecordingId } : {}) })
    } catch (error) {
      await appendStartupLog(`startupError=${error.message}`)
      await telemetry.track('chrome_launch_failed', { error_code: error.code ?? 'CHROME_LAUNCH_FAILED', message_hash: hashForTelemetry(error.message) })
      await clearActiveSession().catch(() => {})
      await rm(videoOutputPath ?? '', { force: true }).catch(() => {})
      res.json({ ok: false, error: error.message, code: classifyRecordingStartError(error), logFile: startupLogFile })
    } finally {
      isStarting = false
      settleStart()
      if (startSettledPromise === thisStartSettled) startSettledPromise = null
    }
  })

  app.post('/api/stop-recording', async (req, res) => {
    if (!activeSession && !stoppingPromise) {
      if (lastStopResult !== null) return res.json(toPublicStopResult(lastStopResult))
      return res.json({ ok: false, error: 'No active session' })
    }
    try {
      const stopped = await stopActiveRecording()
      res.json(toPublicStopResult(stopped))
    } catch (error) {
      res.json({ ok: false, error: error.message })
    }
  })

  app.get('/api/tabs', (req, res) => {
    const tabs = activeSession?._cdp.getTargets() ?? []
    res.json({ tabs })
  })

  app.get('/api/summary', async (req, res) => {
    if (shouldClearActiveSession({ activeSession, chromeProcess })) {
      await stopActiveRecording().catch(() => {})
    }
    res.json(getSummary())
  })

  app.get('/api/screenshots/:targetId/:timestamp.png', (req, res) => {
    const image = activeSession?.getScreenshot(req.params.targetId, req.params.timestamp)
    if (!image) return res.status(404).end()
    res.type('png').send(image)
  })

  if (!recordingLibrary) {
    app.post('/api/open-folder', (req, res) => {
      const { path } = req.body
      openFolder(path)
      res.json({ ok: true })
    })
  }

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error)
    const mapped = mapApiError(error)
    res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message } })
  })

  wss.on('connection', (ws) => {
    if (lastStopEvent) ws.send(JSON.stringify(lastStopEvent))
    const interval = setInterval(() => {
      if (activeSession) ws.send(JSON.stringify(activeSession.getLiveSummary()))
    }, 1000)
    ws.on('close', () => clearInterval(interval))
  })

  async function listen() {
    await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
    return `http://127.0.0.1:${server.address().port}`
  }

  async function close() {
    isClosing = true
    if (startSettledPromise) {
      if (hasStartedActiveSession) await stopActiveRecording()
      else await releaseActiveResources()
      await startSettledPromise
    }
    if (activeSession || stoppingPromise) await stopActiveRecording()
    else await clearActiveSession()
    wss.close()
    await new Promise((resolve, reject) => {
      if (!server.listening) return resolve()
      server.close(error => error ? reject(error) : resolve())
    })
  }

  return { app, server, listen, close, getSummary }
}

function classifyRecordingStartError(error) {
  const message = String(error?.message ?? '')
  if (/TCC|screen recording|screen capture|not authorized|permission|denied|拒绝.*(?:捕捉|录制)/iu.test(message)) {
    return 'SCREEN_RECORDING_PERMISSION_DENIED'
  }
  return error?.code || 'RECORDING_START_FAILED'
}

function safeTelemetrySummary(summary = {}) {
  const totals = summary.totals ?? {}
  const tabs = Array.isArray(summary.tabs) ? summary.tabs : []
  const hosts = [...new Set(tabs.map(tab => {
    try { return new URL(tab.url).hostname } catch { return null }
  }).filter(Boolean))].slice(0, 5)
  return {
    tab_count: tabs.length,
    event_count: Number(totals.events) || 0,
    network_count: Number(totals.network) || 0,
    console_count: Number(totals.console) || 0,
    artifact_count: Number(totals.artifacts) || 0,
    top_hosts: hosts
  }
}


function registerRecordingLibraryRoutes({ app, recordingLibrary, chooseExportDirectory, revealPath }) {
  app.get('/api/recordings', asyncRoute(async (req, res) => {
    const recordings = await recordingLibrary.list({ state: req.query.state || 'active', query: req.query.q || '' })
    res.json({ recordings })
  }))

  app.get('/api/recordings/:id', asyncRoute(async (req, res) => {
    res.json(await recordingLibrary.get(req.params.id))
  }))

  app.patch('/api/recordings/:id', asyncRoute(async (req, res) => {
    res.json(await recordingLibrary.rename(req.params.id, req.body?.title))
  }))

  app.get('/api/recordings/:id/timeline', asyncRoute(async (req, res) => {
    res.json({ events: await recordingLibrary.getTimeline(req.params.id) })
  }))

  app.get('/api/recordings/:id/video', asyncRoute(async (req, res) => {
    const media = await recordingLibrary.getVideo(req.params.id)
    let range
    try {
      range = createMediaRange(req.headers.range, media.size)
    } catch (error) {
      await media.handle.close().catch(() => {})
      if (error?.code === 'INVALID_RANGE') res.setHeader('Content-Range', `bytes */${media.size}`)
      throw error
    }
    res.status(range.status)
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Type', 'video/mp4')
    res.setHeader('Content-Length', String(range.length))
    if (range.status === 206) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${media.size}`)
    await pipeOpenedMedia(res, media, { start: range.start, end: range.end })
  }))

  app.get('/api/recordings/:id/poster', asyncRoute(async (req, res) => {
    const media = await recordingLibrary.getPoster(req.params.id)
    res.type('png')
    res.setHeader('Content-Length', String(media.size))
    await pipeOpenedMedia(res, media)
  }))

  app.get('/api/recordings/:id/prompt', asyncRoute(async (req, res) => {
    res.json(await recordingLibrary.getPrompt(req.params.id))
  }))

  app.put('/api/recordings/:id/prompt', asyncRoute(async (req, res) => {
    res.json(await recordingLibrary.savePrompt(req.params.id, req.body?.text))
  }))

  app.get('/api/recordings/:id/external-agent-prompt', asyncRoute(async (req, res) => {
    res.json(await recordingLibrary.getExternalAgentPrompt(req.params.id))
  }))

  app.post('/api/recordings/:id/trash', asyncRoute(async (req, res) => {
    res.json(await recordingLibrary.trash(req.params.id))
  }))

  app.post('/api/recordings/:id/restore', asyncRoute(async (req, res) => {
    res.json(await recordingLibrary.restore(req.params.id))
  }))

  app.delete('/api/recordings/:id', asyncRoute(async (req, res) => {
    res.json(await recordingLibrary.deletePermanently(req.params.id))
  }))

  app.post('/api/recordings/:id/export', asyncRoute(async (req, res) => {
    if (!chooseExportDirectory) throw apiError('UNSUPPORTED_SHELL', 'Export requires the Electron App')
    const destination = await chooseExportDirectory({ recordingId: req.params.id })
    if (!destination) throw apiError('EXPORT_CANCELED', 'Export canceled')
    const result = await recordingLibrary.export(req.params.id, destination)
    if (req.body?.reveal === true && revealPath) await revealPath(result.path)
    res.json(result)
  }))
}

async function pipeOpenedMedia(res, media, range = {}) {
  const stream = createReadStream(media.path, {
    fd: media.handle.fd,
    autoClose: false,
    ...range
  })
  try {
    await pipeline(stream, res)
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error)
      return
    }
    throw error
  } finally {
    await media.handle.close().catch(() => {})
  }
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res)).catch(next)
}

function apiError(code, message) {
  return Object.assign(new Error(message), { code })
}

function mapApiError(error) {
  if (error?.type === 'entity.too.large') return { status: 413, code: 'INVALID_INPUT', message: 'Request body is too large' }
  const statusByCode = {
    INVALID_INPUT: 400,
    NOT_FOUND: 404,
    INVALID_STATE: 409,
    BUSY: 409,
    EXPORT_CANCELED: 409,
    CORRUPT_MATERIAL: 422,
    INVALID_RANGE: 416,
    UNSUPPORTED_SHELL: 501,
    FILESYSTEM_FAILURE: 500
  }
  const code = error?.code && statusByCode[error.code] ? error.code : 'FILESYSTEM_FAILURE'
  return { status: error?.status || statusByCode[code] || 500, code, message: error?.message || 'Request failed' }
}
