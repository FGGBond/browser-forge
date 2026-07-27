import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'path'
import { createRecorderHttpServer } from '../../src/main/recorder/http-server.js'

let recorderServer

afterEach(async () => {
  await recorderServer?.close()
  recorderServer = null
})

describe('recorder HTTP server', () => {
  it('serves the polished recorder UI and clean live summary', async () => {
    recorderServer = createRecorderHttpServer({
      uiRoot: join(process.cwd(), 'ui')
    })
    const url = await recorderServer.listen()

    const html = await fetch(url).then(response => response.text())
    const summary = await fetch(`${url}/api/summary`).then(response => response.json())

    expect(html).toContain('Browser Tabs')
    expect(html).toContain('screenshot-grid')
    expect(html).toContain('view-setup')
    expect(html).not.toContain('启动 Chrome 并开始录制</button></div>')
    expect(summary).toEqual(expect.objectContaining({
      type: 'summary',
      startedAt: null,
      tabs: [],
      totals: { events: 0, network: 0, console: 0, artifacts: 0 }
    }))
  })

  it('stops and saves an active recording before server shutdown', async () => {
    const stoppedSessions = []
    const killedProcesses = []

    class FakeRecordingSession {
      constructor({ port, outputDir }) {
        this.port = port
        this.outputDir = outputDir
        this._cdp = { getTargets: () => [], disconnect: async () => {} }
      }

      async start() {}

      async stop() {
        stoppedSessions.push({ port: this.port, outputDir: this.outputDir })
        return `${this.outputDir}/session-stopped`
      }

      getLiveSummary() {
        return {
          type: 'summary',
          startedAt: 1,
          updatedAt: 2,
          tabs: [],
          totals: { events: 0, network: 0, console: 0, artifacts: 0 }
        }
      }
    }

    recorderServer = createRecorderHttpServer({
      uiRoot: join(process.cwd(), 'ui'),
      startupDelayMs: 0,
      findChromePath: async () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      launchChrome: () => ({
        exitCode: null,
        killed: false,
        once: () => {},
        kill: () => killedProcesses.push('killed')
      }),
      RecordingSession: FakeRecordingSession
    })
    const url = await recorderServer.listen()

    const start = await fetch(`${url}/api/start-recording`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputDir: '/tmp/browser-forge-test', port: 9333 })
    }).then(response => response.json())

    expect(start).toEqual({ ok: true })

    await recorderServer.close()
    recorderServer = null

    expect(stoppedSessions).toEqual([{ port: 9333, outputDir: '/tmp/browser-forge-test' }])
    expect(killedProcesses).toEqual(['killed'])
  })
})
