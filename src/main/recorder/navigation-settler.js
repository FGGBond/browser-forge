const IGNORED_NETWORK_TYPES = new Set(['WebSocket', 'EventSource', 'Media', 'Ping'])
const READY_LIFECYCLES = new Set(['DOMContentLoaded', 'load'])

export function isExternalHttpUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return !url.pathname.endsWith('/recording-start.html')
  } catch {
    return false
  }
}

export function isRelevantNetworkType(type) {
  return typeof type === 'string' && type.length > 0 && !IGNORED_NETWORK_TYPES.has(type)
}

export class NavigationSettler {
  constructor({
    networkQuietMs = 800,
    stableSampleCount = 3,
    deadlineMs = 10_000,
    minimumFallbackAgeMs = 1_500,
    onStable = null
  } = {}) {
    this.networkQuietMs = networkQuietMs
    this.stableSampleCount = stableSampleCount
    this.deadlineMs = deadlineMs
    this.minimumFallbackAgeMs = minimumFallbackAgeMs
    this.onStable = onStable
    this._navigation = null
    this._requests = new Map()
    this._emitted = false
  }

  beginNavigation({ url, loaderId, timestamp, videoOffsetMs }) {
    if (this._emitted || !isExternalHttpUrl(url) || !loaderId) return false
    this._navigation = {
      url,
      loaderId,
      timestamp,
      videoOffsetMs,
      readyAt: null,
      loadAt: null,
      lastNetworkActivityAt: timestamp,
      stableRun: [],
      validSamples: []
    }
    this._requests.clear()
    return true
  }

  onLifecycle({ loaderId, name, timestamp }) {
    const navigation = this._matchingNavigation(loaderId)
    if (!navigation || !READY_LIFECYCLES.has(name)) return false
    navigation.readyAt ??= timestamp
    if (name === 'load') navigation.loadAt ??= timestamp
    return true
  }

  onRequestStarted({ requestId, loaderId, type, timestamp }) {
    const navigation = this._matchingNavigation(loaderId)
    if (!navigation || !requestId || !isRelevantNetworkType(type)) return false
    this._requests.set(requestId, { loaderId, type })
    navigation.lastNetworkActivityAt = timestamp
    navigation.stableRun = []
    return true
  }

  onRequestFinished({ requestId, timestamp }) {
    const request = this._requests.get(requestId)
    if (!request) return false
    this._requests.delete(requestId)
    const navigation = this._matchingNavigation(request.loaderId)
    if (!navigation) return false
    navigation.lastNetworkActivityAt = timestamp
    navigation.stableRun = []
    return true
  }

  addVisualSample({ loaderId, timestamp, videoOffsetMs, signature }) {
    const navigation = this._matchingNavigation(loaderId)
    if (!navigation || this._emitted || !signature || !Number.isFinite(videoOffsetMs)) return null

    const sample = { timestamp, videoOffsetMs, signature }
    if (navigation.readyAt !== null && timestamp >= navigation.readyAt) {
      navigation.validSamples.push(sample)
    }

    const quietAt = navigation.lastNetworkActivityAt + this.networkQuietMs
    const hasInflightRequests = [...this._requests.values()].some(request => request.loaderId === loaderId)
    const highConfidenceReady = navigation.loadAt !== null && timestamp >= quietAt && !hasInflightRequests

    if (highConfidenceReady) {
      const previous = navigation.stableRun.at(-1)
      if (!previous || previous.signature === signature) {
        navigation.stableRun.push(sample)
      } else {
        navigation.stableRun = [sample]
      }
      if (navigation.stableRun.length >= this.stableSampleCount) {
        return this._emit(navigation.stableRun[0], {
          reason: 'load+network-quiet+visual-stable',
          confidence: 'high'
        })
      }
    }

    if (timestamp >= navigation.timestamp + this.deadlineMs) {
      const firstValid = navigation.validSamples.find(candidate => (
        candidate.timestamp >= navigation.timestamp + this.minimumFallbackAgeMs
      ))
      if (firstValid) {
        return this._emit(firstValid, {
          reason: 'deadline+first-valid-visual',
          confidence: 'low'
        })
      }
    }

    return null
  }

  _matchingNavigation(loaderId) {
    if (!this._navigation || this._navigation.loaderId !== loaderId) return null
    return this._navigation
  }

  _emit(sample, { reason, confidence }) {
    if (this._emitted || !this._navigation) return null
    this._emitted = true
    const event = {
      type: 'navigation-stable',
      url: this._navigation.url,
      loaderId: this._navigation.loaderId,
      timestamp: sample.timestamp,
      videoOffsetMs: sample.videoOffsetMs,
      reason,
      confidence
    }
    this.onStable?.(event)
    return event
  }
}
