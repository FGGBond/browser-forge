// src/main/recorder/index.js
import { CdpClient } from './cdp-client.js'
import { NetworkCollector } from './collectors/network.js'
import { DomCollector } from './collectors/dom.js'
import { ScreenshotsCollector } from './collectors/screenshots.js'
import { ScriptsCollector } from './collectors/scripts.js'
import { EventsCollector } from './collectors/events.js'
import { ConsoleCollector } from './collectors/console.js'
import { buildHar } from './har-builder.js'
import { buildTimeline } from './timeline-builder.js'
import { writeSession } from './output-writer.js'
import { addVideoOffset } from './video-manifest.js'
import { NavigationSettler } from './navigation-settler.js'
import { createHash, randomUUID } from 'node:crypto'

export class RecordingSession {
  constructor({ port = 9222, outputDir, sessionDir = null, video = null }) {
    this.port = port
    this.outputDir = outputDir
    this.sessionDir = sessionDir
    this.video = video
    this._cdp = new CdpClient({
      port,
      expectedTargetTitle: video?.window?.requestedTitle ?? video?.window?.title ?? null
    })
    this._tabCollectors = new Map()
    this._timelineEvents = []
    this._startedAt = null
    this._lastActiveTargetId = null
    this._navigationSettling = new Map()
    this._stableNavigationEmitted = false
    this._stopping = false
  }

  async start() {
    this._startedAt = this.video?.startEpochMs ?? Date.now()
    this._cdp.onTargetAttached = (targetId, session) => this._setupTabCollectors(targetId, session)
    await this._cdp.connect()
  }

