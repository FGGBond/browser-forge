import { describe, it, expect, vi, afterEach } from 'vitest'
import { RecordingSession } from '../../src/main/recorder/index.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('RecordingSession screenshot triggers', () => {
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
      loadingFinished: vi.fn()
    },
    Page: {
      enable: vi.fn(),
      addScriptToEvaluateOnNewDocument: vi.fn(({ source }) => pageScripts.push(source)),
      captureScreenshot: vi.fn().mockResolvedValue({ data: screenshotData }),
      frameNavigated: vi.fn(),
      loadEventFired: vi.fn()
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
    close: vi.fn()
  }
}
