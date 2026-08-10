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
      return res.end(`<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><div id="player"></div><script type="module">
        import { mountVideoPlayer } from '/views/video-player.js'
        window.mediaErrors = []
        window.controller = mountVideoPlayer({ container: document.querySelector('#player'), src: '/video.mp4', poster: '/poster.png', durationMs: 42000, title: '订单查询', onMediaError: error => window.mediaErrors.push({ name: error?.name, message: error?.message }) })
      </script></body></html>`)
    }
    if (url.pathname === '/video.mp4') {
      const video = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'tiny.mp4'))
      const match = req.headers.range?.match(/bytes=(\d+)-(\d*)/)
      res.setHeader('content-type', 'video/mp4')
      res.setHeader('accept-ranges', 'bytes')
      if (match) {
        const start = Number(match[1])
        const end = match[2] ? Math.min(Number(match[2]), video.length - 1) : video.length - 1
        res.statusCode = 206
        res.setHeader('content-range', `bytes ${start}-${end}/${video.length}`)
        res.setHeader('content-length', end - start + 1)
        return res.end(video.subarray(start, end + 1))
      }
      res.setHeader('content-length', video.length)
      return res.end(video)
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
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= HTMLMediaElement.HAVE_METADATA)
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

  it('keeps a valid player intact when play is interrupted with AbortError', async () => {
    const page = await browser.newPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= HTMLMediaElement.HAVE_METADATA)
    await page.locator('video').evaluate(video => {
      video.play = async () => { throw new DOMException('The play request was interrupted', 'AbortError') }
    })

    await page.locator('.player-surface-toggle').click()

    expect(await page.locator('[data-video-player]').count()).toBe(1)
    expect(await page.locator('video').count()).toBe(1)
    expect(await page.evaluate(() => window.mediaErrors)).toEqual([])
    await page.close()
  })

  it('hides controls only after playing idle and reveals them immediately for pointer or keyboard focus', { timeout: 12000 }, async () => {
    const page = await browser.newPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    const root = page.locator('[data-video-player]')
    const controls = page.locator('.player-controls')
    await page.evaluate(() => {
      const video = document.querySelector('video')
      window.playerIsPlaying = false
      Object.defineProperty(video, 'paused', { configurable: true, get: () => !window.playerIsPlaying })
      video.play = async () => { window.playerIsPlaying = true; video.dispatchEvent(new Event('play')) }
      video.pause = () => { window.playerIsPlaying = false; video.dispatchEvent(new Event('pause')) }
    })

    await page.locator('.player-surface-toggle').click()
    await page.evaluate(() => document.activeElement?.blur())
    await expect.poll(() => root.evaluate(element => element.classList.contains('controls-hidden')), { timeout: 2600 }).toBe(true)

    await root.dispatchEvent('pointermove', { clientX: 20, clientY: 20 })
    expect(await root.evaluate(element => element.classList.contains('controls-hidden'))).toBe(false)
    const showMotion = await controls.evaluate(element => {
      const style = getComputedStyle(element)
      return { duration: style.transitionDuration, property: style.transitionProperty }
    })
    expect(showMotion.property.split(',').map(value => value.trim())).toEqual(['opacity', 'transform'])
    expect(showMotion.duration.split(',').map(value => value.trim())).toEqual(['0.08s', '0.08s'])

    await page.getByRole('button', { name: '播放速度 1 倍' }).focus()
    await page.waitForTimeout(1800)
    expect(await root.evaluate(element => element.classList.contains('controls-hidden'))).toBe(false)

    await page.evaluate(() => document.activeElement?.blur())
    await expect.poll(() => root.evaluate(element => element.classList.contains('controls-hidden')), { timeout: 2600 }).toBe(true)
    const hideMotion = await controls.evaluate(element => getComputedStyle(element).transitionDuration)
    expect(hideMotion.split(',').map(value => value.trim())).toEqual(['0.15s', '0.15s'])

    await page.evaluate(() => document.querySelector('video').pause())
    expect(await root.evaluate(element => element.classList.contains('controls-hidden'))).toBe(false)
    await page.close()
  })

  it('removes control translation in reduced-motion mode without losing visibility feedback', async () => {
    const page = await browser.newPage({ reducedMotion: 'reduce' })
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await page.locator('[data-video-player]').evaluate(element => element.classList.add('controls-hidden'))
    const reduced = await page.locator('.player-controls').evaluate(element => {
      const style = getComputedStyle(element)
      return { transform: style.transform, property: style.transitionProperty, duration: style.transitionDuration }
    })
    expect(reduced.transform).toBe('none')
    expect(reduced.property).toBe('opacity')
    expect(Number.parseFloat(reduced.duration)).toBeLessThanOrEqual(.08)
    await page.close()
  })

})