  async _setupTabCollectors(targetId, session) {
    const collectors = {
      network: new NetworkCollector({ targetId, maxBodyBytes: 10_000_000 }),
      dom: new DomCollector({ targetId }),
      screenshots: new ScreenshotsCollector({ targetId }),
      scripts: new ScriptsCollector({ targetId }),
      events: new EventsCollector({ targetId }),
      console: new ConsoleCollector({ targetId })
    }
    this._tabCollectors.set(targetId, collectors)

    await session.Network.enable()
    await session.Page.enable()
    await session.Page.setLifecycleEventsEnabled({ enabled: true })
    await session.Runtime.enable()
    await session.DOM.enable()

    const settling = this._createNavigationSettlingState({ targetId, session, collectors })
    this._navigationSettling.set(targetId, settling)
    this._wrapSessionClose(settling)

    // 注入用户操作监听：点击和 Enter 都通过 binding 回调触发截图
    await session.Runtime.addBinding({ name: 'bfClick' })
    await session.Runtime.addBinding({ name: 'bfKey' })
    await session.Page.addScriptToEvaluateOnNewDocument({
      source: `
        document.addEventListener('pointerdown', function(e) {
          if (e.button !== 0) return
          try { window.bfClick(JSON.stringify({ x: e.clientX, y: e.clientY, selector: (e.target && e.target.tagName) || '' })) } catch(err) {}
        }, true)
        document.addEventListener('keydown', function(e) {
          if (e.key !== 'Enter' || e.repeat || e.isComposing) return
          try { window.bfKey(JSON.stringify({ key: e.key, selector: (e.target && e.target.tagName) || '' })) } catch(err) {}
        }, true)
      `
    })

    const bindingCalled = async ({ name, payload }) => {
      if (name !== 'bfClick' && name !== 'bfKey') return
      const ts = Date.now()
      this._lastActiveTargetId = targetId
      try {
        const info = JSON.parse(payload)
        if (name === 'bfClick') {
          collectors.events.addEvent({ type: 'click', timestamp: ts, x: info.x, y: info.y, selector: info.selector })
          this._addTimelineEvent({ timestamp: ts, type: 'click', targetId, x: info.x, y: info.y })
        } else {
          collectors.events.addEvent({ type: 'keydown', timestamp: ts, key: info.key, selector: info.selector })
          this._addTimelineEvent({ timestamp: ts, type: 'keydown', targetId, key: info.key })
        }
      } catch {}
      if (name === 'bfClick') {
        await this._captureScreenshot({ session, collectors, timestamp: ts })
        return
      }
      // Enter：保留轻微延迟，等待键盘触发的提交/导航先进入稳定状态
      this._scheduleScreenshot({ session, collectors, settling, timestamp: ts })
    }
    this._listen(settling, session, 'Runtime.bindingCalled', session.Runtime.bindingCalled, bindingCalled)

    const requestWillBeSent = params => {
      collectors.network.onRequestWillBeSent(params)
      settling.settler.onRequestStarted({
        requestId: params.requestId,
        loaderId: params.loaderId,
        type: params.type,
        timestamp: Date.now()
      })
    }
    const responseReceived = params => collectors.network.onResponseReceived(params)
    const loadingFinished = async ({ requestId }) => {
      const timestamp = Date.now()
      collectors.network.onLoadingFinished({ requestId, timestamp })
      settling.settler.onRequestFinished({ requestId, timestamp })
      try {
        const { body, base64Encoded } = await session.Network.getResponseBody({ requestId })
        collectors.network.setBody(requestId, body, base64Encoded)
      } catch {}
    }
    const loadingFailed = ({ requestId, errorText, canceled, blockedReason }) => {
      const timestamp = Date.now()
      collectors.network.onLoadingFailed({ requestId, errorText, canceled, blockedReason, timestamp })
      settling.settler.onRequestFinished({ requestId, timestamp })
    }
    const frameNavigated = async ({ frame }) => {
      if (frame.parentId) return
      const timestamp = Date.now()
      this._addTimelineEvent({ timestamp, type: 'navigation', targetId, url: frame.url, loaderId: frame.loaderId })
      const targetEntry = this._cdp._targets.get(targetId)
      if (targetEntry) targetEntry.info = { ...targetEntry.info, url: frame.url }
      this._beginNavigationSettling({ settling, frame, timestamp })
    }
    const lifecycleEvent = params => {
      if (params.frameId !== settling.frameId) return
      const timestamp = Date.now()
      settling.settler.onLifecycle({ loaderId: params.loaderId, name: params.name, timestamp })
      if (params.name === 'load' && params.loaderId === settling.loaderId) {
        this._captureNavigationArtifacts({ session, collectors, targetId, settling }).catch(() => {})
      }
    }

    this._listen(settling, session, 'Network.requestWillBeSent', session.Network.requestWillBeSent, requestWillBeSent)
    this._listen(settling, session, 'Network.responseReceived', session.Network.responseReceived, responseReceived)
    this._listen(settling, session, 'Network.loadingFinished', session.Network.loadingFinished, loadingFinished)
    this._listen(settling, session, 'Network.loadingFailed', session.Network.loadingFailed, loadingFailed)
    this._listen(settling, session, 'Page.frameNavigated', session.Page.frameNavigated, frameNavigated)
    this._listen(settling, session, 'Page.lifecycleEvent', session.Page.lifecycleEvent, lifecycleEvent)

    if (typeof session.once === 'function') {
      const onDisconnect = () => this._cleanupNavigationSettling(targetId)
      session.once('disconnect', onDisconnect)
      settling.cleanups.push(() => session.removeListener?.('disconnect', onDisconnect))
    }

    await this._recoverCurrentNavigation({ settling, session })

    const consoleAPICalled = ({ type, args, timestamp, stackTrace }) => {
      collectors.console.addEntry({ type, args, timestamp, stackTrace })
    }
    const exceptionThrown = ({ exceptionDetails, timestamp }) => {
      collectors.console.addEntry({ type: 'error', args: [exceptionDetails], timestamp, stackTrace: exceptionDetails.stackTrace })
    }
    this._listen(settling, session, 'Runtime.consoleAPICalled', session.Runtime.consoleAPICalled, consoleAPICalled)
    this._listen(settling, session, 'Runtime.exceptionThrown', session.Runtime.exceptionThrown, exceptionThrown)
  }


