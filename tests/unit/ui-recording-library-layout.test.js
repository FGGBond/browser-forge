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

  it('does not animate shell or analysis grid column changes', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    const shellTransitions = await page.evaluate(() => {
      const shell = document.querySelector('.app-shell')
      document.querySelector('[data-sidebar-toggle]').click()
      return shell.getAnimations({ subtree: false }).map(animation => animation.transitionProperty)
    })
    expect(shellTransitions).not.toContain('grid-template-columns')

    await page.getByRole('button', { name: '去分析', exact: true }).first().click()
    await page.locator('[data-toggle-analysis]').waitFor()
    const workspaceTransitions = await page.evaluate(() => {
      const workspace = document.querySelector('[data-analysis-workspace]')
      document.querySelector('[data-toggle-analysis]').click()
      return workspace.getAnimations({ subtree: false }).map(animation => animation.transitionProperty)
    })
    expect(workspaceTransitions).not.toContain('grid-template-columns')
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
    await page.getByRole('button', { name: '去分析', exact: true }).first().click()
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
    { width: 900, height: 700 },
    { width: 640, height: 760 },
    { width: 520, height: 760 }
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
    expect(contentBox.height / videoBox.height).toBeLessThan(viewport.width > 640 ? .35 : .5)
    expect(await row.locator('.recording-row-meta').count()).toBe(0)
    expect(await row.getByRole('button', { name: '去分析' }).count()).toBe(1)
    await page.close()
  })

  it('renders complete, partial, and failed cards with the minimal card contract and preserved navigation', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto(baseUrl, { waitUntil: 'networkidle' })

    const rows = page.locator('[data-recording-id]')
    await expect.poll(() => rows.count()).toBe(3)
    for (const recording of recordings) {
      const row = page.locator(`[data-recording-id="${recording.id}"]`)
      const footer = row.locator('.recording-row-content')
      await row.waitFor()
      expect(await row.getAttribute('data-recording-id')).toBe(recording.id)
      expect(await footer.getByRole('heading', { name: recording.title }).count()).toBe(1)
      expect(await footer.locator('time').count()).toBe(1)
      expect(await footer.getByRole('button', { name: '去分析' }).count()).toBe(1)
      expect(await footer.locator('button').count()).toBe(1)
      expect(await footer.locator('p, .recording-row-summary, .status-pill').count()).toBe(0)
      const footerText = await footer.textContent()
      expect(footerText).not.toContain(recording.startHost)
      expect(footerText).not.toContain('02:43')
      expect(footerText).not.toMatch(/视频可用|视频部分可用|分析说明待补充|已有分析说明/)
    }

    for (const playable of recordings.slice(0, 2)) {
      const video = page.locator(`[data-recording-id="${playable.id}"] .repository-video`)
      expect(await video.locator('[data-video-player]').count()).toBe(1)
      expect(await video.locator('.repository-video-placeholder').count()).toBe(0)
    }
    const failedVideo = page.locator(`[data-recording-id="${recordings[2].id}"] .repository-video`)
    expect(await failedVideo.locator('[data-video-player]').count()).toBe(0)
    expect(await failedVideo.locator('.repository-video-placeholder').count()).toBe(1)
    expect(await failedVideo.textContent()).toContain('视频录制失败')

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
