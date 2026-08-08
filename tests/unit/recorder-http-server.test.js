import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'path'
import { access, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
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
        pid: 1001,
        exitCode: null,
        killed: false,
        once: () => {},
        kill: () => killedProcesses.push('killed')
      }),
      createVideoRecorder: createFakeVideoRecorder,
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
        return { pid: 1002, exitCode: null, killed: false, once: () => {}, kill: () => {} }
      },
      createVideoRecorder: createFakeVideoRecorder,
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

  it('tracks recording start and stop events with summary fields', async () => {
    const events = []
    class FakeRecordingSession {
      constructor({ port, outputDir }) {
        this.port = port
        this.outputDir = outputDir
        this._cdp = { getTargets: () => [], disconnect: async () => {} }
      }
      async start() {}
      async stop() { return `${this.outputDir}/session-stopped` }
      getLiveSummary() {
        return { type: 'summary', startedAt: 1, updatedAt: 2, tabs: [{ targetId: 't1', url: 'https://example.test/path?secret=1' }], totals: { events: 3, network: 4, console: 1, artifacts: 2 } }
      }
      getTelemetrySummary() {
        return { duration_ms: 1234, tab_count: 1, network_count: 4, click_count: 2, input_count: 1, top_hosts: ['example.test'] }
      }
    }

    recorderServer = createRecorderHttpServer({
      uiRoot: join(process.cwd(), 'ui'),
      startupLogFile: null,
      telemetry: { track: async (name, properties = {}) => events.push([name, properties]) },
      waitForChromeDebugEndpoint: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9666/devtools/browser/test' }),
      findChromePath: async () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      launchChrome: () => ({ pid: 1003, exitCode: null, killed: false, once: () => {}, kill: () => {} }),
      createVideoRecorder: createFakeVideoRecorder,
      RecordingSession: FakeRecordingSession
    })
    const url = await recorderServer.listen()

    await fetch(`${url}/api/start-recording`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputDir: '/tmp/browser-forge-test', port: 9666 })
    })
    await fetch(`${url}/api/stop-recording`, { method: 'POST' })

    expect(events.map(([name]) => name)).toEqual(expect.arrayContaining([
      'recording_start_requested',
      'chrome_launch_started',
      'chrome_launch_succeeded',
      'recording_started',
      'recording_stopped'
    ]))
    expect(events.find(([name]) => name === 'recording_stopped')?.[1]).toMatchObject({
      duration_ms: 1234,
      tab_count: 1,
      network_count: 4,
      top_hosts: ['example.test']
    })
    expect(JSON.stringify(events)).not.toContain('/tmp/browser-forge-test')
    expect(JSON.stringify(events)).not.toContain('secret=1')
  })

})

