import { describe, it, expect } from 'vitest'
import { buildTimeline } from '../../src/main/recorder/timeline-builder.js'

describe('buildTimeline', () => {
  it('merges events from multiple tabs sorted by timestamp', () => {
    const events = [
      { timestamp: 2000, type: 'click', targetId: 't2' },
      { timestamp: 1000, type: 'navigation', targetId: 't1', url: 'https://a.com' },
      { timestamp: 3000, type: 'tab-switch', fromTargetId: 't1', toTargetId: 't2' }
    ]
    const timeline = buildTimeline(events)
    expect(timeline[0].timestamp).toBe(1000)
    expect(timeline[1].timestamp).toBe(2000)
    expect(timeline[2].timestamp).toBe(3000)
  })
})
