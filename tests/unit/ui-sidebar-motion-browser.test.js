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
  it('collapses the sidebar rail to 68px and restores it', { timeout: 20000 }, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
    await page.locator('[data-sidebar-toggle]').waitFor({ timeout: 5000 })

    const before = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.querySelector('[data-app-shell]')).gridTemplateColumns))
    expect(before).toBeGreaterThan(230)

    await page.locator('[data-sidebar-toggle]').click()
    await page.waitForFunction(() => ['collapsed','collapsing'].includes(document.querySelector('[data-app-shell]').dataset.sidebarMotion), null, { timeout: 5000 })
    const after = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.querySelector('[data-app-shell]')).gridTemplateColumns))
    expect(after).toBe(68)

    await page.locator('[data-sidebar-toggle]').click()
    await page.waitForFunction(() => ['expanded','expanding'].includes(document.querySelector('[data-app-shell]').dataset.sidebarMotion), null, { timeout: 5000 })
    const restored = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.querySelector('[data-app-shell]')).gridTemplateColumns))
    expect(restored).toBeGreaterThan(230)

    await page.close()
  })

  it('keeps the shell context and editor nodes alive from repository through detail and sidebar collapse', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await page.locator('[data-context-host] [data-guidance-editor-surface]').waitFor({ state: 'attached', timeout: 3000 })

    await page.evaluate(() => {
      window.__shellBeforeDetail = document.querySelector('[data-app-shell]')
      window.__sidebarBeforeDetail = document.querySelector('.app-sidebar')
      window.__contextBeforeDetail = document.querySelector('[data-context-host]')
      window.__editorBeforeDetail = document.querySelector('[data-context-host] [data-guidance-editor-surface]')
    })

    await page.getByRole('button', { name: '去分析', exact: true }).click()
    await page.locator('[data-video-player] video').waitFor({ timeout: 3000 })

    const afterDetail = await page.evaluate(() => ({
      shell: window.__shellBeforeDetail === document.querySelector('[data-app-shell]'),
      sidebar: window.__sidebarBeforeDetail === document.querySelector('.app-sidebar'),
      context: window.__contextBeforeDetail === document.querySelector('[data-context-host]'),
      editor: window.__editorBeforeDetail === document.querySelector('[data-context-host] [data-guidance-editor-surface]'),
      sidebarWidth: document.querySelector('.app-sidebar').getBoundingClientRect().width,
      contextWidth: document.querySelector('[data-context-host]').getBoundingClientRect().width
    }))
    expect(afterDetail).toMatchObject({ shell: true, sidebar: true, context: true, editor: true })
    expect(afterDetail.sidebarWidth).toBeGreaterThan(230)
    expect(afterDetail.contextWidth).toBeGreaterThanOrEqual(470)

    await page.locator('[data-sidebar-toggle]').click()
    await page.waitForTimeout(180)

    const preserved = await page.evaluate(() => ({
      shell: window.__shellBeforeDetail === document.querySelector('[data-app-shell]'),
      sidebar: window.__sidebarBeforeDetail === document.querySelector('.app-sidebar'),
      context: window.__contextBeforeDetail === document.querySelector('[data-context-host]'),
      editor: window.__editorBeforeDetail === document.querySelector('[data-context-host] [data-guidance-editor-surface]')
    }))
    expect(preserved).toEqual({ shell: true, sidebar: true, context: true, editor: true })
    await page.close()
  }, 15000)

  it('applies reduced-motion preference to the label fade', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto(baseUrl, { waitUntil: 'networkidle' })

    const initial = await sidebarMetrics(page)
    expect(initial.opacity).toBe(1)

    await page.locator('[data-sidebar-toggle]').click()
    await page.waitForTimeout(200)
    const collapsed = await sidebarMetrics(page)
    expect(collapsed.width).toBe(68)

    await page.close()
  })
})

async function sidebarMetrics(page) {
  try {
    return await page.evaluate(() => {
      const shell = document.querySelector('[data-app-shell]')
      const label = document.querySelector('.sidebar-label')
      const motion = shell?.dataset.sidebarMotion || ''
      return {
        ready: Boolean(shell),
        width: shell ? Number.parseFloat(getComputedStyle(shell).gridTemplateColumns) : 0,
        opacity: label ? Number.parseFloat(getComputedStyle(label).opacity) : null,
        motion
      }
    })
  } catch {
    return { ready: false, width: 0, opacity: null, motion: '' }
  }
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
