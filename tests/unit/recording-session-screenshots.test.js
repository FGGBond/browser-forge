import { describe, it, expect, vi, afterEach } from 'vitest'
import { RecordingSession } from '../../src/main/recorder/index.js'
import { selectPosterOffset } from '../../src/main/recorder/poster-generator.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('RecordingSession screenshot triggers', () => {
  it('uses the native-matched recording window title as the CDP token identity', () => {
    const recording = new RecordingSession({
      outputDir: '/tmp/browser-forge-test',
      video: {
        startEpochMs: 1_000,
        window: { pid: 4242, windowId: '99', title: 'Browser Forge Recording · token-123' }
      }
    })

    expect(recording._cdp.expectedTargetTitle).toBe('Browser Forge Recording · token-123')
  })

  it('uses the requested token title when native matching fell back to the unique Chrome PID window', () => {
    const recording = new RecordingSession({
      outputDir: '/tmp/browser-forge-test',
      video: {
        startEpochMs: 1_000,
        window: {
          pid: 4242,
          windowId: '99',
          title: '',
          requestedTitle: 'Browser Forge Recording · token-fallback',
          matchStrategy: 'unique-pid-window'
        }
      }
    })

    expect(recording._cdp.expectedTargetTitle).toBe('Browser Forge Recording · token-fallback')
  })


  it('enables lifecycle events and feeds failed requests into navigation settling', async () => {
    const recording = new RecordingSession({
      outputDir: '/tmp/browser-forge-test',
      video: { startEpochMs: 1_000, window: { pid: 1, windowId: 'x', title: 'title' } }
    })
    const events = createSettlingSession()

    await recording._setupTabCollectors('tab-1', events.session)

    expect(events.session.Page.setLifecycleEventsEnabled).toHaveBeenCalledWith({ enabled: true })
    expect(events.handlers.loadingFailed).toBeTypeOf('function')

    vi.spyOn(Date, 'now').mockReturnValueOnce(1_100).mockReturnValueOnce(1_120).mockReturnValueOnce(1_160)
    await events.handlers.frameNavigated({ frame: { id: 'frame-1', loaderId: 'loader-1', url: 'https://example.test/orders' } })
    events.handlers.requestWillBeSent({ requestId: 'req-1', loaderId: 'loader-1', type: 'Fetch', request: { url: 'https://example.test/api', method: 'GET', headers: {} } })
    events.handlers.loadingFailed({ requestId: 'req-1', errorText: 'net::ERR_ABORTED' })

    const state = recording._navigationSettling.get('tab-1')
    expect(state.settler._requests.size).toBe(0)
    expect(recording._tabCollectors.get('tab-1').network.getEntries()[0]).toMatchObject({
      loadingFailed: true,
      loadingError: 'net::ERR_ABORTED'
    })
  })

  it('emits one stable navigation after load, network quiet, and three stable viewport samples', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000)
    const recording = new RecordingSession({
      outputDir: '/tmp/browser-forge-test',
      video: { startEpochMs: 1_000, window: { pid: 1, windowId: 'x', title: 'title' } }
    })
    const events = createSettlingSession({
      screenshots: ['transition', 'skeleton', 'stable', 'stable', 'stable', 'stable', 'stable'],
      layoutSignatures: ['transition', 'skeleton', 'stable', 'stable', 'stable', 'stable', 'stable']
    })

    await recording._setupTabCollectors('tab-1', events.session)
    await events.handlers.frameNavigated({ frame: { id: 'frame-1', loaderId: 'loader-1', url: 'https://example.test/orders' } })
    events.handlers.requestWillBeSent({ requestId: 'req-1', loaderId: 'loader-1', type: 'Document', request: { url: 'https://example.test/orders', method: 'GET', headers: {} } })
    events.handlers.lifecycleEvent({ frameId: 'frame-1', loaderId: 'loader-1', name: 'load' })
    events.handlers.loadingFinished({ requestId: 'req-1' })

    await vi.advanceTimersByTimeAsync(1_700)

    const stable = recording._timelineEvents.filter(event => event.type === 'navigation-stable')
    expect(stable).toHaveLength(1)
    expect(stable[0]).toMatchObject({
      url: 'https://example.test/orders',
      loaderId: 'loader-1',
      reason: 'load+network-quiet+visual-stable',
      confidence: 'high'
    })
    expect(stable[0].videoOffsetMs).toBeGreaterThanOrEqual(1_000)
    expect(selectPosterOffset({
      durationMs: 5_000,
      coveredUntilOffsetMs: 4_500,
      timeline: recording._timelineEvents,
      internalOrigins: ['http://127.0.0.1:43123']
    })).toBe(stable[0].videoOffsetMs)
  })

  it('does not settle a hidden tab until it becomes visible and rebuilds a full stable run', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000)
    const recording = new RecordingSession({
      outputDir: '/tmp/browser-forge-test',
      video: { startEpochMs: 1_000, window: { pid: 1, windowId: 'x', title: 'title' } }
    })
    const events = createSettlingSession({
      screenshots: Array(20).fill('stable'),
      layoutSignatures: Array(20).fill('stable'),
      visibilityStates: ['visible', 'visible', 'hidden', 'hidden', 'hidden', 'hidden', 'visible', 'visible', 'visible', 'visible']
    })

    await recording._setupTabCollectors('tab-background', events.session)
    await events.handlers.frameNavigated({ frame: { id: 'frame-1', loaderId: 'loader-1', url: 'https://example.test/background' } })
    events.handlers.lifecycleEvent({ frameId: 'frame-1', loaderId: 'loader-1', name: 'load' })

    await vi.advanceTimersByTimeAsync(1_800)
    expect(recording._timelineEvents.filter(event => event.type === 'navigation-stable')).toEqual([])

    await vi.advanceTimersByTimeAsync(1_000)
    expect(recording._timelineEvents.filter(event => event.type === 'navigation-stable')).toEqual([
      expect.objectContaining({
        targetId: 'tab-background',
        url: 'https://example.test/background',
        confidence: 'high'
      })
    ])
    expect(events.session.Runtime.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      expression: expect.stringContaining('document.visibilityState')
    }))
  })

  it('recovers an already-complete external page attached after a fast address-bar navigation', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(5_000)
    const recording = new RecordingSession({
      outputDir: '/tmp/browser-forge-test',
      video: { startEpochMs: 4_000, window: { pid: 1, windowId: 'x', title: 'title' } }
    })
    const events = createSettlingSession({
      currentFrame: { id: 'frame-fast', loaderId: 'loader-fast', url: 'https://fast.example/dashboard' },
      readyState: 'complete',
      screenshots: Array(8).fill('stable-fast'),
      layoutSignatures: Array(8).fill('stable-fast')
    })

    await recording._setupTabCollectors('tab-fast', events.session)
    await vi.advanceTimersByTimeAsync(1_500)

    expect(recording._timelineEvents).toContainEqual(expect.objectContaining({
      type: 'navigation-stable',
      url: 'https://fast.example/dashboard',
      loaderId: 'loader-fast',
      confidence: 'high'
    }))
  })


  it('cancels settling when the tab session disconnects', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(20_000)
    const recording = new RecordingSession({
      outputDir: '/tmp/browser-forge-test',
      video: { startEpochMs: 19_000, window: { pid: 1, windowId: 'x', title: 'title' } }
    })
    const events = createSettlingSession({ screenshots: Array(20).fill('stable'), layoutSignatures: Array(20).fill('stable') })
    await recording._setupTabCollectors('tab-detached', events.session)
    await events.handlers.frameNavigated({ frame: { id: 'frame-1', loaderId: 'loader-1', url: 'https://example.test' } })
    events.handlers.lifecycleEvent({ frameId: 'frame-1', loaderId: 'loader-1', name: 'load' })

    await events.session.close()
    await vi.advanceTimersByTimeAsync(12_000)

    expect(recording._navigationSettling.has('tab-detached')).toBe(false)
    expect(recording._timelineEvents.filter(event => event.type === 'navigation-stable')).toEqual([])
    expect(events.session.removeListener).toHaveBeenCalledWith('Runtime.bindingCalled', expect.any(Function))
    expect(events.session.removeListener).toHaveBeenCalledWith('Runtime.consoleAPICalled', expect.any(Function))
    expect(events.session.removeListener).toHaveBeenCalledWith('Runtime.exceptionThrown', expect.any(Function))
  })

  it('cancels settling timers on stop so no candidate is created after video capture ended', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const recording = new RecordingSession({
      outputDir: '/tmp/browser-forge-test',
      video: { startEpochMs: 9_000, window: { pid: 1, windowId: 'x', title: 'title' } }
    })
    const events = createSettlingSession({ screenshots: Array(20).fill('stable'), layoutSignatures: Array(20).fill('stable') })
    await recording._setupTabCollectors('tab-1', events.session)
    await events.handlers.frameNavigated({ frame: { id: 'frame-1', loaderId: 'loader-1', url: 'https://example.test' } })
    events.handlers.lifecycleEvent({ frameId: 'frame-1', loaderId: 'loader-1', name: 'load' })
    recording._cdp = {
      getTargets: () => [{ targetId: 'tab-1', title: 'Example', url: 'https://example.test' }],
      _targets: new Map([['tab-1', { session: events.session }]]),
      disconnect: vi.fn()
    }
    vi.spyOn(recording, '_writeSession').mockResolvedValue('/tmp/browser-forge-test/session-test')

    await recording.stop({ video: { state: 'complete', startEpochMs: 9_000, durationMs: 500, coveredUntilOffsetMs: 500 } })
    await vi.advanceTimersByTimeAsync(12_000)

    expect(recording._timelineEvents.filter(event => event.type === 'navigation-stable')).toEqual([])
    expect(recording._navigationSettling.size).toBe(0)
  })


  it('waits for a response body task that started before video stop before building HAR', async () => {
    const body = deferred()
    const recording = new RecordingSession({ outputDir: '/tmp/browser-forge-test' })
    recording._startedAt = Date.now()
    const events = createSettlingSession({ getResponseBody: vi.fn(() => body.promise) })
    await recording._setupTabCollectors('tab-1', events.session)
    recording._cdp = createSessionCdp('tab-1', events.session, 'https://example.test/data')
    const writeSession = vi.spyOn(recording, '_writeSession').mockResolvedValue('/tmp/browser-forge-test/session-test')
    vi.spyOn(recording, '_captureActiveTabScreenshot').mockResolvedValue(false)

    events.handlers.requestWillBeSent({
      requestId: 'req-1', loaderId: 'loader-1', type: 'Fetch',
      request: { url: 'https://example.test/api/data', method: 'GET', headers: {} }
    })
    events.handlers.responseReceived({
      requestId: 'req-1',
      response: { status: 200, headers: {}, mimeType: 'application/json', url: 'https://example.test/api/data' }
    })
    events.handlers.loadingFinished({ requestId: 'req-1' })

    const stopping = recording.stop()
    await Promise.resolve()
    await Promise.resolve()
    expect(writeSession).not.toHaveBeenCalled()

    body.resolve({ body: '{"ready":true}', base64Encoded: false })
    await stopping

    expect(writeSession.mock.calls[0][0].har.log.entries[0].response.content.text).toBe('{"ready":true}')
  })

  it('waits for navigation DOM artifacts that started before video stop before building tabs', async () => {
    const documentResult = deferred()
    const recording = new RecordingSession({ outputDir: '/tmp/browser-forge-test' })
    recording._startedAt = Date.now()
    const events = createSettlingSession({ getDocument: vi.fn(() => documentResult.promise) })
    await recording._setupTabCollectors('tab-1', events.session)
    recording._cdp = createSessionCdp('tab-1', events.session, 'https://example.test/orders')
    const writeSession = vi.spyOn(recording, '_writeSession').mockResolvedValue('/tmp/browser-forge-test/session-test')
    vi.spyOn(recording, '_captureActiveTabScreenshot').mockResolvedValue(false)

    await events.handlers.frameNavigated({ frame: { id: 'frame-1', loaderId: 'loader-1', url: 'https://example.test/orders' } })
    events.handlers.lifecycleEvent({ frameId: 'frame-1', loaderId: 'loader-1', name: 'load' })

    const stopping = recording.stop()
    await Promise.resolve()
    await Promise.resolve()
    expect(writeSession).not.toHaveBeenCalled()

    documentResult.resolve({ root: { nodeId: 1 } })
    await stopping

    expect(writeSession.mock.calls[0][0].tabs['tab-1']).toMatchObject({
      domSnapshots: [expect.objectContaining({ html: '<html></html>', url: 'https://example.test/orders' })],
      screenshots: [expect.objectContaining({ dataBase64: 'stable' })]
    })
  })

  it('bounds pending task drain when a CDP operation never resolves', async () => {
    vi.useFakeTimers()
    const body = deferred()
    const recording = new RecordingSession({ outputDir: '/tmp/browser-forge-test' })
    recording._startedAt = Date.now()
    const events = createSettlingSession({ getResponseBody: vi.fn(() => body.promise) })
    await recording._setupTabCollectors('tab-1', events.session)
    recording._cdp = createSessionCdp('tab-1', events.session, 'https://example.test/data')
    const writeSession = vi.spyOn(recording, '_writeSession').mockResolvedValue('/tmp/browser-forge-test/session-test')
    vi.spyOn(recording, '_captureActiveTabScreenshot').mockResolvedValue(false)

    events.handlers.requestWillBeSent({
      requestId: 'req-1', loaderId: 'loader-1', type: 'Fetch',
      request: { url: 'https://example.test/api/data', method: 'GET', headers: {} }
    })
    events.handlers.loadingFinished({ requestId: 'req-1' })

    const stopping = recording.stop()
    await vi.advanceTimersByTimeAsync(999)
    expect(writeSession).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await stopping
    expect(writeSession).toHaveBeenCalledOnce()

    body.reject(new Error('late CDP failure'))
    await Promise.resolve()
    await Promise.resolve()
  })

  it('cancels delayed interaction screenshots when stopping the session', async () => {
    vi.useFakeTimers()
    const recording = new RecordingSession({ outputDir: '/tmp/browser-forge-test' })
    recording._startedAt = Date.now()
    const bindingHandlers = []
    const session = createFakeSession({ bindingHandlers, screenshotData: 'late-shot' })
    await recording._setupTabCollectors('tab-1', session)
    bindingHandlers[0]({ name: 'bfKey', payload: JSON.stringify({ key: 'Enter', selector: 'INPUT' }) })
    recording._cdp = { getTargets: () => [], _targets: new Map(), disconnect: vi.fn() }
    vi.spyOn(recording, '_writeSession').mockResolvedValue('/tmp/browser-forge-test/session-test')

    await recording.stop()
    await vi.advanceTimersByTimeAsync(300)

    expect(recording._tabCollectors.get('tab-1').screenshots.getScreenshots()).toEqual([])
  })

  it('injects an Enter key listener alongside click capture', async () => {
    const recording = new RecordingSession({ outputDir: '/tmp/browser-forge-test' })
    const pageScripts = []

    await recording._setupTabCollectors('tab-1', createFakeSession({ pageScripts }))

    const injectedScript = pageScripts.join('\n')
    expect(injectedScript).toContain('keydown')
    expect(injectedScript).toContain('Enter')
    expect(injectedScript).toContain('window.bfKey')
  })

  it('captures a screenshot after the user presses Enter', async () => {
    vi.useFakeTimers()
    const recording = new RecordingSession({ outputDir: '/tmp/browser-forge-test' })
    const bindingHandlers = []
    const session = createFakeSession({
      bindingHandlers,
      screenshotData: 'enter-shot'
    })

    await recording._setupTabCollectors('tab-1', session)
    bindingHandlers[0]({
      name: 'bfKey',
      payload: JSON.stringify({ key: 'Enter', selector: 'INPUT' })
    })

    await vi.advanceTimersByTimeAsync(300)

    const collectors = recording._tabCollectors.get('tab-1')
    expect(collectors.screenshots.getScreenshots()).toEqual([
      expect.objectContaining({ dataBase64: 'enter-shot' })
    ])
    expect(collectors.events.getEvents()).toEqual([
      expect.objectContaining({ type: 'keydown', key: 'Enter', selector: 'INPUT' })
    ])
  })

  it('maps interaction timeline events to offsets from the persisted first video frame', async () => {
    const recording = new RecordingSession({
      outputDir: '/tmp/browser-forge-test',
      video: { startEpochMs: 800, window: { pid: 1, windowId: 'x', title: 'title' } }
    })
    const bindingHandlers = []
    const session = createFakeSession({ bindingHandlers })
    vi.spyOn(Date, 'now').mockReturnValue(1_050)

    await recording._setupTabCollectors('tab-1', session)
    bindingHandlers[0]({
      name: 'bfClick',
      payload: JSON.stringify({ x: 10, y: 20, selector: 'BUTTON' })
    })
    await Promise.resolve()

    expect(recording._timelineEvents).toContainEqual({
      timestamp: 1_050, type: 'click', targetId: 'tab-1', x: 10, y: 20, videoOffsetMs: 250
    })
    expect(recording._addTimelineEvent({ timestamp: 700, type: 'navigation', targetId: 'tab-1' })).toEqual({
      timestamp: 700, type: 'navigation', targetId: 'tab-1', videoOffsetMs: 0
    })
  })

  it('captures a screenshot immediately when the user clicks', async () => {
    vi.useFakeTimers()
    const recording = new RecordingSession({ outputDir: '/tmp/browser-forge-test' })
    const bindingHandlers = []
    const session = createFakeSession({
      bindingHandlers,
      screenshotData: 'click-shot'
    })

    await recording._setupTabCollectors('tab-1', session)
    bindingHandlers[0]({
      name: 'bfClick',
      payload: JSON.stringify({ x: 10, y: 20, selector: 'BUTTON' })
    })

    await Promise.resolve()

    const collectors = recording._tabCollectors.get('tab-1')
    expect(session.Page.captureScreenshot).toHaveBeenCalledTimes(1)
    expect(collectors.screenshots.getScreenshots()).toEqual([
      expect.objectContaining({ dataBase64: 'click-shot' })
    ])

    await vi.advanceTimersByTimeAsync(300)
    expect(session.Page.captureScreenshot).toHaveBeenCalledTimes(1)
  })

  it('listens before click handlers so screenshots catch the pre-update pointer state', async () => {
    const recording = new RecordingSession({ outputDir: '/tmp/browser-forge-test' })
    const pageScripts = []

    await recording._setupTabCollectors('tab-1', createFakeSession({ pageScripts }))

    const injectedScript = pageScripts.join('\n')
    expect(injectedScript).toContain("document.addEventListener('pointerdown'")
    expect(injectedScript).toContain('e.button !== 0')
    expect(injectedScript).toContain('window.bfClick')
  })

  it('captures only the visible tab before stopping', async () => {
    const recording = new RecordingSession({ outputDir: '/tmp/browser-forge-test' })
    recording._startedAt = Date.now()
    const visibleSession = createFakeSession({ screenshotData: 'visible-shot', visibilityState: 'visible' })
    const hiddenSession = createFakeSession({ screenshotData: 'hidden-shot', visibilityState: 'hidden' })

    await recording._setupTabCollectors('visible-tab', visibleSession)
    await recording._setupTabCollectors('hidden-tab', hiddenSession)
    recording._cdp = {
      getTargets: () => [
        { targetId: 'visible-tab', title: 'Visible', url: 'https://visible.test' },
        { targetId: 'hidden-tab', title: 'Hidden', url: 'https://hidden.test' }
      ],
      _targets: new Map([
        ['visible-tab', { session: visibleSession, info: { targetId: 'visible-tab', title: 'Visible', url: 'https://visible.test' } }],
        ['hidden-tab', { session: hiddenSession, info: { targetId: 'hidden-tab', title: 'Hidden', url: 'https://hidden.test' } }]
      ]),
      disconnect: vi.fn()
    }

    vi.spyOn(recording, '_writeSession').mockResolvedValue('/tmp/browser-forge-test/session-test')

    await recording.stop()

    expect(recording._tabCollectors.get('visible-tab').screenshots.getScreenshots()).toEqual([
      expect.objectContaining({ dataBase64: 'visible-shot' })
    ])
    expect(recording._tabCollectors.get('hidden-tab').screenshots.getScreenshots()).toEqual([])
  })

  it('uses wall-clock time for the recording duration when video capture failed', async () => {
    const recording = createStoppedRecording({ startedAt: 1_000 })
    const writeSession = vi.spyOn(recording, '_writeSession').mockResolvedValue('/tmp/browser-forge-test/session-test')
    vi.spyOn(Date, 'now').mockReturnValue(6_500)

    await recording.stop({
      video: { state: 'failed', durationMs: 0, coveredUntilOffsetMs: 0 }
    })

    expect(writeSession).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        durationMs: 5_500,
        video: expect.objectContaining({ state: 'failed', durationMs: 0 })
      })
    }))
  })

  it('writes directly to an injected managed session directory', async () => {
    const recording = new RecordingSession({ sessionDir: '/tmp/browser-forge-managed/staging/3d4527e4-4d47-4aea-a4ba-cd61218bbd27' })
    recording._startedAt = 1_786_170_000_123
    recording._cdp = { getTargets: () => [], _targets: new Map(), disconnect: vi.fn() }
    const writeSession = vi.spyOn(recording, '_writeSession').mockResolvedValue(recording.sessionDir)
    vi.spyOn(Date, 'now').mockReturnValue(1_786_170_001_123)

    expect(await recording.stop()).toBe(recording.sessionDir)
    expect(writeSession).toHaveBeenCalledWith(expect.objectContaining({ sessionDir: recording.sessionDir }))
    expect(writeSession.mock.calls[0][0]).not.toHaveProperty('outputDir')
    expect(writeSession.mock.calls[0][0]).not.toHaveProperty('sessionName')
  })

  it('generates distinct session directories for recordings started in the same millisecond', async () => {
    const first = createStoppedRecording({ startedAt: 1_786_170_000_123 })
    const second = createStoppedRecording({ startedAt: 1_786_170_000_123 })
    const firstWrite = vi.spyOn(first, '_writeSession').mockResolvedValue('/tmp/browser-forge-test/first')
    const secondWrite = vi.spyOn(second, '_writeSession').mockResolvedValue('/tmp/browser-forge-test/second')
    vi.spyOn(Date, 'now').mockReturnValue(1_786_170_001_123)

    await first.stop()
    await second.stop()

    const firstName = firstWrite.mock.calls[0][0].sessionName
    const secondName = secondWrite.mock.calls[0][0].sessionName
    expect(firstName).not.toBe(secondName)
    expect(firstName).toMatch(/^session-2026-08-08-\d{6}-123-[a-f0-9-]{36}$/)
    expect(secondName).toMatch(/^session-2026-08-08-\d{6}-123-[a-f0-9-]{36}$/)
  })

  it('exposes screenshot thumbnail URLs without embedding image data in the live summary', async () => {
    const recording = new RecordingSession({ outputDir: '/tmp/browser-forge-test' })
    await recording._setupTabCollectors('tab-1', createFakeSession())
    recording._cdp = {
      getTargets: () => [{ targetId: 'tab-1', title: 'Docs', url: 'https://docs.test' }]
    }
    recording._tabCollectors.get('tab-1').screenshots.addScreenshot({
      timestamp: 12345,
      dataBase64: Buffer.from('png-data').toString('base64')
    })

    const summary = recording.getLiveSummary()

    expect(summary.tabs[0].artifacts.screenshots).toEqual([
      {
        timestamp: 12345,
        kind: 'Screenshot',
        title: 'screenshot-12345.png',
        thumbnailUrl: '/api/screenshots/tab-1/12345.png'
      }
    ])
    expect(JSON.stringify(summary)).not.toContain('png-data')
  })

  it('returns screenshot bytes by target and timestamp for thumbnail routes', async () => {
    const recording = new RecordingSession({ outputDir: '/tmp/browser-forge-test' })
    await recording._setupTabCollectors('tab-1', createFakeSession())
    recording._tabCollectors.get('tab-1').screenshots.addScreenshot({
      timestamp: 12345,
      dataBase64: Buffer.from('png-data').toString('base64')
    })

    expect(recording.getScreenshot('tab-1', 12345)).toEqual(Buffer.from('png-data'))
    expect(recording.getScreenshot('tab-1', 67890)).toBeNull()
  })
})

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createSessionCdp(targetId, session, url) {
  return {
    getTargets: () => [{ targetId, title: 'Example', url }],
    _targets: new Map([[targetId, { session, info: { targetId, title: 'Example', url } }]]),
    disconnect: vi.fn()
  }
}

