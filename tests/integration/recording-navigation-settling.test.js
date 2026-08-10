import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RecordingSession } from '../../src/main/recorder/index.js'
import { generatePoster } from '../../src/main/recorder/poster-generator.js'
import { findAvailablePort } from '../../src/main/chrome-launcher.js'

let browser
let browserPort
let webServer
let baseUrl
let outputDir

beforeAll(async () => {
  browserPort = await findAvailablePort()
  browser = await chromium.launch({ args: [`--remote-debugging-port=${browserPort}`] })
  outputDir = await mkdtemp(join(tmpdir(), 'bf-navigation-settling-'))
  webServer = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (req.url === '/recording-start.html') {
      res.end('<!doctype html><style>body{margin:0;background:#1263df}</style><body>guide</body>')
      return
    }
    res.end(`<!doctype html>
      <style>
        html,body{margin:0;width:100%;height:100%}
        body{background:#fff;font:32px sans-serif}
        body.skeleton{background:#f5c542}
        body.stable{background:#1ca64c}
      </style>
      <body>transition</body>
      <script>
        setTimeout(() => { document.body.className = 'skeleton'; document.body.textContent = 'skeleton' }, 300)
        setTimeout(() => { document.body.className = 'stable'; document.body.textContent = 'stable content' }, 900)
      </script>`)
  })
  await new Promise(resolve => webServer.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${webServer.address().port}`
})

afterAll(async () => {
  await browser?.close()
  await new Promise(resolve => webServer?.close(resolve))
  if (outputDir) await rm(outputDir, { recursive: true, force: true })
})

describe('recording navigation settling integration', () => {
  it('selects the stable stage rather than guide, transition, or skeleton frames', async () => {
    const page = await browser.newPage()
    await page.goto(`${baseUrl}/recording-start.html`)
    const recording = new RecordingSession({ port: browserPort, outputDir })
    await recording.start()

    const stagedUrl = `http://localhost:${webServer.address().port}/staged`
    await page.goto(stagedUrl)
    await expect.poll(
      () => recording._timelineEvents.find(event => event.type === 'navigation-stable'),
      { timeout: 6_000, interval: 100 }
    ).toMatchObject({
      type: 'navigation-stable',
      url: stagedUrl,
      reason: 'load+network-quiet+visual-stable',
      confidence: 'high'
    })

    const sessionDir = await recording.stop()
    const timeline = JSON.parse(await readFile(join(sessionDir, 'timeline.json'), 'utf8'))
    const stable = timeline.find(event => event.type === 'navigation-stable')
    const spawn = vi.fn(() => {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({ requestedOffsetMs: stable.videoOffsetMs, actualOffsetMs: stable.videoOffsetMs, width: 1280, height: 720 })}\n`))
        child.emit('close', 0, null)
      })
      return child
    })

    const poster = await generatePoster({
      recordingDir: sessionDir,
      durationMs: stable.videoOffsetMs + 2_000,
      coveredUntilOffsetMs: stable.videoOffsetMs + 1_000,
      timeline,
      internalOrigins: [baseUrl],
      nativeToolPathOptions: { platform: 'darwin', arch: 'arm64', packaged: true, resourcesPath: '/bundle' },
      spawn
    })

    expect(poster).toMatchObject({
      status: 'complete',
      requestedOffsetMs: stable.videoOffsetMs,
      actualOffsetMs: stable.videoOffsetMs
    })
    const navigation = timeline.find(event => event.type === 'navigation' && new URL(event.url).pathname === '/staged')
    expect(navigation).toBeTruthy()
    expect(stable.timestamp - navigation.timestamp).toBeGreaterThanOrEqual(850)
    expect(spawn.mock.calls[0][1]).toContain(String(stable.videoOffsetMs))
    await page.close()
  }, 15_000)
})