  _createNavigationSettlingState({ targetId, session, collectors }) {
    const state = {
      targetId,
      session,
      collectors,
      frameId: null,
      loaderId: null,
      url: '',
      generation: 0,
      timer: null,
      active: true,
      capturedLoaders: new Set(),
      pendingTimers: new Set(),
      cleanups: []
    }
    state.settler = new NavigationSettler({
      networkQuietMs: 800,
      stableSampleCount: 3,
      deadlineMs: 10_000,
      onStable: event => {
        if (this._stopping || this._stableNavigationEmitted || !state.active) return
        this._stableNavigationEmitted = true
        this._addTimelineEvent({ ...event, targetId })
        for (const other of this._navigationSettling.values()) {
          if (other.timer) clearTimeout(other.timer)
          other.timer = null
        }
      }
    })
    return state
  }

  _listen(state, session, eventName, subscribe, handler) {
    const unsubscribe = subscribe(handler)
    state.cleanups.push(typeof unsubscribe === 'function'
      ? unsubscribe
      : () => session.removeListener?.(eventName, handler))
  }

  _wrapSessionClose(state) {
    const { session, targetId } = state
    if (typeof session.close !== 'function') return
    const originalClose = session.close.bind(session)
    const wrappedClose = async (...args) => {
      this._cleanupNavigationSettling(targetId)
      return originalClose(...args)
    }
    session.close = wrappedClose
    state.cleanups.push(() => {
      if (session.close === wrappedClose) session.close = originalClose
    })
  }

  _beginNavigationSettling({ settling, frame, timestamp = Date.now(), readyState = null }) {
    if (this._stopping || this._stableNavigationEmitted || !settling.active) return false
    const began = settling.settler.beginNavigation({
      url: frame.url,
      loaderId: frame.loaderId,
      timestamp,
      videoOffsetMs: this._videoOffset(timestamp)
    })
    if (!began) return false
    settling.frameId = frame.id
    settling.loaderId = frame.loaderId
    settling.url = frame.url
    settling.generation += 1
    if (settling.timer) clearTimeout(settling.timer)
    settling.timer = null
    if (readyState === 'complete') {
      settling.settler.onLifecycle({ loaderId: frame.loaderId, name: 'load', timestamp })
    } else if (readyState === 'interactive') {
      settling.settler.onLifecycle({ loaderId: frame.loaderId, name: 'DOMContentLoaded', timestamp })
    }
    this._scheduleNavigationSample(settling, 0, settling.generation)
    return true
  }

  async _recoverCurrentNavigation({ settling, session }) {
    try {
      const [{ frameTree }, evaluated] = await Promise.all([
        session.Page.getFrameTree(),
        session.Runtime.evaluate({
          expression: '({ readyState: document.readyState, url: location.href })',
          returnByValue: true
        })
      ])
      const frame = frameTree?.frame
      if (!frame) return false
      const current = evaluated?.result?.value ?? {}
      return this._beginNavigationSettling({
        settling,
        frame: { ...frame, url: current.url || frame.url },
        timestamp: Date.now(),
        readyState: current.readyState
      })
    } catch {
      return false
    }
  }

  _scheduleNavigationSample(settling, delayMs, generation) {
    if (this._stopping || this._stableNavigationEmitted || !settling.active || generation !== settling.generation) return
    settling.timer = setTimeout(async () => {
      settling.timer = null
      if (this._stopping || this._stableNavigationEmitted || !settling.active || generation !== settling.generation) return
      await this._sampleNavigationViewport(settling, generation)
      if (this._stopping || this._stableNavigationEmitted || !settling.active || generation !== settling.generation) return
      const navigation = settling.settler._navigation
      if (!navigation || Date.now() > navigation.timestamp + settling.settler.deadlineMs + 500) return
      this._scheduleNavigationSample(settling, 250, generation)
    }, delayMs)
  }

