import { describe, it, expect, vi } from 'vitest'
import { CdpClient } from '../../src/main/recorder/cdp-client.js'

function createCdpHarness({ targetInfos = [], windowIds = {} } = {}) {
  const handlers = {}
  const sessions = new Map()
  const browser = {
    Target: {
      setDiscoverTargets: vi.fn(async () => {}),
      targetCreated: vi.fn(handler => { handlers.targetCreated = handler }),
      targetInfoChanged: vi.fn(handler => { handlers.targetInfoChanged = handler }),
      targetDestroyed: vi.fn(handler => { handlers.targetDestroyed = handler }),
      getTargets: vi.fn(async () => ({ targetInfos })),
      attachToTarget: vi.fn(async ({ targetId }) => {
        const sessionId = `session-${targetId}`
        sessions.set(sessionId, { close: vi.fn() })
        return { sessionId }
      })
    },
    Browser: {
      getWindowForTarget: vi.fn(async ({ targetId }) => {
        const value = windowIds[targetId]
        if (value instanceof Error) throw value
        if (value === undefined) throw new Error(`No window for ${targetId}`)
        return { windowId: value }
      })
    },
    close: vi.fn(async () => {})
  }
  const cdp = vi.fn(async options => {
    if (options?.target) return browser
    return sessions.get(options?.sessionId)
  })
  cdp.Version = vi.fn(async () => ({ webSocketDebuggerUrl: 'ws://browser' }))
  return { browser, cdp, handlers, sessions, windowIds }
}

