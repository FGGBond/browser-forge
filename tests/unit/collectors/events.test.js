import { describe, it, expect } from 'vitest'
import { EventsCollector } from '../../../src/main/recorder/collectors/events.js'

describe('EventsCollector', () => {
  it('records a click event', () => {
    const col = new EventsCollector({ targetId: 't1' })
    col.addEvent({ type: 'click', timestamp: 1000, selector: '#btn', x: 100, y: 200 })
    expect(col.getEvents()).toHaveLength(1)
    expect(col.getEvents()[0].type).toBe('click')
  })
})