  async _sampleNavigationViewport(settling, generation) {
    try {
      const [{ data }, layout] = await Promise.all([
        settling.session.Page.captureScreenshot({ format: 'png', fromSurface: true }),
        settling.session.Runtime.evaluate({
          expression: `(() => {
            const root = document.documentElement
            const body = document.body
            return JSON.stringify({
              url: location.href,
              title: document.title,
              readyState: document.readyState,
              root: root ? [root.scrollWidth, root.scrollHeight, root.clientWidth, root.clientHeight, root.childElementCount] : null,
              body: body ? [body.scrollWidth, body.scrollHeight, body.childElementCount, (body.innerText || '').length] : null
            })
          })()`,
          returnByValue: true
        })
      ])
      if (generation !== settling.generation || this._stopping || !settling.active) return null
      const timestamp = Date.now()
      const signature = createHash('sha256')
        .update(String(data || ''))
        .update('\0')
        .update(String(layout?.result?.value ?? ''))
        .digest('hex')
      return settling.settler.addVisualSample({
        loaderId: settling.loaderId,
        timestamp,
        videoOffsetMs: this._videoOffset(timestamp),
        signature
      })
    } catch {
      return null
    }
  }

  async _captureNavigationArtifacts({ session, collectors, targetId, settling }) {
    if (this._stopping || !settling.loaderId || settling.capturedLoaders.has(settling.loaderId)) return
    settling.capturedLoaders.add(settling.loaderId)
    const targetEntry = this._cdp._targets.get(targetId)
    try {
      const { result } = await session.Runtime.evaluate({ expression: 'document.title', returnByValue: true })
      if (result?.value && targetEntry) targetEntry.info = { ...targetEntry.info, title: result.value }
    } catch {}
    try {
      const { root } = await session.DOM.getDocument({ depth: -1 })
      const { outerHTML } = await session.DOM.getOuterHTML({ nodeId: root.nodeId })
      collectors.dom.addSnapshot({ timestamp: Date.now(), html: outerHTML, url: settling.url })
    } catch {}
    await this._captureScreenshot({ session, collectors })
  }

  _videoOffset(timestamp) {
    if (!Number.isFinite(this.video?.startEpochMs)) return Math.max(0, Math.round(timestamp - (this._startedAt ?? timestamp)))
    return Math.max(0, Math.round(timestamp - this.video.startEpochMs))
  }

  _cleanupNavigationSettling(targetId) {
    const settling = this._navigationSettling.get(targetId)
    if (!settling) return
    settling.active = false
    if (settling.timer) clearTimeout(settling.timer)
    settling.timer = null
    for (const timer of settling.pendingTimers) clearTimeout(timer)
    settling.pendingTimers.clear()
    for (const cleanup of settling.cleanups.splice(0)) {
      try { cleanup() } catch {}
    }
    this._navigationSettling.delete(targetId)
  }

  _cleanupAllNavigationSettling() {
    for (const targetId of [...this._navigationSettling.keys()]) {
      this._cleanupNavigationSettling(targetId)
    }
  }

  _scheduleScreenshot({ session, collectors, settling, timestamp }) {
    const timer = setTimeout(() => {
      settling?.pendingTimers.delete(timer)
      if (this._stopping || settling?.active === false) return
      this._captureScreenshot({ session, collectors, timestamp })
    }, 300)
    settling?.pendingTimers.add(timer)
  }

  async _captureScreenshot({ session, collectors, timestamp = Date.now() }) {
    try {
      const { data } = await session.Page.captureScreenshot({ format: 'png' })
      collectors.screenshots.addScreenshot({ timestamp, dataBase64: data })
      return true
    } catch {
      return false
    }
  }

