import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { access, mkdtemp, open as openFile, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { createRecorderHttpServer as createRecorderHttpServerImpl } from '../../src/main/recorder/http-server.js'
import { WebSocket } from 'ws'


const grantedPermission = Object.freeze({ supported: true, status: 'granted', granted: true, restartRequired: false })
function createRecorderHttpServer(options = {}) {
  return createRecorderHttpServerImpl({
    screenRecordingPermission: { check: vi.fn(async () => grantedPermission), request: vi.fn(async () => grantedPermission) },
    ...options
  })
}

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

    expect(html).toContain('<div id="app"')
    expect(html).toContain('<link rel="stylesheet" href="/styles.css">')
    expect(html).toContain('<script type="module" src="/app.js"></script>')
    expect(html).not.toContain('output-dir')
    expect(summary).toEqual(expect.objectContaining({
      type: 'summary',
      startedAt: null,
      tabs: [],
      totals: { events: 0, network: 0, console: 0, artifacts: 0 }
    }))
  })

  it('exposes screen recording permission check, request, and fixed-purpose settings endpoints', async () => {
    const screenRecordingPermission = {
      check: vi.fn(async () => ({ supported: true, status: 'not-granted', granted: false, restartRequired: false })),
      request: vi.fn(async () => ({ supported: true, status: 'restart-required', granted: false, restartRequired: true }))
    }
    const openScreenRecordingSettings = vi.fn(async () => {})
    const revealScreenRecordingHelper = vi.fn(async () => {})
    recorderServer = createRecorderHttpServer({
      uiRoot: join(process.cwd(), 'ui'),
      screenRecordingPermission,
      openScreenRecordingSettings,
      revealScreenRecordingHelper
    })
    const url = await recorderServer.listen()

    expect(await fetch(`${url}/api/screen-recording-permission`).then(response => response.json())).toEqual({
      supported: true, status: 'not-granted', granted: false, restartRequired: false
    })
    expect(await fetch(`${url}/api/screen-recording-permission/request`, { method: 'POST' }).then(response => response.json())).toEqual({
      supported: true, status: 'restart-required', granted: false, restartRequired: true
    })
    const settingsResponse = await fetch(`${url}/api/screen-recording-permission/open-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://attacker.example' })
    })

    const revealResponse = await fetch(`${url}/api/screen-recording-permission/reveal-helper`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/tmp/attacker' })
    })
    expect(settingsResponse.status).toBe(204)
    expect(revealResponse.status).toBe(204)
    expect(screenRecordingPermission.check).toHaveBeenCalledTimes(1)
    expect(screenRecordingPermission.request).toHaveBeenCalledTimes(1)
    expect(openScreenRecordingSettings).toHaveBeenCalledWith()
    expect(revealScreenRecordingHelper).toHaveBeenCalledWith()
  })

  it('checks permission before allocating a port, creating staging material, or launching Chrome', async () => {
    const findAvailablePort = vi.fn(async () => 9444)
    const launchChrome = vi.fn()
    const recordingLibrary = { createStagingRecording: vi.fn() }
    const screenRecordingPermission = {
      check: vi.fn(async () => ({ supported: true, status: 'not-granted', granted: false, restartRequired: false })),
      request: vi.fn()
    }
    recorderServer = createRecorderHttpServer({
      uiRoot: join(process.cwd(), 'ui'),
      startupLogFile: null,
      recordingLibrary,
      screenRecordingPermission,
      findAvailablePort,
      launchChrome
    })
    const url = await recorderServer.listen()

    const result = await fetch(`${url}/api/start-recording`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
    }).then(response => response.json())

    expect(result).toEqual({
      ok: false,
      code: 'SCREEN_RECORDING_PERMISSION_REQUIRED',
      error: 'Screen recording permission is required before recording can start',
      permission: { supported: true, status: 'not-granted', granted: false, restartRequired: false }
    })
    expect(screenRecordingPermission.check).toHaveBeenCalledTimes(1)
    expect(findAvailablePort).not.toHaveBeenCalled()
    expect(recordingLibrary.createStagingRecording).not.toHaveBeenCalled()
    expect(launchChrome).not.toHaveBeenCalled()
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

  it('maps native TCC denial to a stable Screen Recording permission code', async () => {
    const denied = Object.assign(new Error('用户拒绝了应用程序、窗口、显示器捕捉的TCC'), { code: 'CAPTURE_START_FAILED' })
    recorderServer = createRecorderHttpServer({
      uiRoot: join(process.cwd(), 'ui'),
      startupLogFile: null,
      findAvailablePort: async () => 9555,
      findChromePath: async () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      waitForChromeDebugEndpoint: async () => {},
      launchChrome: () => ({ pid: 4242, exitCode: null, once: () => {}, kill: () => {} }),
      createVideoRecorder: () => ({ start: async () => { throw denied }, stop: async () => ({ state: 'failed', durationMs: 0, coveredUntilOffsetMs: 0 }) })
    })
    const url = await recorderServer.listen()
    const result = await fetch(`${url}/api/start-recording`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outputDir: '/tmp/browser-forge-test' }) }).then(response => response.json())

    expect(result).toMatchObject({ ok: false, code: 'SCREEN_RECORDING_PERMISSION_DENIED' })
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

  it('returns and broadcasts the promoted result after Chrome stops automatically', async () => {
    const id = '3d4527e4-4d47-4aea-a4ba-cd61218bbd27'
    const stagingPath = `/tmp/browser-forge-managed/staging/${id}`
    const recording = { id, title: 'Orders', state: 'active' }
    const recordingLibrary = {
      createStagingRecording: vi.fn(async () => ({ id, path: stagingPath })),
      promote: vi.fn(async () => recording)
    }
    let exitHandler
    class FakeRecordingSession {
      constructor() { this._cdp = { getTargets: () => [], disconnect: async () => {} } }
      async start() {}
      async stop() { return stagingPath }
      getLiveSummary() { return { type: 'summary', startedAt: 1, tabs: [], totals: {} } }
    }
    recorderServer = createRecorderHttpServer({
      uiRoot: join(process.cwd(), 'ui'),
      startupLogFile: null,
      recordingLibrary,
      generatePoster: async () => {},
      findAvailablePort: async () => 9333,
      findChromePath: async () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      waitForChromeDebugEndpoint: async () => {},
      launchChrome: () => ({ pid: 4242, exitCode: null, once: (event, handler) => { if (event === 'exit') exitHandler = handler }, kill: () => {} }),
      createVideoRecorder: createFakeVideoRecorder,
      RecordingSession: FakeRecordingSession
    })
    const url = await recorderServer.listen()
    await fetch(`${url}/api/start-recording`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })

    exitHandler?.(0, null)
    await vi.waitFor(() => expect(recordingLibrary.promote).toHaveBeenCalled())
    const stopped = await fetch(`${url}/api/stop-recording`, { method: 'POST' }).then(response => response.json())
    expect(stopped).toEqual({ ok: true, recordingId: id, recording })

    const terminal = await new Promise((resolve, reject) => {
      const socket = new WebSocket(url.replace('http:', 'ws:'))
      const timer = setTimeout(() => reject(new Error('terminal event timeout')), 1000)
      socket.on('message', data => {
        const message = JSON.parse(data.toString())
        if (message.type !== 'recording-completed') return
        clearTimeout(timer)
        socket.close()
        resolve(message)
      })
      socket.on('error', reject)
    })
    expect(terminal).toMatchObject({ type: 'recording-completed', recordingId: id, recording })
  })

  it('cancels and awaits an in-progress start before server shutdown', async () => {
    let enteredWait
    const waitStarted = new Promise(resolve => { enteredWait = resolve })
    let releaseWait
    const waitRelease = new Promise(resolve => { releaseWait = resolve })
    const kill = vi.fn(() => releaseWait())
    recorderServer = createRecorderHttpServer({
      uiRoot: join(process.cwd(), 'ui'),
      startupLogFile: null,
      findAvailablePort: async () => 9333,
      findChromePath: async () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      waitForChromeDebugEndpoint: async () => { enteredWait(); await waitRelease },
      launchChrome: () => ({ pid: 4242, exitCode: null, once: () => {}, kill }),
      createVideoRecorder: createFakeVideoRecorder
    })
    const url = await recorderServer.listen()
    const starting = fetch(`${url}/api/start-recording`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outputDir: '/tmp/browser-forge-test' }) }).then(response => response.json())
    await waitStarted

    await recorderServer.close()
    recorderServer = null
    const result = await starting
    expect(result.ok).toBe(false)
    expect(result.error).toContain('closing')
    expect(kill).toHaveBeenCalled()
  })

  it('orderly stops and promotes when quit begins after the recording session started', async () => {
    const id = '3d4527e4-4d47-4aea-a4ba-cd61218bbd27'
    const stagingPath = `/tmp/browser-forge-managed/staging/${id}`
    const recording = { id, title: 'Orders', state: 'active' }
    const recordingLibrary = {
      createStagingRecording: vi.fn(async () => ({ id, path: stagingPath })),
      promote: vi.fn(async () => recording)
    }
    let enteredStartedTelemetry
    const startedTelemetry = new Promise(resolve => { enteredStartedTelemetry = resolve })
    let releaseStartedTelemetry
    const telemetryRelease = new Promise(resolve => { releaseStartedTelemetry = resolve })
    const telemetry = {
      track: vi.fn(async name => {
        if (name === 'recording_started') {
          enteredStartedTelemetry()
          await telemetryRelease
        }
      })
    }
    let stopCount = 0
    class FakeRecordingSession {
      constructor() { this._cdp = { getTargets: () => [], disconnect: async () => {} } }
      async start() {}
      async stop() { stopCount += 1; return stagingPath }
      getLiveSummary() { return { type: 'summary', startedAt: 1, tabs: [], totals: {} } }
    }
    recorderServer = createRecorderHttpServer({
      uiRoot: join(process.cwd(), 'ui'),
      startupLogFile: null,
      recordingLibrary,
      telemetry,
      generatePoster: async () => {},
      findAvailablePort: async () => 9333,
      findChromePath: async () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      waitForChromeDebugEndpoint: async () => {},
      launchChrome: () => ({ pid: 4242, exitCode: null, once: () => {}, kill: () => {} }),
      createVideoRecorder: createFakeVideoRecorder,
      RecordingSession: FakeRecordingSession
    })
    const url = await recorderServer.listen()
    const starting = fetch(`${url}/api/start-recording`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }).then(response => response.json())
    await startedTelemetry

    const closing = recorderServer.close()
    releaseStartedTelemetry()
    await closing
    recorderServer = null
    await starting
    expect(stopCount).toBe(1)
    expect(recordingLibrary.promote).toHaveBeenCalledWith({ id, sessionDir: stagingPath })
  })

  it('starts without outputDir and promotes managed material before returning recording detail', async () => {
    const id = '3d4527e4-4d47-4aea-a4ba-cd61218bbd27'
    const stagingPath = '/tmp/browser-forge-managed/staging/' + id
    const recording = { id, title: 'Orders', state: 'active' }
    const recordingLibrary = {
      createStagingRecording: vi.fn(async () => ({ id, path: stagingPath })),
      promote: vi.fn(async () => recording)
    }
    const sessionOptions = []
    class FakeRecordingSession {
      constructor(options) {
        sessionOptions.push(options)
        this._cdp = { getTargets: () => [], disconnect: async () => {} }
      }
      async start() {}
      async stop() { return stagingPath }
      getLiveSummary() { return { type: 'summary', startedAt: 1, tabs: [], totals: {} } }
    }
    const generatePoster = vi.fn(async () => { throw new Error('poster failed') })
    recorderServer = createRecorderHttpServer({
      uiRoot: join(process.cwd(), 'ui'),
      startupLogFile: null,
      recordingLibrary,
      generatePoster,
      findAvailablePort: async () => 9333,
      findChromePath: async () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      waitForChromeDebugEndpoint: async () => {},
      launchChrome: () => ({ pid: 4242, exitCode: null, once: () => {}, kill: () => {} }),
      createVideoRecorder: createFakeVideoRecorder,
      RecordingSession: FakeRecordingSession
    })
    const url = await recorderServer.listen()

    const started = await fetch(`${url}/api/start-recording`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputDir: '/tmp/attacker-ignored' })
    }).then(response => response.json())
    expect(started).toEqual({ ok: true, port: 9333, recordingId: id })
    expect(sessionOptions[0]).toEqual(expect.objectContaining({ port: 9333, sessionDir: stagingPath }))
    expect(sessionOptions[0]).not.toHaveProperty('outputDir')

    const stopped = await fetch(`${url}/api/stop-recording`, { method: 'POST' }).then(response => response.json())
    expect(generatePoster).toHaveBeenCalledWith(expect.objectContaining({ recordingDir: stagingPath }))
    expect(recordingLibrary.promote).toHaveBeenCalledWith({ id, sessionDir: stagingPath })
    expect(stopped).toEqual({ ok: true, recordingId: id, recording })
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


describe('recording library HTTP API', () => {
  const id = '3d4527e4-4d47-4aea-a4ba-cd61218bbd27'

  async function createLibraryServer(overrides = {}) {
    const mediaRoot = await mkdtemp(join(tmpdir(), 'bf-media-api-'))
    const videoPath = join(mediaRoot, 'recording.mp4')
    const posterPath = join(mediaRoot, 'poster.png')
    await writeFile(videoPath, Buffer.alloc(100, 7))
    await writeFile(posterPath, Buffer.from('png'))
    const recording = { id, title: 'Orders', state: 'active', videoStatus: 'complete' }
    const recordingLibrary = {
      list: vi.fn(async () => [recording]),
      get: vi.fn(async () => recording),
      rename: vi.fn(async (_id, title) => ({ ...recording, title })),
      getTimeline: vi.fn(async () => [{ type: 'click', videoOffsetMs: 123 }]),
      getVideo: vi.fn(async () => ({ path: videoPath, status: 'complete', size: 100, handle: await openFile(videoPath, 'r') })),
      getPoster: vi.fn(async () => ({ path: posterPath, size: 3, handle: await openFile(posterPath, 'r') })),
      getPrompt: vi.fn(async () => ({ text: '', status: 'empty', updatedAt: null })),
      savePrompt: vi.fn(async (_id, text) => ({ text, status: 'draft', updatedAt: '2026-08-08T12:20:00.000Z' })),
      getExternalAgentPrompt: vi.fn(async () => ({ recordingId: id, text: 'complete prompt' })),
      trash: vi.fn(async () => ({ ...recording, state: 'trashed' })),
      restore: vi.fn(async () => recording),
      deletePermanently: vi.fn(async () => ({ id, deleted: true })),
      export: vi.fn(async (_id, destination) => ({ path: join(destination, 'Orders') })),
      ...overrides.recordingLibrary
    }
    const chooseExportDirectory = overrides.chooseExportDirectory ?? vi.fn(async () => mediaRoot)
    recorderServer = createRecorderHttpServer({
      uiRoot: join(process.cwd(), 'ui'),
      startupLogFile: null,
      recordingLibrary,
      chooseExportDirectory,
      revealPath: overrides.revealPath
    })
    const url = await recorderServer.listen()
    return { url, recordingLibrary, chooseExportDirectory, mediaRoot }
  }

  it('serves list, detail, rename, timeline, poster, and prompt routes through recording IDs', async () => {
    const { url, recordingLibrary } = await createLibraryServer()

    expect(await fetch(`${url}/api/recordings?state=active&q=order`).then(r => r.json())).toEqual({ recordings: [expect.objectContaining({ id })] })
    expect(await fetch(`${url}/api/recordings/${id}`).then(r => r.json())).toEqual(expect.objectContaining({ id }))
    expect(await fetch(`${url}/api/recordings/${id}/timeline`).then(r => r.json())).toEqual({ events: [{ type: 'click', videoOffsetMs: 123 }] })
    expect(await fetch(`${url}/api/recordings/${id}/prompt`).then(r => r.json())).toEqual({ text: '', status: 'empty', updatedAt: null })
    expect((await fetch(`${url}/api/recordings/${id}/poster`)).headers.get('content-type')).toContain('image/png')

    const renamed = await fetch(`${url}/api/recordings/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Renamed' }) }).then(r => r.json())
    expect(renamed.title).toBe('Renamed')
    expect(recordingLibrary.list).toHaveBeenCalledWith({ state: 'active', query: 'order' })
    expect(recordingLibrary.rename).toHaveBeenCalledWith(id, 'Renamed')
  })

  it('serves a seekable MP4 with byte ranges', async () => {
    const { url } = await createLibraryServer()
    const response = await fetch(`${url}/api/recordings/${id}/video`, { headers: { Range: 'bytes=10-19' } })

    expect(response.status).toBe(206)
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('content-range')).toBe('bytes 10-19/100')
    expect((await response.arrayBuffer()).byteLength).toBe(10)
  })

  it('returns the standard unsatisfied Content-Range for invalid video ranges', async () => {
    const { url } = await createLibraryServer()
    const response = await fetch(`${url}/api/recordings/${id}/video`, { headers: { Range: 'bytes=100-101' } })

    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */100')
    expect((await response.json()).error.code).toBe('INVALID_RANGE')
  })

  it('maps domain errors to stable JSON error codes', async () => {
    const error = Object.assign(new Error('missing'), { code: 'NOT_FOUND' })
    const { url } = await createLibraryServer({ recordingLibrary: { get: vi.fn(async () => { throw error }) } })
    const response = await fetch(`${url}/api/recordings/${id}`)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'missing' } })
  })

  it('persists and derives prompts without accepting paths', async () => {
    const { url, recordingLibrary } = await createLibraryServer()
    const saved = await fetch(`${url}/api/recordings/${id}/prompt`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'guidance', path: '/tmp/ignored' }) }).then(r => r.json())
    expect(saved.status).toBe('draft')
    expect(recordingLibrary.savePrompt).toHaveBeenCalledWith(id, 'guidance')
    expect(await fetch(`${url}/api/recordings/${id}/external-agent-prompt`).then(r => r.json())).toEqual({ recordingId: id, text: 'complete prompt' })
  })

  it('uses the Electron directory adapter and ignores a renderer destination path', async () => {
    const chooseExportDirectory = vi.fn(async () => '/Users/example/Desktop')
    const { url, recordingLibrary } = await createLibraryServer({ chooseExportDirectory })
    const result = await fetch(`${url}/api/recordings/${id}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ destination: '/tmp/attacker' }) }).then(r => r.json())

    expect(chooseExportDirectory).toHaveBeenCalledWith(expect.objectContaining({ recordingId: id }))
    expect(recordingLibrary.export).toHaveBeenCalledWith(id, '/Users/example/Desktop')
    expect(result.path).toBe('/Users/example/Desktop/Orders')
  })

  it('supports trash, restore, permanent delete, and export cancellation', async () => {
    const { url, recordingLibrary } = await createLibraryServer({ chooseExportDirectory: vi.fn(async () => null) })
    expect((await fetch(`${url}/api/recordings/${id}/trash`, { method: 'POST' })).status).toBe(200)
    expect((await fetch(`${url}/api/recordings/${id}/restore`, { method: 'POST' })).status).toBe(200)
    expect((await fetch(`${url}/api/recordings/${id}`, { method: 'DELETE' })).status).toBe(200)
    const canceled = await fetch(`${url}/api/recordings/${id}/export`, { method: 'POST' })
    expect(canceled.status).toBe(409)
    expect((await canceled.json()).error.code).toBe('EXPORT_CANCELED')
    expect(recordingLibrary.trash).toHaveBeenCalledWith(id)
    expect(recordingLibrary.restore).toHaveBeenCalledWith(id)
    expect(recordingLibrary.deletePermanently).toHaveBeenCalledWith(id)
  })

  it('rejects oversized prompt JSON with a stable input error', async () => {
    const { url } = await createLibraryServer()
    const response = await fetch(`${url}/api/recordings/${id}/prompt`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(300 * 1024) })
    })
    expect(response.status).toBe(413)
    expect((await response.json()).error.code).toBe('INVALID_INPUT')
  })
})
