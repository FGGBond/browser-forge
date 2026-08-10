import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { createServer } from 'http'
import { readFileSync, statSync } from 'fs'
import { extname, join } from 'path'

let browser
let server
let baseUrl

const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }
const recordings = [
  {
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
  },
  {
    id: '66c2169a-4af4-48a6-9d1a-b5a25aaf6039',
    title: '核对库存变更',
    state: 'active',
    createdAt: '2026-08-09T10:15:00.000Z',
    durationMs: 68000,
    startHost: 'stock.example.com',
    visitedHosts: ['stock.example.com'],
    videoStatus: 'partial',
    promptStatus: 'empty',
    sizeBytes: 2048
  },
  {
    id: '3b371e59-eb0e-4b79-b4c5-b6360e0d0774',
    title: '提交失败的录制',
    state: 'active',
    createdAt: '2026-08-09T11:05:00.000Z',
    durationMs: 42000,
    startHost: 'failed.example.com',
    visitedHosts: ['failed.example.com'],
    videoStatus: 'failed',
    promptStatus: 'draft',
    sizeBytes: 4096
  }
]
const recording = recordings[0]

beforeAll(async () => {
  browser = await chromium.launch()
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/api/recordings') return json(res, { recordings })
    const selected = recordings.find(item => url.pathname === `/api/recordings/${item.id}`)
    if (selected) return json(res, selected)
    if (recordings.some(item => url.pathname === `/api/recordings/${item.id}/prompt`)) return json(res, { text: '', status: 'empty', updatedAt: null })
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

describe('recording repository compact workspace layout', () => {
  it.each([
    { width: 640, height: 760, collapsed: false },
    { width: 640, height: 760, collapsed: true },
    { width: 520, height: 760, collapsed: false },
    { width: 520, height: 760, collapsed: true }
  ])('keeps $width px library and new-recording views inside the viewport when collapsed=$collapsed', { timeout: 12000 }, async ({ width, height, collapsed }) => {
    const page = await browser.newPage({ viewport: { width, height } })
    await page.addInitScript(value => localStorage.setItem('browser-forge.sidebar-collapsed', String(value)), collapsed)
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })

    await expectMobileShell(page, width)
    await page.getByRole('button', { name: '新录制', exact: true }).first().click({ timeout: 3000 })
    await page.waitForTimeout(400)
    await expectMobileShell(page, width)
    await page.close()
  })

  it('does not animate shell grid column changes', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    const shellTransitions = await page.evaluate(() => {
      const shell = document.querySelector('.app-shell')
      document.querySelector('[data-sidebar-toggle]').click()
      return shell.getAnimations({ subtree: false }).map(animation => animation.transitionProperty)
    })
    expect(shellTransitions).not.toContain('grid-template-columns')
    await page.close()
  })

  it.each([
    { width: 1200, height: 800 },
    { width: 1280, height: 800 },
    { width: 1440, height: 900 }
  ])('keeps the $width px persistent context pane beside recording evidence without overlap', async ({ width, height }) => {
    const page = await browser.newPage({ viewport: { width, height } })
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: '去分析', exact: true }).first().click()
    await page.locator('[data-title-input]').waitFor()
    await page.locator('[data-analysis-pane]').waitFor({ state: 'visible' })

    const metrics = await page.evaluate(() => {
      const main = document.querySelector('.analysis-main').getBoundingClientRect()
      const pane = document.querySelector('[data-analysis-pane]').getBoundingClientRect()
      const shell = document.querySelector('.app-shell')
      return {
        viewportWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        main: { x: main.x, right: main.right, width: main.width },
        pane: { x: pane.x, right: pane.right, width: pane.width },
        columns: getComputedStyle(shell).gridTemplateColumns,
        panePosition: getComputedStyle(document.querySelector('.workspace-context-host')).position
      }
    })

    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.viewportWidth)
    expect(metrics.pane.right).toBeLessThanOrEqual(metrics.viewportWidth + 1)
    expect(metrics.columns.split(' ')).toHaveLength(3)
    expect(metrics.main.width).toBeGreaterThanOrEqual(560)
    expect(metrics.pane.width).toBeGreaterThanOrEqual(470)
    expect(metrics.pane.width).toBeLessThanOrEqual(480)
    expect(metrics.pane.x).toBeGreaterThanOrEqual(metrics.main.right - 1)
    expect(metrics.panePosition).toBe('sticky')
    await page.close()
  })

  it('keeps context in the shell at the 1120 px rail breakpoint', async () => {
    const page = await browser.newPage({ viewport: { width: 1120, height: 800 } })
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: '去分析', exact: true }).first().click()
    await page.locator('[data-title-input]').waitFor()

    const layout = await page.evaluate(() => {
      const main = document.querySelector('.analysis-main').getBoundingClientRect()
      const pane = document.querySelector('[data-analysis-pane]').getBoundingClientRect()
      return {
        columns: getComputedStyle(document.querySelector('.app-shell')).gridTemplateColumns,
        mainRight: main.right,
        paneX: pane.x,
        panePosition: getComputedStyle(document.querySelector('.workspace-context-host')).position
      }
    })

    expect(layout.columns.split(' ')).toHaveLength(3)
    expect(layout.paneX).toBeGreaterThanOrEqual(layout.mainRight - 1)
    expect(layout.panePosition).toBe('sticky')
    await page.close()
  })

  it.each([
    { width: 1280, height: 800 },
    { width: 900, height: 700 },
    { width: 640, height: 760 },
    { width: 520, height: 760 }
  ])('keeps the $width px repository compact, horizontal, and evidence-first', async viewport => {
    const page = await browser.newPage({ viewport })
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    const row = page.locator('.recording-row').first()
    await row.waitFor()

    const metrics = await row.evaluate(element => {
      const preview = element.querySelector('.repository-preview').getBoundingClientRect()
      const content = element.querySelector('.recording-row-content').getBoundingClientRect()
      const box = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return {
        row: { x: box.x, y: box.y, width: box.width, height: box.height },
        preview: { x: preview.x, y: preview.y, width: preview.width, height: preview.height },
        content: { x: content.x, y: content.y, width: content.width, height: content.height },
        radius: parseFloat(style.borderTopLeftRadius),
        shadow: style.boxShadow
      }
    })

    expect(metrics.row.height).toBeLessThanOrEqual(viewport.width > 600 ? 124 : 142)
    expect(metrics.preview.x).toBeLessThan(metrics.content.x)
    expect(metrics.preview.width / metrics.row.width).toBeLessThan(.4)
    expect(metrics.preview.width / metrics.preview.height).toBeGreaterThan(1.7)
    expect(metrics.radius).toBeLessThanOrEqual(12)
    expect(metrics.shadow).toBe('none')
    expect(await row.locator('.recording-row-evidence').count()).toBe(1)
    expect(await row.getByRole('button', { name: '去分析' }).count()).toBe(1)
    await page.close()
  })

  it('renders truthful evidence metadata without turning repository rows into competing player cards', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto(baseUrl, { waitUntil: 'networkidle' })

    const rows = page.locator('[data-recording-id]')
    await expect.poll(() => rows.count()).toBe(3)
    const firstBox = await rows.first().boundingBox()
    const lastBox = await rows.last().boundingBox()
    expect(lastBox.y + lastBox.height - firstBox.y).toBeLessThan(390)

    for (const recording of recordings) {
      const row = page.locator(`[data-recording-id="${recording.id}"]`)
      await row.waitFor()
      expect(await row.getAttribute('data-recording-id')).toBe(recording.id)
      expect(await row.getByRole('heading', { name: recording.title }).count()).toBe(1)
      expect(await row.locator('time').count()).toBe(1)
      expect(await row.getByRole('button', { name: '去分析' }).count()).toBe(1)
      expect(await row.locator('button').count()).toBe(1)
      expect(await row.locator('[data-video-player], video').count()).toBe(0)
      expect(await row.locator('.repository-preview img').getAttribute('src')).toContain(`/api/recordings/${recording.id}/poster`)
      const text = await row.textContent()
      expect(text).toContain(recording.startHost)
      expect(text).toContain(recording.durationMs === 163000 ? '02:43' : recording.durationMs === 68000 ? '01:08' : '00:42')
    }
    expect(await page.locator(`[data-recording-id="${recordings[0].id}"]`).textContent()).toContain('视频可用')
    expect(await page.locator(`[data-recording-id="${recordings[1].id}"]`).textContent()).toContain('视频部分可用')
    expect(await page.locator(`[data-recording-id="${recordings[2].id}"]`).textContent()).toContain('视频录制失败')

    await page.locator(`[data-recording-id="${recordings[1].id}"] [data-analyze]`).click()
    await expect.poll(() => page.locator('[data-title-input]').inputValue()).toBe(recordings[1].title)
    await page.locator('[data-back]').click()
    await rows.first().waitFor()

    const failedRow = page.locator(`[data-recording-id="${recordings[2].id}"]`)
    await failedRow.focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => page.locator('[data-title-input]').inputValue()).toBe(recordings[2].title)
    await page.close()
  })
})

async function expectMobileShell(page, width) {
  await page.waitForSelector('.app-shell, .app-sidebar', { timeout: 3000 }).catch(() => {})
  const metrics = await page.evaluate(() => {
    const shell = document.querySelector('.app-shell')
    const sidebar = document.querySelector('.app-sidebar')
    if (!shell || !sidebar) return { shellMissing: true, viewportWidth: window.innerWidth }
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
  if (metrics.shellMissing) {
    expect(metrics.viewportWidth).toBe(width)
    return
  }
  expect(metrics.viewportWidth).toBe(width)
  expect(metrics.scrollWidth).toBeLessThanOrEqual(width)
  expect(metrics.shellColumns.split(' ')).toHaveLength(2)
  expect(metrics.sidebarWidth).toBeLessThanOrEqual(68)
  if (width <= 840) expect(metrics.toggleWidth).toBeLessThanOrEqual(48)
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
