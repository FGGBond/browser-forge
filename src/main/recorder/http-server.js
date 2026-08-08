import express from 'express'
import { WebSocketServer } from 'ws'
import { createServer } from 'http'
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
  createVideoRecorder = () => new DefaultVideoRecorder(),
  chromeReadyTimeoutMs = 20000,
  startupLogFile = join(homedir(), 'Library', 'Application Support', 'browser-forge', 'recorder-startup.log'),
  afterChromeLaunch = async () => {},
  telemetry = { track: async () => {} }
} = {}) {
  const app = express()
  const server = createServer(app)
  const wss = new WebSocketServer({ server })

  let chromeProcess = null
  let activeSession = null
  let sessionDir = null
  let activeVideoRecorder = null
  let isStarting = false

  async function resetStartupLog(lines = []) {
    if (!startupLogFile) return
    await mkdir(dirname(startupLogFile), { recursive: true })
    await writeFile(startupLogFile, `${lines.join('\n')}\n`)
  }

  async function appendStartupLog(line) {
    if (!startupLogFile) return
    await appendFile(startupLogFile, `${line}\n`).catch(() => {})
  }

  async function clearActiveSession() {
    const videoRecorder = activeVideoRecorder
    activeVideoRecorder = null
    await videoRecorder?.stop?.().catch(() => {})
    await activeSession?._cdp?.disconnect?.().catch(() => {})
    activeSession = null
    chromeProcess?.kill?.()
    chromeProcess = null
  }

  async function stopActiveRecording() {
    if (!activeSession) return null
    const summary = typeof activeSession.getTelemetrySummary === 'function'
      ? activeSession.getTelemetrySummary()
      : safeTelemetrySummary(activeSession.getLiveSummary?.())
    const videoRecorder = activeVideoRecorder
    activeVideoRecorder = null
    try {
      const video = await videoRecorder?.stop?.()
      sessionDir = await activeSession.stop({ video })
      await telemetry.track('recording_stopped', summary)
      return sessionDir
    } finally {
      await clearActiveSession()
    }
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

  app.use(express.json())
  app.use(express.static(uiRoot))

  app.get('/api/chrome-path', async (req, res) => {
    const path = await findChromePath()
    res.json({ path })
  })

  app.post('/api/start-recording', async (req, res) => {
    await telemetry.track('recording_start_requested', { requested_port_mode: req.body.port ? 'explicit' : 'dynamic' })
    if (shouldClearActiveSession({ activeSession, chromeProcess })) {
      await clearActiveSession()
    }
    if (isStarting) return res.json({ ok: false, error: 'Recording is already starting' })
    if (activeSession) return res.json({ ok: false, error: 'Recording is already active' })

    isStarting = true
    let chromePort
    let videoOutputPath
    try {
      chromePort = Number(req.body.port) || await findAvailablePort()
      const checkedAt = new Date().toISOString()
      await resetStartupLog([
        `[${checkedAt}] Browser Forge recorder startup`,
        `chromePort=${chromePort}`
      ])
      const { chromePath, outputDir } = await resolveStartOptions({
        chromePath: req.body.chromePath,
        outputDir: req.body.outputDir,
        port: chromePort,
        findChromePath
      })
      const baseUrl = startUrlBase || `http://127.0.0.1:${server.address().port}`
      const userDataDir = join(homedir(), '.browser-forge', 'chrome-profile')
      const recordingToken = randomUUID()
      const recordingTitle = `Browser Forge Recording · ${recordingToken}`
      const startUrl = `${baseUrl}/recording-start.html?bfRecordingTitle=${encodeURIComponent(recordingTitle)}`
      videoOutputPath = join(tmpdir(), `browser-forge-window-${recordingToken}.mp4`)
      await appendStartupLog(`chromePath=${chromePath}`)
      await appendStartupLog(`userDataDir=${userDataDir}`)
      await appendStartupLog(`startUrl=${startUrl}`)
      await telemetry.track('chrome_launch_started', { port: chromePort })
      const chromeStartedAt = Date.now()
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
        if (activeSession) clearActiveSession().catch(() => {})
      })
      chromeProcess.once?.('error', error => {
        appendStartupLog(`chromeSpawnError=${error.message}`).catch(() => {})
      })
      await waitForChromeDebugEndpoint({
        port: chromePort,
        chromeProcess,
        timeoutMs: chromeReadyTimeoutMs
      })
      await appendStartupLog('chromeDebugEndpoint=ready')
      await telemetry.track('chrome_launch_succeeded', { duration_ms: Date.now() - chromeStartedAt, chrome_pid_present: Boolean(chromeProcess.pid) })
      await afterChromeLaunch()
      activeVideoRecorder = createVideoRecorder()
      const video = await activeVideoRecorder.start({
        chromePid: chromeProcess.pid,
        expectedWindowTitle: recordingTitle,
        outputPath: videoOutputPath
      })
      await appendStartupLog(`videoRecorder=started startEpochMs=${video.startEpochMs}`)
      activeSession = new RecordingSession({ port: chromePort, outputDir, video })
      await activeSession.start()
      sessionDir = null
      await appendStartupLog('recordingSession=started')
      await telemetry.track('recording_started', { port: chromePort })
      res.json({ ok: true, port: chromePort })
    } catch (error) {
      await appendStartupLog(`startupError=${error.message}`)
      await telemetry.track('chrome_launch_failed', { error_code: error.code ?? 'CHROME_LAUNCH_FAILED', message_hash: hashForTelemetry(error.message) })
      await clearActiveSession()
      await rm(videoOutputPath ?? '', { force: true }).catch(() => {})
      res.json({ ok: false, error: error.message, logFile: startupLogFile })
    } finally {
      isStarting = false
    }
  })

  app.post('/api/stop-recording', async (req, res) => {
    if (!activeSession) return res.json({ ok: false, error: 'No active session' })
    try {
      const stoppedDir = await stopActiveRecording()
      res.json({ ok: true, sessionDir: stoppedDir })
    } catch (error) {
      await clearActiveSession()
      res.json({ ok: false, error: error.message })
    }
  })

  app.get('/api/tabs', (req, res) => {
    const tabs = activeSession?._cdp.getTargets() ?? []
    res.json({ tabs })
  })

  app.get('/api/summary', async (req, res) => {
    if (shouldClearActiveSession({ activeSession, chromeProcess })) {
      await clearActiveSession()
    }
    res.json(getSummary())
  })

  app.get('/api/screenshots/:targetId/:timestamp.png', (req, res) => {
    const image = activeSession?.getScreenshot(req.params.targetId, req.params.timestamp)
    if (!image) return res.status(404).end()
    res.type('png').send(image)
  })

  app.post('/api/open-folder', (req, res) => {
    const { path } = req.body
    openFolder(path)
    res.json({ ok: true })
  })

  wss.on('connection', (ws) => {
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
    if (activeSession) await stopActiveRecording()
    else await clearActiveSession()
    wss.close()
    await new Promise((resolve, reject) => {
      if (!server.listening) return resolve()
      server.close(error => error ? reject(error) : resolve())
    })
  }

  return { app, server, listen, close, getSummary }
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

