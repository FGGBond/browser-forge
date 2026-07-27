#!/usr/bin/env node
/**
 * browser-forge recorder CLI
 * Starts the shared recorder HTTP UI without Electron.
 */

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { execSync } from 'child_process'
import open from 'open'
import { createRecorderHttpServer } from './src/main/recorder/http-server.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 3456)

const recorderServer = createRecorderHttpServer({
  uiRoot: join(__dirname, 'ui'),
  port: PORT,
  startUrlBase: `http://localhost:${PORT}`,
  afterChromeLaunch: async () => {
    if (process.platform !== 'darwin') return
    try { execSync('osascript -e \'tell application "Google Chrome" to activate\'') } catch {}
  }
})

const url = await recorderServer.listen()
console.log(`\nbrowser-forge running at ${url}\n`)
await open(url)

process.on('SIGINT', async () => {
  console.log('\nStopping browser-forge...')
  await recorderServer.close().catch(() => {})
  process.exit(0)
})
