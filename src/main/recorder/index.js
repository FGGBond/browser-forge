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

export class RecordingSession {
  constructor({ port = 9222, outputDir }) {
    this.port = port
    this.outputDir = outputDir
    this._cdp = new CdpClient({ port })
    this._tabCollectors = new Map()
    this._timelineEvents = []
    this._startedAt = null
  }

  async start() {
    this._startedAt = Date.now()
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
    await session.Runtime.enable()
    await session.DOM.enable()

    // 注入点击监听：每次用户点击时通过 binding 回调触发截图
    await session.Runtime.addBinding({ name: 'bfClick' })
    await session.Page.addScriptToEvaluateOnNewDocument({
      source: `
        document.addEventListener('click', function(e) {
          try { window.bfClick(JSON.stringify({ x: e.clientX, y: e.clientY, selector: (e.target && e.target.tagName) || '' })) } catch(err) {}
        }, true)
      `
    })

    session.Runtime.bindingCalled(async ({ name, payload }) => {
      if (name !== 'bfClick') return
      const ts = Date.now()
      try {
        const info = JSON.parse(payload)
        collectors.events.addEvent({ type: 'click', timestamp: ts, x: info.x, y: info.y, selector: info.selector })
        this._timelineEvents.push({ timestamp: ts, type: 'click', targetId, x: info.x, y: info.y })
      } catch {}
      // 截图：点击后等 300ms 让 UI 响应完成
      setTimeout(async () => {
        try {
          const { data } = await session.Page.captureScreenshot({ format: 'png' })
          collectors.screenshots.addScreenshot({ timestamp: ts, dataBase64: data })
        } catch {}
      }, 300)
    })

    session.Network.requestWillBeSent(params => collectors.network.onRequestWillBeSent(params))
    session.Network.responseReceived(params => collectors.network.onResponseReceived(params))
    session.Network.loadingFinished(async ({ requestId }) => {
      collectors.network.onLoadingFinished({ requestId })
      try {
        const { body, base64Encoded } = await session.Network.getResponseBody({ requestId })
        collectors.network.setBody(requestId, body, base64Encoded)
      } catch {}
    })

    session.Page.frameNavigated(async ({ frame }) => {
      if (frame.parentId) return
      this._timelineEvents.push({ timestamp: Date.now(), type: 'navigation', targetId, url: frame.url })
      const targetEntry = this._cdp._targets.get(targetId)
      if (targetEntry) targetEntry.info = { ...targetEntry.info, url: frame.url }
      try {
        // 等页面 load 完成或最多 2.5 秒，取 DOM 快照 + 更新 title
        await Promise.race([
          new Promise(resolve => session.Page.loadEventFired(resolve)),
          new Promise(resolve => setTimeout(resolve, 2500))
        ])
        try {
          const { result } = await session.Runtime.evaluate({ expression: 'document.title', returnByValue: true })
          if (result.value && targetEntry) targetEntry.info = { ...targetEntry.info, title: result.value }
        } catch {}
        const { root } = await session.DOM.getDocument({ depth: -1 })
        const { outerHTML } = await session.DOM.getOuterHTML({ nodeId: root.nodeId })
        collectors.dom.addSnapshot({ timestamp: Date.now(), html: outerHTML, url: frame.url })
        // 导航完成也截一张，记录初始页面状态
        const { data } = await session.Page.captureScreenshot({ format: 'png' })
        collectors.screenshots.addScreenshot({ timestamp: Date.now(), dataBase64: data })
      } catch {}
    })

    session.Runtime.consoleAPICalled(({ type, args, timestamp, stackTrace }) => {
      collectors.console.addEntry({ type, args, timestamp, stackTrace })
    })
    session.Runtime.exceptionThrown(({ exceptionDetails, timestamp }) => {
      collectors.console.addEntry({ type: 'error', args: [exceptionDetails], timestamp, stackTrace: exceptionDetails.stackTrace })
    })
  }

  async stop() {
    const durationMs = Date.now() - this._startedAt
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

    const sessionName = `session-${formatDate(this._startedAt)}`
    const sessionDir = await writeSession({
      outputDir: this.outputDir,
      sessionName,
      metadata: {
        startedAt: new Date(this._startedAt).toISOString(),
        startUrl: targets[0]?.url ?? '',
        durationMs,
        chromeVersion: 'unknown',
        tabs: targets.map(t => ({ targetId: t.targetId, title: t.title, url: t.url }))
      },
      har,
      timeline,
      tabs
    })

    await this._cdp.disconnect()
    return sessionDir
  }
}

function formatDate(ts) {
  const d = new Date(ts)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}
