import { describe, expect, it } from 'vitest'
import { createMediaRange } from '../../src/main/recorder/media-response.js'

describe('createMediaRange', () => {
  it.each([
    [undefined, 1000, { status: 200, start: 0, end: 999, length: 1000 }],
    ['bytes=0-99', 1000, { status: 206, start: 0, end: 99, length: 100 }],
    ['bytes=900-', 1000, { status: 206, start: 900, end: 999, length: 100 }],
    ['bytes=-100', 1000, { status: 206, start: 900, end: 999, length: 100 }],
    ['bytes=0-9999', 1000, { status: 206, start: 0, end: 999, length: 1000 }]
  ])('maps %s to a bounded response', (header, size, expected) => {
    expect(createMediaRange(header, size)).toEqual(expected)
  })

  it.each(['bytes=1000-1001', 'bytes=20-10', 'items=0-1', 'bytes=0-1,4-5', 'bytes=-'])('rejects invalid or unsatisfiable range %s', header => {
    expect(() => createMediaRange(header, 1000)).toThrowError(expect.objectContaining({ status: 416, code: 'INVALID_RANGE' }))
  })
})