function createStoppedRecording({ startedAt }) {
  const recording = new RecordingSession({ outputDir: '/tmp/browser-forge-test' })
  recording._startedAt = startedAt
  recording._cdp = {
    getTargets: () => [],
    _targets: new Map(),
    disconnect: vi.fn()
  }
  return recording
}

function createFakeSession({
  pageScripts = [],
  bindingHandlers = [],
  screenshotData = 'shot',
  visibilityState = 'visible'
} = {}) {
  return {
    Network: {
      enable: vi.fn(),
      requestWillBeSent: vi.fn(),
      responseReceived: vi.fn(),
      loadingFinished: vi.fn(),
      loadingFailed: vi.fn(),
      getResponseBody: vi.fn().mockRejectedValue(new Error('no body'))
    },
    Page: {
      enable: vi.fn(),
      setLifecycleEventsEnabled: vi.fn(),
      addScriptToEvaluateOnNewDocument: vi.fn(({ source }) => pageScripts.push(source)),
      captureScreenshot: vi.fn().mockResolvedValue({ data: screenshotData }),
      frameNavigated: vi.fn(),
      lifecycleEvent: vi.fn(),
      getFrameTree: vi.fn().mockResolvedValue({ frameTree: { frame: { id: 'internal', loaderId: 'internal-loader', url: 'http://127.0.0.1/recording-start.html' } } })
    },
    Runtime: {
      enable: vi.fn(),
      addBinding: vi.fn(),
      bindingCalled: vi.fn(handler => bindingHandlers.push(handler)),
      evaluate: vi.fn().mockResolvedValue({ result: { value: visibilityState } }),
      consoleAPICalled: vi.fn(),
      exceptionThrown: vi.fn()
    },
    DOM: {
      enable: vi.fn(),
      getDocument: vi.fn(),
      getOuterHTML: vi.fn()
    },
    removeListener: vi.fn(),
    once: vi.fn(),
    close: vi.fn()
  }
}


