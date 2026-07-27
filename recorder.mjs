#!/usr/bin/env node
/**
 * browser-forge recorder CLI
 * Starts a local web UI and manages Chrome recording via CDP.
 * No Electron required — UI runs in the system browser.
 */

import express from 'express'
import { WebSocketServer } from 'ws'
import { createServer } from 'http'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { execSync } from 'child_process'
import open from 'open'
import { findChromePath, launchChrome } from './src/main/chrome-launcher.js'
import { RecordingSession } from './src/main/recorder/index.js'
import { shouldClearActiveSession } from './src/main/recorder/session-state.js'
import { resolveStartOptions } from './src/main/recorder/start-options.js'
import { homedir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 3456)

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

// Serve the UI
app.use(express.json())
app.use(express.static(join(__dirname, 'ui')))

// REST API
app.get('/api/chrome-path', async (req, res) => {
  const path = await findChromePath()
  res.json({ path })
})

app.post('/api/start-recording', async (req, res) => {
  const { port = 9222 } = req.body
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
      port,
      findChromePath
    })
    chromeProcess = launchChrome({
      execPath: chromePath,
      port,
      userDataDir: join(homedir(), '.browser-forge', 'chrome-profile'),
      startUrl: `http://localhost:${PORT}/recording-start.html`
    })
    chromeProcess.once('exit', () => {
      if (activeSession) clearActiveSession().catch(() => {})
    })
    await new Promise(r => setTimeout(r, 2000))
    // macOS：把新 Chrome 窗口置前
    if (process.platform === 'darwin') {
      try { execSync('osascript -e \'tell application "Google Chrome" to activate\'') } catch {}
    }
    activeSession = new RecordingSession({ port, outputDir })
    await activeSession.start()
    sessionDir = null
    res.json({ ok: true })
  } catch (e) {
    await clearActiveSession()
    res.json({ ok: false, error: e.message })
  } finally {
    isStarting = false
  }
})

app.post('/api/stop-recording', async (req, res) => {
  if (!activeSession) return res.json({ ok: false, error: 'No active session' })
  try {
    sessionDir = await activeSession.stop()
    await clearActiveSession()
    res.json({ ok: true, sessionDir })
  } catch (e) {
    await clearActiveSession()
    res.json({ ok: false, error: e.message })
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
  res.json(activeSession?.getLiveSummary() ?? {
    type: 'summary',
    startedAt: null,
    updatedAt: Date.now(),
    tabs: [],
    totals: { events: 0, network: 0, console: 0, artifacts: 0 }
  })
})

app.get('/api/screenshots/:targetId/:timestamp.png', (req, res) => {
  const image = activeSession?.getScreenshot(req.params.targetId, req.params.timestamp)
  if (!image) return res.status(404).end()
  res.type('png').send(image)
})

app.post('/api/open-folder', (req, res) => {
  const { path } = req.body
  open(path)
  res.json({ ok: true })
})

// WebSocket for real-time tab updates
wss.on('connection', (ws) => {
  const interval = setInterval(() => {
    if (activeSession) {
      const summary = activeSession.getLiveSummary()
      ws.send(JSON.stringify(summary))
    }
  }, 1000)
  ws.on('close', () => clearInterval(interval))
})

server.listen(PORT, async () => {
  const url = `http://localhost:${PORT}`
  console.log(`\nbrowser-forge running at ${url}\n`)
  await open(url)
})

process.on('SIGINT', async () => {
  if (activeSession) {
    console.log('\nStopping recording...')
    await activeSession.stop().catch(() => {})
  }
  await clearActiveSession()
  process.exit(0)
})
