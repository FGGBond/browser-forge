import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium } from 'playwright'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { RecordingSession } from '../../src/main/recorder/index.js'

let browser, tmpDir

beforeAll(async () => {
  browser = await chromium.launch({ args: ['--remote-debugging-port=19222'] })
  tmpDir = mkdtempSync(join(tmpdir(), 'bf-int-'))
})

afterAll(async () => {
  await browser.close()
  rmSync(tmpDir, { recursive: true })
})

describe('RecordingSession', () => {
  it('writes recording.har and RECORDING.md after stop', async () => {
    const session = new RecordingSession({ port: 19222, outputDir: tmpDir })
    await session.start()
    const page = await browser.newPage()
    await page.goto('data:text/html,<h1>hello</h1>')
    await new Promise(r => setTimeout(r, 500))
    await page.close()
    const sessionDir = await session.stop()
    expect(existsSync(join(sessionDir, 'recording.har'))).toBe(true)
    expect(existsSync(join(sessionDir, 'RECORDING.md'))).toBe(true)
  }, 15000)
})