function createSettlingSession({
  screenshots = ['stable'],
  layoutSignatures = ['stable'],
  currentFrame = { id: 'frame-internal', loaderId: 'loader-internal', url: 'http://127.0.0.1:43123/recording-start.html' },
  readyState = 'loading',
  visibilityStates = ['visible'],
  getResponseBody = vi.fn().mockRejectedValue(new Error('no body')),
  getDocument = vi.fn().mockResolvedValue({ root: { nodeId: 1 } })
} = {}) {
  const handlers = {}
  let screenshotIndex = 0
  let layoutIndex = 0
  let visibilityIndex = 0
  const session = {
    removeListener: vi.fn(),
    once: vi.fn((name, handler) => { handlers[name] = handler }),
    Network: {
      enable: vi.fn(),
      requestWillBeSent: vi.fn(handler => { handlers.requestWillBeSent = handler }),
      responseReceived: vi.fn(handler => { handlers.responseReceived = handler }),
      loadingFinished: vi.fn(handler => { handlers.loadingFinished = handler }),
      loadingFailed: vi.fn(handler => { handlers.loadingFailed = handler }),
      getResponseBody
    },
    Page: {
      enable: vi.fn(),
      setLifecycleEventsEnabled: vi.fn(),
      addScriptToEvaluateOnNewDocument: vi.fn(),
      captureScreenshot: vi.fn(async () => ({ data: screenshots[Math.min(screenshotIndex++, screenshots.length - 1)] })),
      frameNavigated: vi.fn(handler => { handlers.frameNavigated = handler }),
      lifecycleEvent: vi.fn(handler => { handlers.lifecycleEvent = handler }),
      getFrameTree: vi.fn(async () => ({ frameTree: { frame: currentFrame } }))
    },
    Runtime: {
      enable: vi.fn(),
      addBinding: vi.fn(),
      bindingCalled: vi.fn(),
      evaluate: vi.fn(async ({ expression }) => {
        if (expression.includes('document.documentElement')) {
          const layout = layoutSignatures[Math.min(layoutIndex++, layoutSignatures.length - 1)]
          const visibilityState = visibilityStates[Math.min(visibilityIndex++, visibilityStates.length - 1)]
          return { result: { value: JSON.stringify({ layout, visibilityState }) } }
        }
        if (expression.includes('document.readyState')) {
          return { result: { value: { readyState, url: currentFrame.url } } }
        }
        if (expression === 'document.visibilityState') return { result: { value: 'visible' } }
        if (expression === 'document.title') return { result: { value: 'Example' } }
        return { result: { value: null } }
      }),
      consoleAPICalled: vi.fn(),
      exceptionThrown: vi.fn()
    },
    DOM: {
      enable: vi.fn(),
      getDocument,
      getOuterHTML: vi.fn().mockResolvedValue({ outerHTML: '<html></html>' })
    },
    close: vi.fn()
  }
  return { session, handlers }
}
