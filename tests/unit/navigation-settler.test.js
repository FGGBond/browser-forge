import { describe, expect, it, vi } from 'vitest'
import { NavigationSettler, isExternalHttpUrl, isRelevantNetworkType } from '../../src/main/recorder/navigation-settler.js'

function createSettler(options = {}) {
  return new NavigationSettler({
    networkQuietMs: 800,
    stableSampleCount: 3,
    deadlineMs: 10_000,
    minimumFallbackAgeMs: 1_500,
    ...options
  })
}

describe('NavigationSettler', () => {
  it('accepts only real HTTP(S) pages as poster candidates', () => {
    expect(isExternalHttpUrl('https://example.com/orders')).toBe(true)
    expect(isExternalHttpUrl('http://example.test/')).toBe(true)
    expect(isExternalHttpUrl('http://127.0.0.1:43123/recording-start.html')).toBe(false)
    expect(isExternalHttpUrl('chrome://newtab/')).toBe(false)
    expect(isExternalHttpUrl('file:///tmp/start.html')).toBe(false)
  })

  it('ignores persistent transport types when deciding network quiet', () => {
    expect(isRelevantNetworkType('Document')).toBe(true)
    expect(isRelevantNetworkType('Fetch')).toBe(true)
    expect(isRelevantNetworkType('XHR')).toBe(true)
    expect(isRelevantNetworkType('WebSocket')).toBe(false)
    expect(isRelevantNetworkType('EventSource')).toBe(false)
    expect(isRelevantNetworkType('Media')).toBe(false)
    expect(isRelevantNetworkType('Ping')).toBe(false)
  })

  it('does not emit from navigation timing or load alone', () => {
    const onStable = vi.fn()
    const settler = createSettler({ onStable })

    settler.beginNavigation({ url: 'https://example.com', loaderId: 'loader-1', timestamp: 1_000, videoOffsetMs: 500 })
    settler.onLifecycle({ loaderId: 'loader-1', name: 'load', timestamp: 1_200 })

    expect(settler.addVisualSample({ loaderId: 'loader-1', timestamp: 1_750, videoOffsetMs: 1_250, signature: 'stable' })).toBeNull()
    expect(onStable).not.toHaveBeenCalled()
  })

  it('emits the first sample in a stable run after load and network quiet', () => {
    const settler = createSettler()
    settler.beginNavigation({ url: 'https://example.com/orders', loaderId: 'loader-1', timestamp: 1_000, videoOffsetMs: 200 })
    settler.onRequestStarted({ requestId: 'doc', loaderId: 'loader-1', type: 'Document', timestamp: 1_000 })
    settler.onLifecycle({ loaderId: 'loader-1', name: 'load', timestamp: 1_300 })
    settler.onRequestFinished({ requestId: 'doc', timestamp: 1_500 })

    expect(settler.addVisualSample({ loaderId: 'loader-1', timestamp: 2_299, videoOffsetMs: 1_499, signature: 'complete' })).toBeNull()
    expect(settler.addVisualSample({ loaderId: 'loader-1', timestamp: 2_300, videoOffsetMs: 1_500, signature: 'complete' })).toBeNull()
    expect(settler.addVisualSample({ loaderId: 'loader-1', timestamp: 2_550, videoOffsetMs: 1_750, signature: 'complete' })).toBeNull()
    const event = settler.addVisualSample({ loaderId: 'loader-1', timestamp: 2_800, videoOffsetMs: 2_000, signature: 'complete' })

    expect(event).toEqual({
      type: 'navigation-stable',
      url: 'https://example.com/orders',
      loaderId: 'loader-1',
      timestamp: 2_300,
      videoOffsetMs: 1_500,
      reason: 'load+network-quiet+visual-stable',
      confidence: 'high'
    })
  })

  it('resets the quiet window and stable run when relevant network activity resumes', () => {
    const settler = createSettler({ stableSampleCount: 2 })
    settler.beginNavigation({ url: 'https://example.com', loaderId: 'loader-1', timestamp: 0, videoOffsetMs: 0 })
    settler.onLifecycle({ loaderId: 'loader-1', name: 'load', timestamp: 100 })
    settler.addVisualSample({ loaderId: 'loader-1', timestamp: 800, videoOffsetMs: 800, signature: 'page' })
    settler.onRequestStarted({ requestId: 'late', loaderId: 'loader-1', type: 'Image', timestamp: 900 })
    settler.onRequestFinished({ requestId: 'late', timestamp: 1_100 })

    expect(settler.addVisualSample({ loaderId: 'loader-1', timestamp: 1_899, videoOffsetMs: 1_899, signature: 'page' })).toBeNull()
    expect(settler.addVisualSample({ loaderId: 'loader-1', timestamp: 1_900, videoOffsetMs: 1_900, signature: 'page' })).toBeNull()
    expect(settler.addVisualSample({ loaderId: 'loader-1', timestamp: 2_150, videoOffsetMs: 2_150, signature: 'page' })).toMatchObject({ timestamp: 1_900, confidence: 'high' })
  })

  it('does not let WebSocket activity block a stable candidate', () => {
    const settler = createSettler({ stableSampleCount: 2 })
    settler.beginNavigation({ url: 'https://example.com/live', loaderId: 'loader-1', timestamp: 0, videoOffsetMs: 0 })
    settler.onLifecycle({ loaderId: 'loader-1', name: 'load', timestamp: 100 })
    settler.onRequestStarted({ requestId: 'socket', loaderId: 'loader-1', type: 'WebSocket', timestamp: 200 })

    expect(settler.addVisualSample({ loaderId: 'loader-1', timestamp: 800, videoOffsetMs: 800, signature: 'live' })).toBeNull()
    expect(settler.addVisualSample({ loaderId: 'loader-1', timestamp: 1_050, videoOffsetMs: 1_050, signature: 'live' })).toMatchObject({ timestamp: 800, confidence: 'high' })
  })

  it('uses a bounded deadline fallback instead of waiting forever for animation', () => {
    const settler = createSettler()
    settler.beginNavigation({ url: 'https://example.com/animated', loaderId: 'loader-1', timestamp: 1_000, videoOffsetMs: 300 })
    settler.onLifecycle({ loaderId: 'loader-1', name: 'DOMContentLoaded', timestamp: 1_200 })

    settler.addVisualSample({ loaderId: 'loader-1', timestamp: 2_600, videoOffsetMs: 1_900, signature: 'frame-a' })
    settler.addVisualSample({ loaderId: 'loader-1', timestamp: 5_000, videoOffsetMs: 4_300, signature: 'frame-b' })
    const event = settler.addVisualSample({ loaderId: 'loader-1', timestamp: 11_000, videoOffsetMs: 10_300, signature: 'frame-c' })

    expect(event).toEqual({
      type: 'navigation-stable',
      url: 'https://example.com/animated',
      loaderId: 'loader-1',
      timestamp: 2_600,
      videoOffsetMs: 1_900,
      reason: 'deadline+first-valid-visual',
      confidence: 'low'
    })
  })

  it('ignores stale samples from a superseded loader and emits once', () => {
    const settler = createSettler({ stableSampleCount: 2, networkQuietMs: 0 })
    settler.beginNavigation({ url: 'https://redirect.example', loaderId: 'loader-1', timestamp: 0, videoOffsetMs: 0 })
    settler.beginNavigation({ url: 'https://example.com/final', loaderId: 'loader-2', timestamp: 100, videoOffsetMs: 100 })
    settler.onLifecycle({ loaderId: 'loader-2', name: 'load', timestamp: 200 })

    expect(settler.addVisualSample({ loaderId: 'loader-1', timestamp: 300, videoOffsetMs: 300, signature: 'old' })).toBeNull()
    expect(settler.addVisualSample({ loaderId: 'loader-2', timestamp: 300, videoOffsetMs: 300, signature: 'final' })).toBeNull()
    const first = settler.addVisualSample({ loaderId: 'loader-2', timestamp: 550, videoOffsetMs: 550, signature: 'final' })
    expect(first).toMatchObject({ url: 'https://example.com/final', loaderId: 'loader-2' })
    expect(settler.addVisualSample({ loaderId: 'loader-2', timestamp: 800, videoOffsetMs: 800, signature: 'final' })).toBeNull()
  })
})
