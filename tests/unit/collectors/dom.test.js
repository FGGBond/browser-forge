import { describe, it, expect } from 'vitest'
import { DomCollector } from '../../../src/main/recorder/collectors/dom.js'

describe('DomCollector', () => {
  it('stores a snapshot with timestamp and html', () => {
    const col = new DomCollector({ targetId: 't1' })
    col.addSnapshot({ timestamp: 1000, html: '<html></html>', url: 'https://example.com/' })
    expect(col.getSnapshots()).toHaveLength(1)
    expect(col.getSnapshots()[0].html).toBe('<html></html>')
  })
})
