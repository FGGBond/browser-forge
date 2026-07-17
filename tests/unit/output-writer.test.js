import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
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
