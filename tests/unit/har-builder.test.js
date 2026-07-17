import { describe, it, expect } from 'vitest'
import { buildHar } from '../../src/main/recorder/har-builder.js'

describe('buildHar', () => {
  it('produces valid HAR 1.2 envelope', () => {
    const har = buildHar({ entries: [], pages: [], startedDateTime: '2026-07-17T14:32:00.000Z' })
    expect(har.log.version).toBe('1.2')
    expect(har.log.creator.name).toBe('browser-forge')
    expect(Array.isArray(har.log.entries)).toBe(true)
  })

  it('includes provided entries', () => {
    const entry = { startedDateTime: '2026-07-17T14:32:01.000Z', time: 50, request: {}, response: {} }
    const har = buildHar({ entries: [entry], pages: [], startedDateTime: '2026-07-17T14:32:00.000Z' })
    expect(har.log.entries).toHaveLength(1)
  })
})