describe('CdpClient', () => {
  it('can be constructed with a port', () => {
    const client = new CdpClient({ port: 9222 })
    expect(client.port).toBe(9222)
  })

  it('tracks attached targets', () => {
    const client = new CdpClient({ port: 9222 })
    expect(client.getTargets()).toEqual([])
  })

  it('anchors to the token target CDP window and attaches only initial tabs in that window', async () => {
    const tokenTitle = 'Browser Forge Recording · token-123'
    const targetInfos = [
      { targetId: 'token-page', type: 'page', title: tokenTitle, url: 'http://127.0.0.1/start' },
      { targetId: 'same-window', type: 'page', title: 'Docs', url: 'https://docs.test' },
      { targetId: 'other-window', type: 'page', title: 'Private', url: 'https://private.test' }
    ]
    const { cdp, browser } = createCdpHarness({
      targetInfos,
      windowIds: { 'token-page': 41, 'same-window': 41, 'other-window': 99 }
    })
    const client = new CdpClient({ port: 9222, cdp, expectedTargetTitle: tokenTitle })

    await client.connect()

    expect(client.windowId).toBe(41)
    expect(browser.Browser.getWindowForTarget).toHaveBeenCalledWith({ targetId: 'token-page' })
    expect(browser.Browser.getWindowForTarget.mock.calls.filter(([{ targetId }]) => targetId === 'token-page')).toHaveLength(1)
    expect(browser.Target.attachToTarget.mock.calls.map(([{ targetId }]) => targetId)).toEqual([
      'token-page',
      'same-window'
    ])
    expect(client.getTargets().map(target => target.targetId)).toEqual(['token-page', 'same-window'])
  })

  it('attaches newly created tabs in the anchored window and ignores tabs from other windows', async () => {
    const tokenTitle = 'Browser Forge Recording · token-123'
    const { cdp, browser, handlers, windowIds } = createCdpHarness({
      targetInfos: [{ targetId: 'token-page', type: 'page', title: tokenTitle, url: 'http://127.0.0.1/start' }],
      windowIds: { 'token-page': 41 }
    })
    const client = new CdpClient({ port: 9222, cdp, expectedTargetTitle: tokenTitle })
    await client.connect()
    browser.Target.attachToTarget.mockClear()

    windowIds['new-tab'] = 41
    await handlers.targetCreated({ targetInfo: { targetId: 'new-tab', type: 'page', title: 'New tab', url: 'chrome://newtab/' } })
    windowIds['foreign-tab'] = 99
    await handlers.targetCreated({ targetInfo: { targetId: 'foreign-tab', type: 'page', title: 'Foreign', url: 'https://foreign.test' } })

    expect(browser.Target.attachToTarget.mock.calls.map(([{ targetId }]) => targetId)).toEqual(['new-tab'])
    expect(client.getTargets().map(target => target.targetId)).toEqual(['token-page', 'new-tab'])
  })

  it('uses targetInfoChanged to update attached metadata and attach a tab moved into the recording window', async () => {
    const tokenTitle = 'Browser Forge Recording · token-123'
    const { cdp, handlers, windowIds } = createCdpHarness({
      targetInfos: [{ targetId: 'token-page', type: 'page', title: tokenTitle, url: 'http://127.0.0.1/start' }],
      windowIds: { 'token-page': 41, 'moved-tab': 99 }
    })
    const client = new CdpClient({ port: 9222, cdp, expectedTargetTitle: tokenTitle })
    await client.connect()

    await handlers.targetCreated({ targetInfo: { targetId: 'moved-tab', type: 'page', title: 'Before', url: 'https://before.test' } })
    expect(client.getTargets().some(target => target.targetId === 'moved-tab')).toBe(false)

    windowIds['moved-tab'] = 41
    await handlers.targetInfoChanged({ targetInfo: { targetId: 'moved-tab', type: 'page', title: 'After', url: 'https://after.test' } })
    await handlers.targetInfoChanged({ targetInfo: { targetId: 'token-page', type: 'page', title: 'Updated title', url: 'https://recorded.test' } })

    expect(client.getTargets()).toEqual([
      expect.objectContaining({ targetId: 'token-page', title: 'Updated title', url: 'https://recorded.test' }),
      expect.objectContaining({ targetId: 'moved-tab', title: 'After', url: 'https://after.test' })
    ])
  })

  it('does not reattach the token target after it moves out of the anchored window', async () => {
    const tokenTitle = 'Browser Forge Recording · token-123'
    const { cdp, handlers, windowIds } = createCdpHarness({
      targetInfos: [{ targetId: 'token-page', type: 'page', title: tokenTitle, url: 'http://127.0.0.1/start' }],
      windowIds: { 'token-page': 41 }
    })
    const client = new CdpClient({ port: 9222, cdp, expectedTargetTitle: tokenTitle })
    await client.connect()

    windowIds['token-page'] = 99
    await handlers.targetInfoChanged({ targetInfo: { targetId: 'token-page', type: 'page', title: 'Moved once', url: 'https://moved.test/one' } })
    await handlers.targetInfoChanged({ targetInfo: { targetId: 'token-page', type: 'page', title: 'Moved twice', url: 'https://moved.test/two' } })

    expect(client._targets.has('token-page')).toBe(false)
    expect(client.getTargets()).toContainEqual(expect.objectContaining({
      targetId: 'token-page',
      detached: true
    }))
  })

  it('detaches a tracked tab when it moves out of the recording window', async () => {
    const tokenTitle = 'Browser Forge Recording · token-123'
    const { cdp, handlers, sessions, windowIds } = createCdpHarness({
      targetInfos: [
        { targetId: 'token-page', type: 'page', title: tokenTitle, url: 'http://127.0.0.1/start' },
        { targetId: 'moving-tab', type: 'page', title: 'Moving', url: 'https://moving.test' }
      ],
      windowIds: { 'token-page': 41, 'moving-tab': 41 }
    })
    const client = new CdpClient({ port: 9222, cdp, expectedTargetTitle: tokenTitle })
    await client.connect()

    windowIds['moving-tab'] = 99
    await handlers.targetInfoChanged({ targetInfo: { targetId: 'moving-tab', type: 'page', title: 'Moved', url: 'https://moved.test' } })

    expect(client._targets.has('moving-tab')).toBe(false)
    expect(sessions.get('session-moving-tab').close).toHaveBeenCalledOnce()
    expect(client.getTargets()).toContainEqual(expect.objectContaining({
      targetId: 'moving-tab',
      title: 'Moved',
      url: 'https://moved.test',
      detached: true
    }))
  })

  it('archives closed tabs with their latest metadata instead of dropping them', async () => {
    const tokenTitle = 'Browser Forge Recording · token-123'
    const { cdp, handlers, sessions } = createCdpHarness({
      targetInfos: [{ targetId: 'token-page', type: 'page', title: tokenTitle, url: 'http://127.0.0.1/start' }],
      windowIds: { 'token-page': 41 }
    })
    const client = new CdpClient({ port: 9222, cdp, expectedTargetTitle: tokenTitle })
    await client.connect()
    await handlers.targetInfoChanged({ targetInfo: { targetId: 'token-page', type: 'page', title: 'Final title', url: 'https://final.test' } })

    await handlers.targetDestroyed({ targetId: 'token-page' })

    expect(client._targets.has('token-page')).toBe(false)
    expect(sessions.get('session-token-page').close).toHaveBeenCalledOnce()
    expect(client.getTargets()).toEqual([
      expect.objectContaining({
        targetId: 'token-page',
        title: 'Final title',
        url: 'https://final.test',
        closed: true
      })
    ])
  })

  it('fails closed without attaching any target when the token target identity cannot be established', async () => {
    const { cdp, browser } = createCdpHarness({
      targetInfos: [{ targetId: 'unrelated', type: 'page', title: 'Unrelated', url: 'https://example.test' }],
      windowIds: { unrelated: 41 }
    })
    const client = new CdpClient({
      port: 9222,
      cdp,
      expectedTargetTitle: 'Browser Forge Recording · missing-token'
    })

    await expect(client.connect()).rejects.toMatchObject({ code: 'RECORDING_WINDOW_IDENTITY_FAILED' })
    expect(browser.Target.attachToTarget).not.toHaveBeenCalled()
    expect(client.getTargets()).toEqual([])
  })

  it('fails closed when Chrome cannot resolve the token target window id', async () => {
    const tokenTitle = 'Browser Forge Recording · token-123'
    const { cdp, browser } = createCdpHarness({
      targetInfos: [{ targetId: 'token-page', type: 'page', title: tokenTitle, url: 'http://127.0.0.1/start' }],
      windowIds: { 'token-page': new Error('window unavailable') }
    })
    const client = new CdpClient({ port: 9222, cdp, expectedTargetTitle: tokenTitle })

    await expect(client.connect()).rejects.toMatchObject({ code: 'RECORDING_WINDOW_IDENTITY_FAILED' })
    expect(browser.Target.attachToTarget).not.toHaveBeenCalled()
    expect(client.getTargets()).toEqual([])
  })

  it('does not finish attaching an initial target until its collectors are ready', async () => {
    let releaseCollectors
    const collectorsReady = new Promise(resolve => { releaseCollectors = resolve })
    const session = { close: vi.fn() }
    const cdp = vi.fn(async () => session)
    const client = new CdpClient({ port: 9222, cdp })
    client._browser = { Target: { attachToTarget: vi.fn(async () => ({ sessionId: 'session-1' })) } }
    client.onTargetAttached = vi.fn(async () => collectorsReady)
    let attached = false

    const attaching = client._attachTarget({ targetId: 'page-1', type: 'page' }).then(() => { attached = true })
    await Promise.resolve()
    expect(attached).toBe(false)

    releaseCollectors()
    await attaching
    expect(client.onTargetAttached).toHaveBeenCalledWith('page-1', session)
    expect(attached).toBe(true)
  })
})
