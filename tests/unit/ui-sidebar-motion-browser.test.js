import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { createServer } from 'http'
import { readFileSync, statSync } from 'fs'
import { extname, join } from 'path'

let browser
let server
let baseUrl

const recording = {
  id: 'f4bf0a25-a468-45dc-a006-0f607ade0240',
  title: '查询订单并导出发票',
  state: 'active',
  createdAt: '2026-08-09T09:32:00.000Z',
  durationMs: 163000,
  startHost: 'dongdev.jd.com',
  visitedHosts: ['dongdev.jd.com'],
  videoStatus: 'complete',
  promptStatus: 'draft',
  sizeBytes: 1024
}

const contentTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
}

beforeAll(async () => {
  browser = await chromium.launch()
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/api/recordings') return json(res, { recordings: [recording] })
    if (url.pathname === `/api/recordings/${recording.id}`) return json(res, recording)
    if (url.pathname === `/api/recordings/${recording.id}/prompt`) {
      return json(res, { text: '', status: 'empty', updatedAt: null })
    }
    if (url.pathname.endsWith('/poster') || url.pathname.endsWith('/video')) {
      res.statusCode = 404
      return res.end()
    }
    serveUi(url.pathname, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})


afterAll(async () => {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
})

describe('workspace sidebar motion', () => {
  it('keeps the sidebar, video, and analysis editor nodes alive across state updates and collapse toggles', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: '去分析', exact: true }).click()
    await page.locator('[data-video-player] video').waitFor({ timeout: 3000 })

    await page.evaluate(() => {
      window.__sidebarBeforeAnalysis = document.querySelector('.app-sidebar')
      window.__videoBeforeAnalysis = document.querySelector('[data-video-player] video')
      Object.defineProperty(window.__videoBeforeAnalysis, 'currentTime', {
        configurable: true,
        writable: true,
        value: 37.25
      })
    })

    await page.locator('[data-toggle-analysis]').click()
    await page.locator('[data-analysis-pane] textarea, [data-analysis-pane] [contenteditable="true"], [data-analysis-pane] .CodeMirror').first().waitFor({ state: 'attached', timeout: 3000 })

    expect(await page.evaluate(() => window.__sidebarBeforeAnalysis === document.querySelector('.app-sidebar'))).toBe(true)

    await page.evaluate(() => {
      window.__analysisEditorBeforeToggle = document.querySelector(
        '[data-analysis-pane] [contenteditable="true"], [data-analysis-pane] .CodeMirror, [data-analysis-pane] textarea'
      )
      document.querySelector('[data-sidebar-toggle]').click()
    })
    await page.waitForTimeout(180)

    const preserved = await page.evaluate(() => ({
      sidebar: window.__sidebarBeforeAnalysis === document.querySelector('.app-sidebar'),
      video: window.__videoBeforeAnalysis === document.querySelector('[data-video-player] video'),
      currentTime: document.querySelector('[data-video-player] video').currentTime,
      editor: window.__analysisEditorBeforeToggle === document.querySelector(
        '[data-analysis-pane] [contenteditable="true"], [data-analysis-pane] .CodeMirror, [data-analysis-pane] textarea'
      )
    }))

    expect(preserved).toEqual({ sidebar: true, video: true, currentTime: 37.25, editor: true })
    await page.close()
  }, 15000)

  it('fades labels before collapsing, expands width before fading in, and reverses in flight', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.goto(baseUrl, { waitUntil: 'networkidle' })

    const initial = await sidebarMetrics(page)
    expect(initial.width).toBeGreaterThan(230)
    expect(initial.opacity).toBe(1)

    await page.locator('[data-sidebar-toggle]').click()
    const collapseStart = await sidebarMetrics(page)
    expect(collapseStart.width).toBeGreaterThan(230)
    expect(collapseStart.motion).toBe('collapsing')

    await page.waitForTimeout(45)
    const collapseMid = await sidebarMetrics(page)
    expect(collapseMid.width).toBeGreaterThan(230)
    expect(collapseMid.opacity).toBeLessThan(1)

    await expect.poll(async () => (await sidebarMetrics(page)).width).toBeLessThan(80)
    const collapsed = await sidebarMetrics(page)
    expect(collapsed.motion).toBe('collapsed')
    expect(collapsed.opacity).toBe(0)

    await page.locator('[data-sidebar-toggle]').click()
    const expandStart = await sidebarMetrics(page)
    expect(expandStart.width).toBeGreaterThan(230)
    expect(expandStart.motion).toBe('expanding')
    await expect.poll(async () => (await sidebarMetrics(page)).opacity).toBe(1)

    await page.locator('[data-sidebar-toggle]').click()
    await page.waitForTimeout(45)
    await page.locator('[data-sidebar-toggle]').click()
    await page.waitForTimeout(30)
    const reversed = await sidebarMetrics(page)
    expect(reversed.width).toBeGreaterThan(230)
    expect(reversed.motion).toBe('expanding')
    await expect.poll(async () => (await sidebarMetrics(page)).opacity).toBe(1)
    await expect.poll(async () => (await sidebarMetrics(page)).motion).toBe('expanded')

    await page.close()
  })

  it('removes label displacement when reduced motion is requested', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await page.locator('[data-sidebar-toggle]').click()
    await page.waitForTimeout(20)

    const transform = await page.locator('.sidebar-label').first().evaluate(element => getComputedStyle(element).transform)
    expect(transform).toBe('none')
    await page.close()
  })
})

async function sidebarMetrics(page) {
  return page.evaluate(() => {
    const shell = document.querySelector('[data-app-shell]')
    const label = document.querySelector('.sidebar-label')
    return {
      width: Number.parseFloat(getComputedStyle(shell).gridTemplateColumns),
      opacity: Number.parseFloat(getComputedStyle(label).opacity),
      motion: shell.dataset.sidebarMotion || ''
    }
  })
}

function json(res, value) {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(value))
}

function serveUi(pathname, res) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1)
  const path = join(process.cwd(), 'ui', relative)
  try {
    if (!statSync(path).isFile()) throw new Error('not file')
    res.setHeader('content-type', contentTypes[extname(path)] || 'application/octet-stream')
    res.end(readFileSync(path))
  } catch {
    res.statusCode = 404
    res.end('not found')
  }
}