  getLiveSummary() {
    const targets = this._cdp.getTargets()
    const tabs = targets.map(target => {
      const collectors = this._tabCollectors.get(target.targetId)
      if (!collectors) {
        return {
          targetId: target.targetId,
          title: target.title,
          url: target.url,
          counts: { events: 0, network: 0, console: 0, artifacts: 0 },
          artifacts: { screenshots: [] },
          recent: { events: [], network: [], console: [], artifacts: [] }
        }
      }

      const events = collectors.events.getEvents()
      const network = collectors.network.getEntries()
      const consoleEntries = collectors.console.getEntries()
      const domSnapshots = collectors.dom.getSnapshots()
      const screenshots = collectors.screenshots.getScreenshots()
      const scripts = collectors.scripts.getScripts()

      return {
        targetId: target.targetId,
        title: target.title,
        url: target.url,
        counts: {
          events: events.length,
          network: network.length,
          console: consoleEntries.length,
          artifacts: domSnapshots.length + screenshots.length + scripts.length
        },
        artifacts: {
          screenshots: summarizeScreenshotArtifacts({ targetId: target.targetId, screenshots })
        },
        recent: {
          events: events.slice(-8).reverse().map(summarizeEvent),
          network: network.slice(-8).reverse().map(summarizeNetworkEntry),
          console: consoleEntries.slice(-8).reverse().map(summarizeConsoleEntry),
          artifacts: summarizeArtifacts({ targetId: target.targetId, domSnapshots, screenshots, scripts }).slice(0, 8)
        }
      }
    })

    const totals = tabs.reduce((acc, tab) => {
      acc.events += tab.counts.events
      acc.network += tab.counts.network
      acc.console += tab.counts.console
      acc.artifacts += tab.counts.artifacts
      return acc
    }, { events: 0, network: 0, console: 0, artifacts: 0 })

    return {
      type: 'summary',
      startedAt: this._startedAt,
      updatedAt: Date.now(),
      tabs,
      totals
    }
  }

  prepareForVideoStop() {
    this._stopping = true
    this._cleanupAllNavigationSettling()
  }

  async stop({ video = this.video } = {}) {
    this.prepareForVideoStop()
    const durationMs = Math.max(0, Date.now() - this._startedAt)
    await this._captureActiveTabScreenshot()
    const targets = this._cdp.getTargets()

    const tabs = {}
    for (const [targetId, c] of this._tabCollectors.entries()) {
      tabs[targetId] = {
        title: targets.find(t => t.targetId === targetId)?.title ?? 'untitled',
        events: c.events.getEvents(),
        domSnapshots: c.dom.getSnapshots(),
        screenshots: c.screenshots.getScreenshots(),
        scripts: c.scripts.getScripts(),
        console: c.console.getEntries()
      }
    }

    const allNetworkEntries = Array.from(this._tabCollectors.values())
      .flatMap(c => c.network.getEntries())

    const har = buildHar({
      entries: allNetworkEntries,
      pages: [],
      startedDateTime: new Date(this._startedAt).toISOString()
    })

    const timeline = buildTimeline(this._timelineEvents)

    const sessionName = this.sessionDir ? null : `session-${formatDate(this._startedAt)}-${randomUUID()}`
    const outputTarget = this.sessionDir ? { sessionDir: this.sessionDir } : { outputDir: this.outputDir, sessionName }
    const sessionDir = await this._writeSession({
      ...outputTarget,
      metadata: {
        startedAt: new Date(this._startedAt).toISOString(),
        startUrl: targets[0]?.url ?? '',
        durationMs,
        chromeVersion: 'unknown',
        tabs: targets.map(t => ({ targetId: t.targetId, title: t.title, url: t.url })),
        video: video ? {
          state: video.state ?? 'complete',
          startEpochMs: video.startEpochMs ?? this.video?.startEpochMs ?? null,
          durationMs: video.durationMs ?? durationMs
        } : null
      },
      har,
      timeline,
      tabs,
      video: video ? { ...video, startEpochMs: video.startEpochMs ?? this.video?.startEpochMs } : null
    })

    await this._cdp.disconnect()
    return sessionDir
  }

