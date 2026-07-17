import { describe, it, expect } from 'vitest'
import { NetworkCollector } from '../../../src/main/recorder/collectors/network.js'

describe('NetworkCollector', () => {
  it('records a request entry on requestWillBeSent', () => {
    const col = new NetworkCollector({ targetId: 't1', maxBodyBytes: 10_000_000 })
    col.onRequestWillBeSent({
      requestId: 'r1',
      request: { url: 'https://example.com/', method: 'GET', headers: {} },
      timestamp: 1000,
      type: 'Document'
    })
    expect(col.getEntries()).toHaveLength(1)
    expect(col.getEntries()[0].requestId).toBe('r1')
  })

  it('attaches response data on responseReceived', () => {
    const col = new NetworkCollector({ targetId: 't1', maxBodyBytes: 10_000_000 })
    col.onRequestWillBeSent({
      requestId: 'r1',
      request: { url: 'https://example.com/', method: 'GET', headers: {} },
      timestamp: 1000,
      type: 'Document'
    })
    col.onResponseReceived({
      requestId: 'r1',
      response: { url: 'https://example.com/', status: 200, headers: {}, mimeType: 'text/html' },
      timestamp: 1050
    })
    expect(col.getEntries()[0].response.status).toBe(200)
  })
})
