import { describe, expect, it } from 'vitest'
import {
  MAX_RECORDING_TITLE_LENGTH,
  createRecordingMetadata,
  deriveDefaultTitle,
  normalizeRecordingMetadata,
  toLibraryEntry
} from '../../src/main/recording-library/metadata.js'

const id = '3d4527e4-4d47-4aea-a4ba-cd61218bbd27'
const createdAt = '2026-08-08T12:15:00.000Z'

describe('recording metadata', () => {
  it('uses a stable date-and-time title while ignoring website hosts', () => {
    expect(deriveDefaultTitle({
      timeline: [
        { type: 'navigation', url: 'http://127.0.0.1:43123/?shell=electron' },
        { type: 'navigation', url: 'chrome://newtab/' },
        { type: 'navigation', url: 'https://www.example.com/orders/1' }
      ],
      createdAt,
      locale: 'zh-CN',
      timeZone: 'Asia/Shanghai'
    })).toBe('Recording-8月8日20:15')
  })

  it('uses the same date title when no meaningful host exists', () => {
    expect(deriveDefaultTitle({ timeline: [], createdAt, locale: 'zh-CN', timeZone: 'Asia/Shanghai' })).toBe('Recording-8月8日20:15')
  })

  it('creates portable schema v1 metadata and a list-only projection', () => {
    const metadata = createRecordingMetadata({
      id,
      createdAt,
      timeline: [
        { type: 'navigation', url: 'http://127.0.0.1:43123/recording-start.html' },
        { type: 'navigation', url: 'https://example.com/orders/1' },
        { type: 'navigation', url: 'https://admin.example.net/dashboard' },
        { type: 'navigation', url: 'https://example.com/orders/2' }
      ],
      durationMs: 42_000,
      captureStatus: 'complete',
      videoStatus: 'complete',
      locale: 'zh-CN',
      timeZone: 'Asia/Shanghai'
    })

    expect(metadata).toMatchObject({
      schemaVersion: 1,
      id,
      title: 'Recording-8月8日20:15',
      state: 'active',
      trashedAt: null,
      capture: { status: 'complete', durationMs: 42_000, visitedHosts: ['example.com', 'admin.example.net'] },
      video: {
        status: 'complete',
        relativePath: 'video/recording.mp4',
        posterRelativePath: 'video/poster.png'
      },
      prompt: { status: 'empty', updatedAt: null }
    })
    expect(toLibraryEntry(metadata)).toEqual({
      id,
      title: metadata.title,
      state: 'active',
      createdAt,
      durationMs: 42_000,
      startHost: 'example.com',
      visitedHosts: ['example.com', 'admin.example.net'],
      videoStatus: 'complete',
      promptStatus: 'empty'
    })
    expect(JSON.stringify(metadata)).not.toContain('/Users/')
  })

  it('repairs state from directory location and validates immutable identity', () => {
    const metadata = createRecordingMetadata({ id, createdAt, durationMs: 1 })
    const repaired = normalizeRecordingMetadata({ ...metadata, state: 'active', trashedAt: null }, 'trashed', { now: new Date('2026-08-08T12:20:00.000Z') })
    expect(repaired.state).toBe('trashed')
    expect(repaired.trashedAt).toBe('2026-08-08T12:20:00.000Z')
    expect(() => normalizeRecordingMetadata({ ...metadata, id: 'bad' }, 'active')).toThrowError(expect.objectContaining({ code: 'CORRUPT_MATERIAL' }))
  })

  it('documents and enforces the title length boundary through normalization', () => {
    expect(MAX_RECORDING_TITLE_LENGTH).toBe(120)
    const metadata = createRecordingMetadata({ id, createdAt })
    expect(() => normalizeRecordingMetadata({ ...metadata, title: 'x'.repeat(121) }, 'active')).toThrowError(expect.objectContaining({ code: 'CORRUPT_MATERIAL' }))
  })
})
