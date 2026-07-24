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
import { homedir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = 3456

const app = express()
const server = createServer(app)
const wss = new WebSocketServer({ server })

let chromeProcess = null
let activeSession = null
let sessionDir = null
let isStarting = false

// Serve the UI
app.use(express.json())
app.use(express.static(join(__dirname, 'ui')))

// REST API
app.get('/api/chrome-path', async (req, res) => {
  const path = await findChromePath()
  res.json({ path })
})

app.post('/api/start-recording', async (req, res) => {
  const { chromePath, outputDir, port = 9222 } = req.body
  if (isStarting) return res.json({ ok: false, error: 'Recording is already starting' })
  if (activeSession) return res.json({ ok: false, error: 'Recording is already active' })

  isStarting = true
  try {
    chromeProcess = launchChrome({
      execPath: chromePath,
      port,
      userDataDir: join(homedir(), '.browser-forge', 'chrome-profile'),
      startUrl: `http://localhost:${PORT}/recording-start.html`
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
    chromeProcess?.kill()
    chromeProcess = null
    res.json({ ok: false, error: e.message })
  } finally {
    isStarting = false
  }
})

app.post('/api/stop-recording', async (req, res) => {
  if (!activeSession) return res.json({ ok: false, error: 'No active session' })
  try {
    sessionDir = await activeSession.stop()
    activeSession = null
    chromeProcess?.kill()
    chromeProcess = null
    res.json({ ok: true, sessionDir })
  } catch (e) {
    res.json({ ok: false, error: e.message })
  }
})

app.get('/api/tabs', (req, res) => {
  const tabs = activeSession?._cdp.getTargets() ?? []
  res.json({ tabs })
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
      const tabs = activeSession._cdp.getTargets()
      ws.send(JSON.stringify({ type: 'tabs', tabs }))
    }
  }, 2000)
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
  chromeProcess?.kill()
  process.exit(0)
})