describe('window video lifecycle', () => {
  it('serializes concurrent stop requests so video finalization and material writing run exactly once', async () => {
    let releaseVideoStop
    let enteredVideoStop
    const videoStopStarted = new Promise(resolve => { enteredVideoStop = resolve })
    let videoStopCount = 0
    let sessionStopCount = 0
    let killCount = 0
    const video = {
      start: async options => ({
        startEpochMs: 1_786_170_000_000,
        window: { pid: 4242, windowId: '99', title: options.expectedWindowTitle }
      }),
      stop: async () => {
        videoStopCount += 1
        enteredVideoStop()
        return new Promise(resolve => { releaseVideoStop = resolve })
      }
    }
    class FakeRecordingSession {
      constructor() { this._cdp = { getTargets: () => [], disconnect: async () => {} } }
      async start() {}
      async stop() { sessionStopCount += 1; return '/tmp/session-once' }
      getLiveSummary() { return { type: 'summary', startedAt: 1, tabs: [], totals: {} } }
    }

    recorderServer = createRecorderHttpServer({
      uiRoot: join(process.cwd(), 'ui'),
      startupLogFile: null,
      findChromePath: async () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      waitForChromeDebugEndpoint: async () => {},
      launchChrome: () => ({ pid: 4242, exitCode: null, once: () => {}, kill: () => { killCount += 1 } }),
      createVideoRecorder: () => video,
      RecordingSession: FakeRecordingSession
    })
    const url = await recorderServer.listen()
    await fetch(`${url}/api/start-recording`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputDir: '/tmp/browser-forge-test', port: 9333 })
    }).then(response => response.json())

    const first = fetch(`${url}/api/stop-recording`, { method: 'POST' }).then(response => response.json())
    await videoStopStarted
    const second = fetch(`${url}/api/stop-recording`, { method: 'POST' }).then(response => response.json())
    // Allow the second HTTP handler to observe the first stop while the native
    // recorder is still deliberately blocked.
    await new Promise(resolve => setTimeout(resolve, 25))
    releaseVideoStop({
      state: 'complete', durationMs: 100, coveredUntilOffsetMs: 100,
      sourcePath: '/tmp/browser-forge-video.mp4',
      window: { pid: 4242, windowId: '99', title: 'Browser Forge Recording · token' }
    })

    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, sessionDir: '/tmp/session-once' },
      { ok: true, sessionDir: '/tmp/session-once' }
    ])
    expect(videoStopCount).toBe(1)
    expect(sessionStopCount).toBe(1)
    expect(killCount).toBe(1)
  })


  it('automatically saves CDP material with a failed video manifest when native capture terminates unexpectedly', async () => {
    let notifyUnexpectedTerminal
    let videoStopCount = 0
    let killCount = 0
    let resolveSessionStopped
    const sessionStopped = new Promise(resolve => { resolveSessionStopped = resolve })
    const failedVideo = {
      state: 'failed', durationMs: 0, coveredUntilOffsetMs: 0,
      window: { pid: 4242, windowId: '99', title: 'Browser Forge Recording · token' }
    }
    const video = {
      start: async options => ({
        startEpochMs: 1_786_170_000_000,
        window: { pid: 4242, windowId: '99', title: options.expectedWindowTitle }
      }),
      stop: async () => { videoStopCount += 1; return failedVideo }
    }
    const finalVideos = []
    class FakeRecordingSession {
      constructor() { this._cdp = { getTargets: () => [], disconnect: async () => {} } }
      async start() {}
      async stop({ video: finalVideo }) {
        finalVideos.push(finalVideo)
        resolveSessionStopped()
        return '/tmp/session-unexpected-video-stop'
      }
      getLiveSummary() { return { type: 'summary', startedAt: 1, tabs: [], totals: {} } }
    }

    recorderServer = createRecorderHttpServer({
      uiRoot: join(process.cwd(), 'ui'),
      startupLogFile: null,
      findChromePath: async () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      waitForChromeDebugEndpoint: async () => {},
      launchChrome: () => ({ pid: 4242, exitCode: null, once: () => {}, kill: () => { killCount += 1 } }),
      createVideoRecorder: options => {
        notifyUnexpectedTerminal = options.onUnexpectedTerminal
        return video
      },
      RecordingSession: FakeRecordingSession
    })
    const url = await recorderServer.listen()
    await fetch(`${url}/api/start-recording`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputDir: '/tmp/browser-forge-test', port: 9333 })
    }).then(response => response.json())

    notifyUnexpectedTerminal(failedVideo)
    await sessionStopped
    await new Promise(resolve => setImmediate(resolve))

    expect(finalVideos).toEqual([failedVideo])
    expect(videoStopCount).toBe(0)
    expect(killCount).toBe(1)
  })


  it('removes the temporary MP4 after persisting a failed video material', async () => {
    let temporaryVideoPath
    const root = await mkdtemp(join(tmpdir(), 'browser-forge-video-cleanup-'))
    const failedVideo = {
      state: 'failed', durationMs: 0, coveredUntilOffsetMs: 0,
      window: { pid: 4242, windowId: '99', title: 'Browser Forge Recording · token' }
    }
    const video = {
      start: async options => {
        temporaryVideoPath = options.outputPath
        await writeFile(temporaryVideoPath, 'incomplete-video')
        return {
          startEpochMs: 1_786_170_000_000,
          window: { pid: 4242, windowId: '99', title: options.expectedWindowTitle }
        }
      },
      stop: async () => failedVideo
    }
    class FakeRecordingSession {
      constructor() { this._cdp = { getTargets: () => [], disconnect: async () => {} } }
      async start() {}
      async stop() { return join(root, 'session') }
      getLiveSummary() { return { type: 'summary', startedAt: 1, tabs: [], totals: {} } }
    }

    try {
      recorderServer = createRecorderHttpServer({
        uiRoot: join(process.cwd(), 'ui'),
        startupLogFile: null,
        findChromePath: async () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        waitForChromeDebugEndpoint: async () => {},
        launchChrome: () => ({ pid: 4242, exitCode: null, once: () => {}, kill: () => {} }),
        createVideoRecorder: () => video,
        RecordingSession: FakeRecordingSession
      })
      const url = await recorderServer.listen()
      await fetch(`${url}/api/start-recording`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outputDir: root, port: 9333 })
      })
      await fetch(`${url}/api/stop-recording`, { method: 'POST' })

      await expect(access(temporaryVideoPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('binds video capture to the Browser Forge Chrome PID/title before CDP collection and finalizes it before material writing', async () => {
    const order = []
    const launched = []
    const video = {
      start: async options => {
        order.push('video:start')
        expect(options.chromePid).toBe(4242)
        expect(options.expectedWindowTitle).toMatch(/^Browser Forge Recording · [a-f0-9-]{36}$/)
        expect(options.outputPath).toMatch(/\.mp4$/)
        return {
          startEpochMs: 1_786_170_000_000,
          window: { pid: 4242, windowId: '99', title: options.expectedWindowTitle }
        }
      },
      stop: async () => {
        order.push('video:stop')
        return {
          state: 'complete',
          durationMs: 234,
          coveredUntilOffsetMs: 234,
          sourcePath: '/tmp/browser-forge-video.mp4',
          window: { pid: 4242, windowId: '99', title: 'Browser Forge Recording · token' }
        }
      }
    }
    const sessionStops = []
    class FakeRecordingSession {
      constructor(options) {
        this.options = options
        this._cdp = { getTargets: () => [], disconnect: async () => {} }
      }
      async start() { order.push('session:start') }
      async stop({ video: finalVideo } = {}) {
        order.push('session:stop')
        sessionStops.push(finalVideo)
        return '/tmp/session'
      }
      getLiveSummary() { return { type: 'summary', startedAt: 1, tabs: [], totals: {} } }
    }

    recorderServer = createRecorderHttpServer({
      uiRoot: join(process.cwd(), 'ui'),
      startupLogFile: null,
      findChromePath: async () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      waitForChromeDebugEndpoint: async () => { order.push('debug:ready') },
      launchChrome: options => {
        launched.push(options)
        return { pid: 4242, exitCode: null, once: () => {}, kill: () => order.push('chrome:kill') }
      },
      createVideoRecorder: () => video,
      RecordingSession: FakeRecordingSession
    })
    const url = await recorderServer.listen()

    const start = await fetch(`${url}/api/start-recording`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputDir: '/tmp/browser-forge-test', port: 9333 })
    }).then(response => response.json())

    expect(start).toEqual({ ok: true, port: 9333 })
    const title = new URL(launched[0].startUrl).searchParams.get('bfRecordingTitle')
    expect(title).toMatch(/^Browser Forge Recording · [a-f0-9-]{36}$/)
    expect(order).toEqual(['debug:ready', 'video:start', 'session:start'])

    const stop = await fetch(`${url}/api/stop-recording`, { method: 'POST' }).then(response => response.json())
    expect(stop).toEqual({ ok: true, sessionDir: '/tmp/session' })
    expect(order).toEqual(['debug:ready', 'video:start', 'session:start', 'video:stop', 'session:stop', 'chrome:kill'])
    expect(sessionStops).toEqual([expect.objectContaining({ state: 'complete', sourcePath: '/tmp/browser-forge-video.mp4' })])
  })
})

function createFakeVideoRecorder() {
  let start = null
  return {
    async start(options) {
      start = options
      return {
        startEpochMs: 1_786_170_000_000,
        window: { pid: options.chromePid, windowId: 'fake-window', title: options.expectedWindowTitle }
      }
    },
    async stop() {
      return {
        state: 'complete',
        startEpochMs: 1_786_170_000_000,
        durationMs: 1,
        coveredUntilOffsetMs: 1,
        sourcePath: start?.outputPath,
        window: { pid: start?.chromePid ?? 1, windowId: 'fake-window', title: start?.expectedWindowTitle ?? 'title' }
      }
    }
  }
}
