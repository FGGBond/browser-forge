import express from 'express'
import { WebSocketServer } from 'ws'
import { createServer } from 'http'
import { join } from 'path'
import { homedir } from 'os'
import open from 'open'
import { findChromePath as defaultFindChromePath, launchChrome as defaultLaunchChrome } from '../chrome-launcher.js'
import { RecordingSession as DefaultRecordingSession } from './index.js'
import { shouldClearActiveSession } from './session-state.js'
import { resolveStartOptions } from './start-options.js'

export function createRecorderHttpServer({
  uiRoot,
  port = 0,
  startUrlBase,
  openFolder = open,
  findChromePath = defaultFindChromePath,
  launchChrome = defaultLaunchChrome,
  RecordingSession = DefaultRecordingSession,
  startupDelayMs = 2000,
  afterChromeLaunch = async () => {}
} = {}) {
  const app = express()
  const server = createServer(app)
  const wss = new WebSocketServer({ server })

  let chromeProcess = null
  let activeSession = null
  let sessionDir = null
  let isStarting = false

  async function clearActiveSession() {
    await activeSession?._cdp?.disconnect?.().catch(() => {})
    activeSession = null
    chromeProcess?.kill?.()
    chromeProcess = null
  }

  async function stopActiveRecording() {
    if (!activeSession) return null
    try {
      sessionDir = await activeSession.stop()
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
    const { port: chromePort = 9222 } = req.body
    if (shouldClearActiveSession({ activeSession, chromeProcess })) {
      await clearActiveSession()
    }
    if (isStarting) return res.json({ ok: false, error: 'Recording is already starting' })
    if (activeSession) return res.json({ ok: false, error: 'Recording is already active' })

    isStarting = true
    try {
      const { chromePath, outputDir } = await resolveStartOptions({
        chromePath: req.body.chromePath,
        outputDir: req.body.outputDir,
        port: chromePort,
        findChromePath
      })
      const baseUrl = startUrlBase || `http://127.0.0.1:${server.address().port}`
      chromeProcess = launchChrome({
        execPath: chromePath,
        port: chromePort,
        userDataDir: join(homedir(), '.browser-forge', 'chrome-profile'),
        startUrl: `${baseUrl}/recording-start.html`
      })
      chromeProcess.once?.('exit', () => {
        if (activeSession) clearActiveSession().catch(() => {})
      })
      if (startupDelayMs > 0) await new Promise(resolve => setTimeout(resolve, startupDelayMs))
      await afterChromeLaunch()
      activeSession = new RecordingSession({ port: chromePort, outputDir })
      await activeSession.start()
      sessionDir = null
      res.json({ ok: true })
    } catch (error) {
      await clearActiveSession()
      res.json({ ok: false, error: error.message })
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
