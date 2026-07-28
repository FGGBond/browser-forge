import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'path'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
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
      startupLogFile: null,
      waitForChromeDebugEndpoint: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/test' }),
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

    expect(start).toEqual({ ok: true, port: 9333 })

    await recorderServer.close()
    recorderServer = null

    expect(stoppedSessions).toEqual([{ port: 9333, outputDir: '/tmp/browser-forge-test' }])
    expect(killedProcesses).toEqual(['killed'])
  })

  it('uses a dynamic Chrome debugging port when the request does not provide one', async () => {
    const launched = []
    const sessions = []
    class FakeRecordingSession {
      constructor({ port, outputDir }) {
        sessions.push({ port, outputDir })
        this._cdp = { getTargets: () => [], disconnect: async () => {} }
      }
      async start() {}
      async stop() { return '/tmp/stopped' }
      getLiveSummary() { return { type: 'summary', startedAt: 1, tabs: [], totals: {} } }
    }

    recorderServer = createRecorderHttpServer({
      uiRoot: join(process.cwd(), 'ui'),
      startupLogFile: null,
      findAvailablePort: async () => 9444,
      waitForChromeDebugEndpoint: async ({ port }) => ({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/test` }),
      findChromePath: async () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      launchChrome: options => {
        launched.push(options)
        return { exitCode: null, killed: false, once: () => {}, kill: () => {} }
      },
      RecordingSession: FakeRecordingSession
    })
    const url = await recorderServer.listen()

    const start = await fetch(`${url}/api/start-recording`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputDir: '/tmp/browser-forge-test' })
    }).then(response => response.json())

    expect(start).toEqual({ ok: true, port: 9444 })
    expect(launched[0].port).toBe(9444)
    expect(sessions[0]).toEqual({ port: 9444, outputDir: '/tmp/browser-forge-test' })
  })

  it('returns a startup log path when Chrome debugging endpoint is not ready', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browser-forge-recorder-log-'))
    const logFile = join(root, 'recorder-startup.log')
    try {
      recorderServer = createRecorderHttpServer({
        uiRoot: join(process.cwd(), 'ui'),
        startupLogFile: logFile,
        findAvailablePort: async () => 9555,
        waitForChromeDebugEndpoint: async () => { throw new Error('Chrome 调试端口启动超时：无法连接 127.0.0.1:9555/json/version') },
        findChromePath: async () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        launchChrome: () => ({
          pid: 12345,
          exitCode: null,
          killed: false,
          browserForge: { args: ['--remote-debugging-port=9555'] },
          once: () => {},
          kill: () => {}
        })
      })
      const url = await recorderServer.listen()

      const start = await fetch(`${url}/api/start-recording`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outputDir: '/tmp/browser-forge-test' })
      }).then(response => response.json())

      expect(start).toEqual(expect.objectContaining({ ok: false, logFile }))
      expect(start.error).toContain('Chrome 调试端口启动超时')
      const log = await readFile(logFile, 'utf8')
      expect(log).toContain('chromePort=9555')
      expect(log).toContain('startupError=Chrome 调试端口启动超时')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
