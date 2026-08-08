import { describe, expect, it } from 'vitest'
import { addVideoOffset, createVideoManifest } from '../../src/main/recorder/video-manifest.js'

describe('video recording manifest', () => {
  const window = {
    pid: 1234,
    windowId: '42',
    title: 'Browser Forge Recording · test-token'
  }

  it('writes the stable v1 manifest contract for a complete recording', () => {
    expect(createVideoManifest({
      state: 'complete',
      startEpochMs: 1_786_170_000_000,
      durationMs: 42_000,
      coveredUntilOffsetMs: 42_000,
      window,
      fps: 15
    })).toEqual({
      version: 1,
      state: 'complete',
      file: 'recording.mp4',
      codec: 'h264',
      fps: 15,
      startEpochMs: 1_786_170_000_000,
      durationMs: 42_000,
      coveredUntilOffsetMs: 42_000,
      window
    })
  })

  it('only accepts complete, partial, and failed states', () => {
    expect(() => createVideoManifest({ state: 'pending', window })).toThrow(/state/i)
  })

  it('does not claim a video file for a failed capture', () => {
    expect(createVideoManifest({ state: 'failed', window })).toEqual({
      version: 1,
      state: 'failed',
      startEpochMs: null,
      durationMs: 0,
      coveredUntilOffsetMs: 0,
      window
    })
  })

  it('derives event offsets from the persisted first-frame epoch and clamps pre-video events', () => {
    expect(addVideoOffset({ timestamp: 1_000, type: 'click' }, 750)).toEqual({
      timestamp: 1_000,
      type: 'click',
      videoOffsetMs: 250
    })
    expect(addVideoOffset({ timestamp: 700, type: 'navigation' }, 750)).toEqual({
      timestamp: 700,
      type: 'navigation',
      videoOffsetMs: 0
    })
  })
})
