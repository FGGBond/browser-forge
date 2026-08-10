import CDP from 'chrome-remote-interface'

const IDENTITY_ERROR_CODE = 'RECORDING_WINDOW_IDENTITY_FAILED'

export class CdpClient {
  constructor({ port = 9222, cdp = CDP, expectedTargetTitle = null } = {}) {
    this.port = port
    this.expectedTargetTitle = expectedTargetTitle
    this.windowId = null
    this._anchorTargetId = null
    this._cdp = cdp
    this._targets = new Map()
    this._targetHistory = new Map()
    this._attachingTargets = new Map()
    this._pendingTargetInfos = new Map()
    this._browser = null
  }

  getTargets() {
    return Array.from(this._targetHistory.values()).map(info => ({ ...info }))
  }

  async connect() {
    try {
      // Connect to browser endpoint (not a tab), so it works even with no open pages.
      const { webSocketDebuggerUrl } = await this._cdp.Version({ port: this.port })
      this._browser = await this._cdp({ target: webSocketDebuggerUrl })
      await this._browser.Target.setDiscoverTargets({ discover: true })

      this._browser.Target.targetCreated(({ targetInfo }) => {
        return this._handleTargetInfo(targetInfo).catch(() => {})
      })
      this._browser.Target.targetInfoChanged(({ targetInfo }) => {
        return this._handleTargetInfoChanged(targetInfo).catch(() => {})
      })
      this._browser.Target.targetDestroyed(({ targetId }) => {
        return this._archiveTarget(targetId, { closed: true }).catch(() => {})
      })

      const { targetInfos } = await this._browser.Target.getTargets()
      const pageTargets = targetInfos.filter(target => target.type === 'page')
      if (this.expectedTargetTitle) {
        await this._establishWindowIdentity(pageTargets)
      }

      for (const info of pageTargets) {
        await this._considerTarget(info, {
          knownWindowId: info.targetId === this._anchorTargetId ? this.windowId : null
        })
      }
      for (const info of this._pendingTargetInfos.values()) {
        await this._considerTarget(info)
      }
      this._pendingTargetInfos.clear()
    } catch (error) {
      await this.disconnect()
      throw error
    }
  }

  async _establishWindowIdentity(targetInfos) {
    const matches = targetInfos.filter(target => target.title === this.expectedTargetTitle)
    if (matches.length !== 1) {
      throw identityError(`Expected exactly one token target, found ${matches.length}`)
    }

    try {
      this._anchorTargetId = matches[0].targetId
      this.windowId = await this._getWindowId(this._anchorTargetId)
    } catch (error) {
      throw identityError(`Could not resolve token target window: ${error.message}`)
    }
  }

  async _getWindowId(targetId) {
    const result = await this._browser.Browser.getWindowForTarget({ targetId })
    if (!Number.isInteger(result?.windowId)) {
      throw new Error('Chrome returned an invalid window id')
    }
    return result.windowId
  }

  async _handleTargetInfo(targetInfo) {
    if (targetInfo?.type !== 'page') return
    if (this.expectedTargetTitle && !Number.isInteger(this.windowId)) {
      this._pendingTargetInfos.set(targetInfo.targetId, targetInfo)
      return
    }
    await this._considerTarget(targetInfo)
  }

  async _handleTargetInfoChanged(targetInfo) {
    if (targetInfo?.type !== 'page') return
    const targetId = targetInfo.targetId
    const current = this._targets.get(targetId)

    if (!current) {
      await this._handleTargetInfo(targetInfo)
      return
    }

    this._setTargetInfo(targetInfo)
    if (!this.expectedTargetTitle) return

    try {
      const targetWindowId = await this._getWindowId(targetId)
      if (targetWindowId !== this.windowId) {
        await this._archiveTarget(targetId, { detached: true })
      }
    } catch {
      // If Chrome can no longer prove the target belongs to the recording
      // window, stop collecting it rather than risking cross-window data.
      await this._archiveTarget(targetId, { detached: true })
    }
  }

  async _considerTarget(targetInfo, { knownWindowId = null } = {}) {
    if (targetInfo?.type !== 'page') return false
    if (this._targets.has(targetInfo.targetId)) {
      this._setTargetInfo(targetInfo)
      return true
    }

    if (this.expectedTargetTitle) {
      if (!Number.isInteger(this.windowId)) return false
      let targetWindowId = knownWindowId
      if (!Number.isInteger(targetWindowId)) {
        try {
          targetWindowId = await this._getWindowId(targetInfo.targetId)
        } catch {
          return false
        }
      }
      if (targetWindowId !== this.windowId) return false
    }

    await this._attachTarget(targetInfo)
    return true
  }

  async _attachTarget(targetInfo) {
    const targetId = targetInfo.targetId
    if (this._targets.has(targetId)) {
      this._setTargetInfo(targetInfo)
      return this._targets.get(targetId).session
    }
    if (this._attachingTargets.has(targetId)) {
      return this._attachingTargets.get(targetId)
    }

    const attaching = this._attachTargetNow(targetInfo)
    this._attachingTargets.set(targetId, attaching)
    try {
      return await attaching
    } finally {
      this._attachingTargets.delete(targetId)
    }
  }

  async _attachTargetNow(targetInfo) {
    const { sessionId } = await this._browser.Target.attachToTarget({
      targetId: targetInfo.targetId,
      flatten: true
    })
    const session = await this._cdp({ port: this.port, sessionId })
    this._targets.set(targetInfo.targetId, { session, info: cleanTargetState(targetInfo) })
    this._setTargetInfo(targetInfo)
    try {
      await this.onTargetAttached?.(targetInfo.targetId, session)
      return session
    } catch (error) {
      this._targets.delete(targetInfo.targetId)
      this._targetHistory.delete(targetInfo.targetId)
      try { await session.close() } catch {}
      throw error
    }
  }

  _setTargetInfo(targetInfo) {
    const targetId = targetInfo.targetId
    const currentEntry = this._targets.get(targetId)
    const previous = currentEntry?.info ?? this._targetHistory.get(targetId) ?? {}
    const next = cleanTargetState({ ...previous, ...targetInfo })
    if (currentEntry) currentEntry.info = next
    this._targetHistory.set(targetId, next)
  }

  async _archiveTarget(targetId, state) {
    const entry = this._targets.get(targetId)
    const previous = entry?.info ?? this._targetHistory.get(targetId)
    if (!previous) return

    this._targets.delete(targetId)
    if (entry?.session) {
      try { await entry.session.close() } catch {}
    }
    this._targetHistory.set(targetId, { ...cleanTargetState(previous), ...state })
  }

  async disconnect() {
    for (const { session } of this._targets.values()) {
      try { await session.close() } catch {}
    }
    if (this._browser) {
      try { await this._browser.close() } catch {}
    }
    this._targets.clear()
    this._targetHistory.clear()
    this._attachingTargets.clear()
    this._pendingTargetInfos.clear()
    this._browser = null
    this.windowId = null
    this._anchorTargetId = null
  }
}

function cleanTargetState(targetInfo) {
  const { closed, detached, ...info } = targetInfo
  return info
}

function identityError(message) {
  return Object.assign(new Error(message), { code: IDENTITY_ERROR_CODE })
}
