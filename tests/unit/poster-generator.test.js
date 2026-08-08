import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { generatePoster } from '../../src/main/recorder/poster-generator.js'

let root
let recordingDir

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bf-poster-'))
  recordingDir = join(root, 'recording')
  await mkdir(join(recordingDir, 'video'), { recursive: true })
  await writeFile(join(recordingDir, 'video', 'recording.mp4'), 'video')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function successfulSpawn() {
  const child = new EventEmitter()
  child.stderr = new EventEmitter()
  queueMicrotask(() => child.emit('close', 0, null))
  return child
}

describe('generatePoster', () => {
  it('uses the bundled frame tool at min(1000ms, 20% duration)', async () => {
    const spawn = vi.fn(successfulSpawn)
    const result = await generatePoster({
      recordingDir,
      durationMs: 3000,
      nativeToolPathOptions: { platform: 'darwin', arch: 'arm64', packaged: true, resourcesPath: '/bundle' },
      spawn
    })

    expect(spawn).toHaveBeenCalledWith('/bundle/native-tools/bf-video-frame', [
      '--input', join(recordingDir, 'video', 'recording.mp4'),
      '--offset-ms', '600',
      '--output', join(recordingDir, 'video', 'poster.png')
    ], expect.objectContaining({ stdio: ['ignore', 'ignore', 'pipe'] }))
    expect(result).toEqual({ status: 'complete', path: join(recordingDir, 'video', 'poster.png'), offsetMs: 600 })
  })

  it('caps poster extraction at 1000ms', async () => {
    const spawn = vi.fn(successfulSpawn)
    await generatePoster({ recordingDir, durationMs: 42_000, nativeToolPathOptions: { platform: 'darwin', arch: 'arm64', projectRoot: '/project' }, spawn })
    expect(spawn.mock.calls[0][1]).toContain('1000')
  })

  it('returns a failed result without changing video material when extraction fails', async () => {
    const spawn = vi.fn(() => { throw new Error('permission denied') })
    await expect(generatePoster({
      recordingDir,
      durationMs: 5000,
      nativeToolPathOptions: { platform: 'darwin', arch: 'arm64', projectRoot: '/project' },
      spawn
    })).resolves.toMatchObject({ status: 'failed', error: expect.any(Error) })
  })

  it('reports native non-zero exit details without throwing', async () => {
    const spawn = vi.fn(() => {
      const child = new EventEmitter()
      child.stderr = new EventEmitter()
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('bad frame'))
        child.emit('close', 3, null)
      })
      return child
    })
    const result = await generatePoster({ recordingDir, durationMs: 5000, nativeToolPathOptions: { platform: 'darwin', arch: 'arm64', projectRoot: '/project' }, spawn })
    expect(result).toMatchObject({ status: 'failed', error: expect.objectContaining({ message: expect.stringContaining('bad frame') }) })
  })
})
