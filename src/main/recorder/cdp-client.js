import CDP from 'chrome-remote-interface'

export class CdpClient {
  constructor({ port = 9222 } = {}) {
    this.port = port
    this._targets = new Map()
    this._browser = null
  }

  getTargets() {
    return Array.from(this._targets.values()).map(t => t.info)
  }

  async connect() {
    // Connect to browser endpoint (not a tab), so it works even with no open pages
    const { webSocketDebuggerUrl } = await CDP.Version({ port: this.port })
    this._browser = await CDP({ target: webSocketDebuggerUrl })
    await this._browser.Target.setDiscoverTargets({ discover: true })

    this._browser.Target.targetCreated(({ targetInfo }) => {
      if (targetInfo.type === 'page') this._attachTarget(targetInfo)
    })

    this._browser.Target.targetDestroyed(({ targetId }) => {
      this._targets.delete(targetId)
    })

    const { targetInfos } = await this._browser.Target.getTargets()
    for (const info of targetInfos.filter(t => t.type === 'page')) {
      await this._attachTarget(info)
    }
  }

  async _attachTarget(targetInfo) {
    const { sessionId } = await this._browser.Target.attachToTarget({
      targetId: targetInfo.targetId,
      flatten: true
    })
    const session = await CDP({ port: this.port, sessionId })
    this._targets.set(targetInfo.targetId, { session, info: targetInfo })
    this.onTargetAttached?.(targetInfo.targetId, session)
  }

  async disconnect() {
    for (const { session } of this._targets.values()) {
      await session.close().catch(() => {})
    }
    await this._browser?.close().catch(() => {})
    this._targets.clear()
  }
}
