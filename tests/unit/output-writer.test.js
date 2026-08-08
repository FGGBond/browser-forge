import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs'
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

  it('refuses to merge into an existing session directory', async () => {
    const sessionDir = join(tmpDir, 'session-existing')
    mkdirSync(join(sessionDir, 'video'), { recursive: true })
    writeFileSync(join(sessionDir, 'video', 'recording.mp4'), 'previous-recording')

    await expect(writeSession({
      outputDir: tmpDir,
      sessionName: 'session-existing',
      metadata: { startUrl: 'https://new.example', durationMs: 5000, chromeVersion: '120', tabs: [] },
      har: { log: { version: '1.2', creator: { name: 'browser-forge', version: '0.1.0' }, pages: [], entries: [] } },
      timeline: [],
      tabs: {}
    })).rejects.toMatchObject({ code: 'EEXIST' })

    expect(readFileSync(join(sessionDir, 'video', 'recording.mp4'), 'utf8')).toBe('previous-recording')
    expect(existsSync(join(sessionDir, 'metadata.json'))).toBe(false)
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
  it('keeps all non-video materials when copying the captured MP4 fails', async () => {
    const unreadableSource = join(tmpDir, 'source-is-a-directory')
    // copyFile() rejects directories on every supported platform.
    mkdirSync(unreadableSource)

    await expect(writeSession({
      outputDir: tmpDir,
      sessionName: 'session-video-copy-failed',
      metadata: {
        startedAt: '2026-08-08T12:00:00.000Z',
        startUrl: 'https://example.com',
        durationMs: 1_000,
        chromeVersion: '120',
        tabs: [{ targetId: 'tab-1' }]
      },
      har: { log: { version: '1.2', creator: { name: 'browser-forge', version: '0.1.0' }, pages: [], entries: [] } },
      timeline: [{ timestamp: 1_786_170_001_000, videoOffsetMs: 1_000, type: 'click' }],
      tabs: {
        'tab-1': {
          title: 'Example',
          events: [{ type: 'click' }],
          console: [{ level: 'log', text: 'kept' }],
          domSnapshots: [{ timestamp: 1, html: '<main>kept</main>' }]
        }
      },
      video: {
        state: 'complete',
        sourcePath: unreadableSource,
        startEpochMs: 1_786_170_000_000,
        durationMs: 1_000,
        coveredUntilOffsetMs: 1_000,
        window: videoWindow
      }
    })).resolves.toBe(join(tmpDir, 'session-video-copy-failed'))

    const sessionDir = join(tmpDir, 'session-video-copy-failed')
    expect(existsSync(join(sessionDir, 'recording.har'))).toBe(true)
    expect(existsSync(join(sessionDir, 'timeline.json'))).toBe(true)
    expect(existsSync(join(sessionDir, 'metadata.json'))).toBe(true)
    expect(existsSync(join(sessionDir, 'RECORDING.md'))).toBe(true)
    expect(existsSync(join(sessionDir, 'tabs', 'tab-1-Example', 'events.json'))).toBe(true)
    expect(existsSync(join(sessionDir, 'tabs', 'tab-1-Example', 'dom-1.html'))).toBe(true)
    expect(existsSync(join(sessionDir, 'video', 'recording.mp4'))).toBe(false)
    expect(JSON.parse(readFileSync(join(sessionDir, 'video', 'manifest.json'), 'utf8'))).toEqual({
      version: 1,
      state: 'failed',
      startEpochMs: null,
      durationMs: 0,
      coveredUntilOffsetMs: 0,
      window: videoWindow
    })
    expect(JSON.parse(readFileSync(join(sessionDir, 'metadata.json'), 'utf8')).video).toEqual({
      state: 'failed',
      startEpochMs: null,
      durationMs: 0,
      coveredUntilOffsetMs: 0
    })
    expect(readFileSync(join(sessionDir, 'RECORDING.md'), 'utf8')).not.toContain('video/recording.mp4')
  })

})

describe('managed session output', () => {
  it('writes an exact managed session directory without adding a timestamp child', async () => {
    const sessionDir = join(tmpDir, 'staging', '3d4527e4-4d47-4aea-a4ba-cd61218bbd27')
    const metadata = { startUrl: 'https://example.com', durationMs: 5000, chromeVersion: '120', tabs: [] }
    const result = await writeSession({
      sessionDir,
      metadata,
      har: { log: { version: '1.2', creator: { name: 'browser-forge', version: '0.1.0' }, pages: [], entries: [] } },
      timeline: [],
      tabs: {}
    })

    expect(result).toBe(sessionDir)
    expect(JSON.parse(readFileSync(join(sessionDir, 'metadata.json'), 'utf8'))).toEqual(metadata)
    expect(existsSync(join(sessionDir, 'RECORDING.md'))).toBe(true)
  })
})