  async _captureActiveTabScreenshot() {
    const targetId = await this._findVisibleTargetId() ?? this._lastActiveTargetId
    if (!targetId) return false

    const collectors = this._tabCollectors.get(targetId)
    const session = this._cdp._targets?.get(targetId)?.session
    if (!collectors || !session) return false

    return this._captureScreenshot({ session, collectors })
  }

  async _findVisibleTargetId() {
    const targets = this._cdp.getTargets()
    for (const target of targets) {
      const session = this._cdp._targets?.get(target.targetId)?.session
      if (!session) continue
      try {
        const { result } = await session.Runtime.evaluate({
          expression: 'document.visibilityState',
          returnByValue: true
        })
        if (result?.value === 'visible') return target.targetId
      } catch {}
    }
    return null
  }

  _addTimelineEvent(event) {
    const correlated = addVideoOffset(event, this.video?.startEpochMs)
    this._timelineEvents.push(correlated)
    return correlated
  }

  _writeSession(data) {
    return writeSession(data)
  }

  getScreenshot(targetId, timestamp) {
    const collectors = this._tabCollectors.get(targetId)
    const screenshot = collectors?.screenshots.getScreenshots()
      .find(item => String(item.timestamp) === String(timestamp))
    if (!screenshot?.dataBase64) return null
    return Buffer.from(screenshot.dataBase64, 'base64')
  }
}

function formatDate(ts) {
  const d = new Date(ts)
  const pad = n => String(n).padStart(2, '0')
  const milliseconds = String(d.getMilliseconds()).padStart(3, '0')
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${milliseconds}`
}

function summarizeEvent(event) {
  return {
    time: event.timestamp,
    kind: event.type ?? 'event',
    title: event.selector ? `${event.type} ${event.selector}` : event.type ?? 'event',
    detail: event.url ?? formatPoint(event)
  }
}

function summarizeNetworkEntry(entry) {
  return {
    time: entry.responseTimestamp ?? entry.startedTimestamp,
    kind: entry.request?.method ?? 'GET',
    title: entry.request?.url ?? entry.response?.url ?? 'request',
    detail: entry.response ? `${entry.response.status} ${entry.response.mimeType ?? ''}`.trim() : 'pending'
  }
}

function summarizeConsoleEntry(entry) {
  return {
    time: entry.timestamp,
    kind: entry.type ?? 'log',
    title: stringifyConsoleArgs(entry.args),
    detail: entry.stackTrace?.callFrames?.[0]?.url ?? ''
  }
}

function summarizeScreenshotArtifacts({ targetId, screenshots }) {
  return screenshots.map(item => ({
    timestamp: item.timestamp,
    kind: 'Screenshot',
    title: `screenshot-${item.timestamp}.png`,
    thumbnailUrl: `/api/screenshots/${encodeURIComponent(targetId)}/${encodeURIComponent(item.timestamp)}.png`
  }))
}

function summarizeArtifacts({ targetId, domSnapshots, screenshots, scripts }) {
  return [
    ...domSnapshots.map(item => ({
      time: item.timestamp,
      kind: 'DOM',
      title: item.url ?? 'DOM snapshot',
      detail: 'snapshot'
    })),
    ...summarizeScreenshotArtifacts({ targetId, screenshots }).map(item => ({
      time: item.timestamp,
      kind: item.kind,
      title: item.title,
      detail: 'image',
      thumbnailUrl: item.thumbnailUrl
    })),
    ...scripts.map(item => ({
      time: null,
      kind: 'Script',
      title: item.url ?? item.hash,
      detail: item.hash
    }))
  ].sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
}

function formatPoint(event) {
  if (typeof event.x !== 'number' || typeof event.y !== 'number') return ''
  return `${Math.round(event.x)}, ${Math.round(event.y)}`
}

function stringifyConsoleArgs(args = []) {
  return args.map(arg => {
    if (typeof arg === 'string') return arg
    if (arg?.value !== undefined) return String(arg.value)
    if (arg?.description) return arg.description
    try { return JSON.stringify(arg) } catch { return String(arg) }
  }).join(' ')
}
