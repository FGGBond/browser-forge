import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { generatePoster, selectPosterOffset } from '../../src/main/recorder/poster-generator.js'

let root
let recordingDir

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bf-poster-'))
  recordingDir = join(root, 'recording')
  await mkdir(join(recordingDir, 'video'), { recursive: true })
  await writeFile(join(recordingDir, 'video', 'recording.mp4'), 'video')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function successfulSpawn(payload = {}) {
  return () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(`${JSON.stringify({ requestedOffsetMs: 3_000, actualOffsetMs: 2_960, width: 1280, height: 720, ...payload })}\n`))
      child.emit('close', 0, null)
    })
    return child
  }
}

describe('generatePoster', () => {
  it('selects only the first navigation-stable event and never adds an arbitrary delay', () => {
    expect(selectPosterOffset({
      durationMs: 12_000,
      timeline: [
        { type: 'navigation', url: 'https://example.com/too-early', videoOffsetMs: 1_000 },
        { type: 'navigation-stable', url: 'https://example.com/orders', videoOffsetMs: 3_000, confidence: 'high' },
        { type: 'navigation-stable', url: 'https://later.example/dashboard', videoOffsetMs: 5_000, confidence: 'high' }
      ]
    })).toBe(3_000)
  })

  it('clamps a stable candidate to captured video coverage', () => {
    expect(selectPosterOffset({
      durationMs: 4_000,
      coveredUntilOffsetMs: 3_500,
      timeline: [{ type: 'navigation-stable', url: 'https://example.com', videoOffsetMs: 3_700 }]
    })).toBe(3_400)
  })

  it('returns null instead of choosing the guide page or an arbitrary early frame', () => {
    expect(selectPosterOffset({ durationMs: 3_000, timeline: [] })).toBeNull()
    expect(selectPosterOffset({
      durationMs: 42_000,
      timeline: [
        { type: 'navigation', url: 'https://example.com', videoOffsetMs: 2_000 },
        { type: 'navigation-stable', url: 'http://127.0.0.1:43123/recording-start.html', videoOffsetMs: 1_000 }
      ],
      internalOrigins: ['http://127.0.0.1:43123']
    })).toBeNull()
  })

  it('extracts the stable frame and persists native requested and actual offsets', async () => {
    const spawn = vi.fn(successfulSpawn({ requestedOffsetMs: 3_000, actualOffsetMs: 2_960 }))
    const result = await generatePoster({
      recordingDir,
      durationMs: 12_000,
      timeline: [{ type: 'navigation-stable', url: 'https://example.com/orders', videoOffsetMs: 3_000 }],
      nativeToolPathOptions: { platform: 'darwin', arch: 'arm64', packaged: true, resourcesPath: '/bundle' },
      spawn
    })

    expect(spawn).toHaveBeenCalledWith('/bundle/native-tools/bf-video-frame', [
      '--input', join(recordingDir, 'video', 'recording.mp4'),
      '--offset-ms', '3000',
      '--output', join(recordingDir, 'video', 'poster.png')
    ], expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }))
    expect(result).toEqual({
      status: 'complete',
      path: join(recordingDir, 'video', 'poster.png'),
      offsetMs: 2_960,
      requestedOffsetMs: 3_000,
      actualOffsetMs: 2_960,
      width: 1280,
      height: 720
    })
  })

  it('does not invoke the native extractor when no stable external page exists', async () => {
    const spawn = vi.fn(successfulSpawn())
    const result = await generatePoster({ recordingDir, durationMs: 42_000, timeline: [], spawn })
    expect(spawn).not.toHaveBeenCalled()
    expect(result).toEqual({ status: 'unavailable', reason: 'no-stable-external-page' })
  })

  it('rejects malformed extractor output instead of pretending time alignment succeeded', async () => {
    const spawn = vi.fn(successfulSpawn({ requestedOffsetMs: 'bad', actualOffsetMs: null }))
    const result = await generatePoster({
      recordingDir,
      durationMs: 5_000,
      timeline: [{ type: 'navigation-stable', url: 'https://example.com', videoOffsetMs: 2_000 }],
      nativeToolPathOptions: { platform: 'darwin', arch: 'arm64', projectRoot: '/project' },
      spawn
    })
    expect(result).toMatchObject({ status: 'failed', error: expect.objectContaining({ message: expect.stringContaining('valid offsets') }) })
  })

  it('returns a failed result without changing video material when extraction fails', async () => {
    const spawn = vi.fn(() => { throw new Error('permission denied') })
    await expect(generatePoster({
      recordingDir,
      durationMs: 5_000,
      timeline: [{ type: 'navigation-stable', url: 'https://example.com', videoOffsetMs: 2_000 }],
      nativeToolPathOptions: { platform: 'darwin', arch: 'arm64', projectRoot: '/project' },
      spawn
    })).resolves.toMatchObject({ status: 'failed', error: expect.any(Error) })
  })

  it('reports native non-zero exit details without throwing', async () => {
    const spawn = vi.fn(() => {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('bad frame'))
        child.emit('close', 3, null)
      })
      return child
    })
    const result = await generatePoster({
      recordingDir,
      durationMs: 5_000,
      timeline: [{ type: 'navigation-stable', url: 'https://example.com', videoOffsetMs: 2_000 }],
      nativeToolPathOptions: { platform: 'darwin', arch: 'arm64', projectRoot: '/project' },
      spawn
    })
    expect(result).toMatchObject({ status: 'failed', error: expect.objectContaining({ message: expect.stringContaining('bad frame') }) })
  })
})
