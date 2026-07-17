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
      try {
        const { root } = await session.DOM.getDocument({ depth: -1 })
        const { outerHTML } = await session.DOM.getOuterHTML({ nodeId: root.nodeId })
        collectors.dom.addSnapshot({ timestamp: Date.now(), html: outerHTML, url: frame.url })
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
  return new Date(ts).toISOString().replace('T', '-').replace(/:/g, '').slice(0, 15)
}
