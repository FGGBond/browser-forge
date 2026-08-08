import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { writeSession } from '../../src/main/recorder/output-writer.js'

let tmpDir

beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'bf-test-')) })
afterEach(() => { rmSync(tmpDir, { recursive: true }) })

describe('writeSession', () => {
  it('creates RECORDING.md', async () => {
    await writeSession({
      outputDir: tmpDir,
      sessionName: 'session-test',
      metadata: { startUrl: 'https://example.com', durationMs: 5000, chromeVersion: '120', tabs: [] },
      har: { log: { version: '1.2', creator: { name: 'browser-forge', version: '0.1.0' }, pages: [], entries: [] } },
      timeline: [],
      tabs: {}
    })
    expect(existsSync(join(tmpDir, 'session-test', 'RECORDING.md'))).toBe(true)
  })

  it('creates recording.har', async () => {
    await writeSession({
      outputDir: tmpDir,
      sessionName: 'session-test',
      metadata: { startUrl: 'https://example.com', durationMs: 5000, chromeVersion: '120', tabs: [] },
      har: { log: { version: '1.2', creator: { name: 'browser-forge', version: '0.1.0' }, pages: [], entries: [] } },
      timeline: [],
      tabs: {}
    })
    expect(existsSync(join(tmpDir, 'session-test', 'recording.har'))).toBe(true)
  })

  it('RECORDING.md contains start URL', async () => {
    await writeSession({
      outputDir: tmpDir,
      sessionName: 'session-test',
      metadata: { startUrl: 'https://example.com', durationMs: 5000, chromeVersion: '120', tabs: [] },
      har: { log: { version: '1.2', creator: { name: 'browser-forge', version: '0.1.0' }, pages: [], entries: [] } },
      timeline: [],
      tabs: {}
    })
    const content = readFileSync(join(tmpDir, 'session-test', 'RECORDING.md'), 'utf-8')
    expect(content).toContain('https://example.com')
  })
})

describe('video material output', () => {
  const videoWindow = { pid: 4321, windowId: 'window-1', title: 'Browser Forge Recording · token' }

  it('moves a completed MP4 into video/ and writes the v1 manifest for agent analysis', async () => {
    const sourcePath = join(tmpDir, 'temporary-window-recording.mp4')
    writeFileSync(sourcePath, 'fake-mp4')

    await writeSession({
      outputDir: tmpDir,
      sessionName: 'session-with-video',
      metadata: { startUrl: 'https://example.com', durationMs: 5_000, chromeVersion: '120', tabs: [] },
      har: { log: { version: '1.2', creator: { name: 'browser-forge', version: '0.1.0' }, pages: [], entries: [] } },
      timeline: [{ timestamp: 1_786_170_001_000, videoOffsetMs: 1_000, type: 'click' }],
      tabs: {},
      video: {
        state: 'complete',
        sourcePath,
        startEpochMs: 1_786_170_000_000,
        durationMs: 5_000,
        coveredUntilOffsetMs: 5_000,
        window: videoWindow
      }
    })

    const videoDir = join(tmpDir, 'session-with-video', 'video')
    expect(existsSync(join(videoDir, 'recording.mp4'))).toBe(true)
    expect(existsSync(sourcePath)).toBe(false)
    expect(JSON.parse(readFileSync(join(videoDir, 'manifest.json'), 'utf8'))).toEqual(expect.objectContaining({
      version: 1,
      state: 'complete',
      file: 'recording.mp4',
      codec: 'h264',
      startEpochMs: 1_786_170_000_000,
      coveredUntilOffsetMs: 5_000,
      window: videoWindow
    }))
    expect(readFileSync(join(tmpDir, 'session-with-video', 'RECORDING.md'), 'utf8')).toContain('video/recording.mp4')
  })

  it('writes only a failed manifest when no usable video file exists', async () => {
    await writeSession({
      outputDir: tmpDir,
      sessionName: 'session-video-failed',
      metadata: { startUrl: 'https://example.com', durationMs: 0, chromeVersion: '120', tabs: [] },
      har: { log: { version: '1.2', creator: { name: 'browser-forge', version: '0.1.0' }, pages: [], entries: [] } },
      timeline: [],
      tabs: {},
      video: { state: 'failed', window: videoWindow }
    })

    const videoDir = join(tmpDir, 'session-video-failed', 'video')
    expect(existsSync(join(videoDir, 'recording.mp4'))).toBe(false)
    expect(JSON.parse(readFileSync(join(videoDir, 'manifest.json'), 'utf8'))).toEqual(expect.objectContaining({
      state: 'failed', coveredUntilOffsetMs: 0
    }))
  })
})
