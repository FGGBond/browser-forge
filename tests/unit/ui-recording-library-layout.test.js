import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { createServer } from 'http'
import { readFileSync, statSync } from 'fs'
import { extname, join } from 'path'

let browser
let server
let baseUrl

const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }
const recording = {
  id: 'f4bf0a25-a468-45dc-a006-0f607ade0240',
  title: '查询订单并导出发票',
  state: 'active',
  createdAt: '2026-08-09T09:32:00.000Z',
  durationMs: 163000,
  startHost: 'dongdev.jd.com',
  visitedHosts: ['dongdev.jd.com', 'invoice.jd.com'],
  videoStatus: 'complete',
  promptStatus: 'draft',
  sizeBytes: 1024
}

beforeAll(async () => {
  browser = await chromium.launch()
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/api/recordings') return json(res, { recordings: [recording] })
    if (url.pathname === `/api/recordings/${recording.id}`) return json(res, recording)
    if (url.pathname === `/api/recordings/${recording.id}/prompt`) return json(res, { text: '', status: 'empty', updatedAt: null })
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

describe('recording repository video-first layout', () => {
  it.each([
    { width: 640, height: 760, collapsed: false },
    { width: 640, height: 760, collapsed: true },
    { width: 520, height: 760, collapsed: false },
    { width: 520, height: 760, collapsed: true }
  ])('keeps $width px library and new-recording views inside the viewport when collapsed=$collapsed', async ({ width, height, collapsed }) => {
    const page = await browser.newPage({ viewport: { width, height } })
    await page.addInitScript(value => localStorage.setItem('browser-forge.sidebar-collapsed', String(value)), collapsed)
    await page.goto(baseUrl, { waitUntil: 'networkidle' })

    await expectMobileShell(page, width)
    await page.getByRole('button', { name: '新录制', exact: true }).first().click()
    await page.locator('.goal-composer').waitFor()
    await expectMobileShell(page, width)
    await page.close()
  })

  it.each([
    { width: 1280, height: 800, stacked: false },
    { width: 900, height: 760, stacked: true },
    { width: 640, height: 760, stacked: true },
    { width: 520, height: 760, stacked: true }
  ])('keeps the $width px guidance pane beside or below the video without overlap', async ({ width, height, stacked }) => {
    const page = await browser.newPage({ viewport: { width, height } })
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: '去分析', exact: true }).click()
    await page.locator('[data-toggle-analysis]').click()
    await page.locator('[data-analysis-pane]').waitFor({ state: 'visible' })

    const metrics = await page.evaluate(() => {
      const main = document.querySelector('.analysis-main').getBoundingClientRect()
      const pane = document.querySelector('[data-analysis-pane]').getBoundingClientRect()
      const workspace = document.querySelector('[data-analysis-workspace]')
      return {
        viewportWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        main: { x: main.x, y: main.y, right: main.right, bottom: main.bottom, width: main.width },
        pane: { x: pane.x, y: pane.y, right: pane.right, bottom: pane.bottom, width: pane.width },
        columns: getComputedStyle(workspace).gridTemplateColumns,
        panePosition: getComputedStyle(document.querySelector('[data-analysis-pane]')).position
      }
    })

    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.viewportWidth)
    expect(metrics.pane.right).toBeLessThanOrEqual(metrics.viewportWidth + 1)
    if (stacked) {
      expect(metrics.columns.split(' ')).toHaveLength(1)
      expect(metrics.pane.y).toBeGreaterThanOrEqual(metrics.main.bottom - 1)
      expect(['relative', 'static']).toContain(metrics.panePosition)
    } else {
      expect(metrics.columns.split(' ')).toHaveLength(2)
      expect(metrics.main.width).toBeGreaterThanOrEqual(520)
      expect(metrics.pane.width).toBeGreaterThanOrEqual(360)
      expect(metrics.pane.width).toBeLessThanOrEqual(390)
      expect(metrics.pane.x).toBeGreaterThanOrEqual(metrics.main.right - 1)
      expect(metrics.panePosition).toBe('sticky')
    }
    await page.close()
  })

  it.each([
    { width: 1280, height: 800 },
    { width: 900, height: 700 }
  ])('keeps the $width px card video dominant with compact metadata below it', async viewport => {
    const page = await browser.newPage({ viewport })
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    const row = page.locator('.recording-row').first()
    await row.waitFor()

    const rowBox = await row.boundingBox()
    const videoBox = await row.locator('.repository-video').boundingBox()
    const contentBox = await row.locator('.recording-row-content').boundingBox()

    expect(videoBox.width / rowBox.width).toBeGreaterThan(.95)
    expect(videoBox.y).toBeLessThan(contentBox.y)
    expect(contentBox.height / videoBox.height).toBeLessThan(.35)
    expect(await row.locator('.recording-row-meta').count()).toBe(0)
    expect(await row.getByRole('button', { name: '去分析' }).count()).toBe(1)
    await page.close()
  })
})

async function expectMobileShell(page, width) {
  const metrics = await page.evaluate(() => {
    const shell = document.querySelector('.app-shell')
    const sidebar = document.querySelector('.app-sidebar')
    const recent = document.querySelector('.sidebar-recording-section')
    const toggle = document.querySelector('.sidebar-toggle')
    return {
      viewportWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      shellColumns: getComputedStyle(shell).gridTemplateColumns,
      sidebarWidth: sidebar.getBoundingClientRect().width,
      recentDisplay: getComputedStyle(recent).display,
      toggleWidth: toggle.getBoundingClientRect().width
    }
  })
  expect(metrics.viewportWidth).toBe(width)
  expect(metrics.scrollWidth).toBeLessThanOrEqual(width)
  expect(metrics.shellColumns.split(' ')).toHaveLength(1)
  expect(metrics.sidebarWidth).toBeLessThanOrEqual(width)
  expect(metrics.recentDisplay).toBe('none')
  expect(metrics.toggleWidth).toBeLessThanOrEqual(40)
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
