import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { createServer } from 'http'
import { readFileSync, statSync } from 'fs'
import { extname, join } from 'path'

let browser
let server
let baseUrl
const contentTypes = { '.js': 'text/javascript', '.css': 'text/css' }

beforeAll(async () => {
  browser = await chromium.launch()
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/') {
      res.setHeader('content-type', 'text/html')
      return res.end(`<!doctype html><html><body><div id="player"></div><script type="module">
        import { mountVideoPlayer } from '/views/video-player.js'
        window.controller = mountVideoPlayer({ container: document.querySelector('#player'), src: '/video.mp4', poster: '/poster.png', durationMs: 42000, title: '订单查询' })
      </script></body></html>`)
    }
    const path = join(process.cwd(), 'ui', url.pathname.slice(1))
    try {
      if (!statSync(path).isFile()) throw new Error()
      res.setHeader('content-type', contentTypes[extname(path)] || 'application/octet-stream')
      res.end(readFileSync(path))
    } catch {
      res.statusCode = 404
      res.end('not found')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

afterAll(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)) })

describe('custom Browser Forge video player', () => {
  it('omits native media affordances and exposes only private controls', async () => {
    const page = await browser.newPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    const video = page.locator('video')
    expect(await video.getAttribute('controls')).toBeNull()
    expect(await video.getAttribute('muted')).not.toBeNull()
    expect(await video.getAttribute('disablepictureinpicture')).not.toBeNull()
    expect(await video.getAttribute('controlslist')).toContain('nodownload')
    expect(await page.getByRole('button', { name: '后退 10 秒' }).count()).toBe(1)
    expect(await page.getByRole('button', { name: '前进 10 秒' }).count()).toBe(1)
    expect(await page.getByRole('button', { name: '进入全屏' }).count()).toBe(1)
    expect(await page.getByRole('button', { name: /音量|下载|画中画/ }).count()).toBe(0)
    await page.close()
  })

  it('clamps seeking, cycles playback rate, supports keyboard, and requests fullscreen', async () => {
    const page = await browser.newPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await page.evaluate(() => {
      const video = document.querySelector('video')
      Object.defineProperty(video, 'duration', { configurable: true, value: 42 })
      video.currentTime = 5
      video.play = async () => { video.dispatchEvent(new Event('play')) }
      video.pause = () => { video.dispatchEvent(new Event('pause')) }
      document.querySelector('[data-video-player]').requestFullscreen = async () => { window.fullscreenRequested = true }
      video.dispatchEvent(new Event('loadedmetadata'))
      video.dispatchEvent(new Event('timeupdate'))
    })
    await page.getByRole('button', { name: '后退 10 秒' }).click()
    expect(await page.locator('video').evaluate(video => video.currentTime)).toBe(0)
    await page.getByRole('button', { name: '前进 10 秒' }).click()
    expect(await page.locator('video').evaluate(video => video.currentTime)).toBe(10)
    await page.locator('[data-video-player]').press('ArrowRight')
    expect(await page.locator('video').evaluate(video => video.currentTime)).toBe(20)
    await page.getByRole('button', { name: '播放速度 1 倍' }).click()
    expect(await page.locator('video').evaluate(video => video.playbackRate)).toBe(1.5)
    await page.getByRole('button', { name: '进入全屏' }).click()
    expect(await page.evaluate(() => window.fullscreenRequested)).toBe(true)
    await page.close()
  })
})
