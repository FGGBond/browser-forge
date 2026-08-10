import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { createServer } from 'http'
import { readFileSync, statSync } from 'fs'
import { extname, join } from 'path'

let browser
let server
let baseUrl
let recordings
let listShouldFail
let detailFailuresRemaining
let promptRequests
const older = { id: 'older-recording', title: '较早录制', state: 'active', createdAt: '2026-08-08T10:00:00.000Z', durationMs: 10_000, startHost: 'older.example.com', visitedHosts: ['older.example.com'], videoStatus: 'failed', promptStatus: 'empty', sizeBytes: 10 }
const recent = { ...older, id: 'recent-recording', title: '最近录制', createdAt: '2026-08-10T10:00:00.000Z', startHost: 'recent.example.com', visitedHosts: ['recent.example.com'] }
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

beforeAll(async () => {
  browser = await chromium.launch()
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/api/recordings' && req.method === 'GET') {
      if (listShouldFail) { res.statusCode = 500; return json(res, { error: { message: 'library unavailable' } }) }
      return json(res, { recordings })
    }
    const detail = recordings.find(recording => url.pathname === `/api/recordings/${recording.id}`)
    if (detail && req.method === 'GET') {
      if (detailFailuresRemaining > 0) { detailFailuresRemaining -= 1; res.statusCode = 500; return json(res, { error: { message: 'detail unavailable' } }) }
      return json(res, detail)
    }
    const prompt = recordings.find(recording => url.pathname === `/api/recordings/${recording.id}/prompt`)
    if (prompt && req.method === 'GET') {
      promptRequests.push(prompt.id)
      return json(res, { text: '', status: 'empty', updatedAt: null })
    }
    if (recordings.some(recording => url.pathname === `/api/recordings/${recording.id}/timeline`)) return json(res, { events: [] })
    if (url.pathname === '/api/chrome-path') return json(res, { path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
    if (url.pathname === '/api/screen-recording-permission') return json(res, { supported: true, granted: true, status: 'granted' })
    serveUi(url.pathname, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

beforeEach(() => {
  recordings = [older, recent]
  listShouldFail = false
  detailFailuresRemaining = 0
  promptRequests = []
})

afterAll(async () => {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
})

describe('workspace bootstrap', () => {
  it('restores the most recent recording across center, sidebar, and context', async () => {
    const page = await browser.newPage()
    try {
      await page.goto(baseUrl, { waitUntil: 'networkidle' })

      expect(await page.locator('[data-title-input]').inputValue()).toBe(recent.title)
      expect(await page.locator(`[data-recording-nav="${recent.id}"]`).getAttribute('aria-current')).toBe('page')
      expect(await page.locator('[data-context-host]').getAttribute('data-context-recording-id')).toBe(recent.id)
      expect(promptRequests.at(-1)).toBe(recent.id)
    } finally {
      await page.close()
    }
  })

  it('opens the focused prepare surface when the active library is empty', async () => {
    recordings = []
    const page = await browser.newPage()
    try {
      await page.goto(baseUrl, { waitUntil: 'networkidle' })

      await page.getByRole('heading', { name: '准备录制' }).waitFor()
      expect(await page.locator('.new-recording-view').count()).toBe(1)
      expect(await page.locator('[data-context-placeholder]').textContent()).toContain('开始录制后')
    } finally {
      await page.close()
    }
  })

  it('shows startup retry when the most recent detail fails and restores the same recording after retry', async () => {
    detailFailuresRemaining = 1
    const page = await browser.newPage()
    try {
      await page.goto(baseUrl, { waitUntil: 'networkidle' })

      const error = page.locator('[data-bootstrap-error]')
      await error.waitFor()
      expect(await error.textContent()).toContain('detail unavailable')
      expect(await page.locator('[data-title-input]').count()).toBe(0)
      expect(await page.locator('[data-context-placeholder]').textContent()).toContain('工作区内容读取失败')

      await error.getByRole('button', { name: '重试' }).click()
      await page.locator('[data-title-input]').waitFor()
      expect(await page.locator('[data-title-input]').inputValue()).toBe(recent.title)
      expect(await page.locator(`[data-recording-nav="${recent.id}"]`).getAttribute('aria-current')).toBe('page')
      expect(await page.locator('[data-context-host]').getAttribute('data-context-recording-id')).toBe(recent.id)
    } finally {
      await page.close()
    }
  })

  it('shows a retryable startup error instead of treating a failed library request as empty', async () => {
    listShouldFail = true
    const page = await browser.newPage()
    try {
      await page.goto(baseUrl, { waitUntil: 'networkidle' })

      const error = page.locator('[data-bootstrap-error]')
      await error.waitFor()
      expect(await error.textContent()).toContain('library unavailable')
      expect(await page.locator('.new-recording-view').count()).toBe(0)

      listShouldFail = false
      await error.getByRole('button', { name: '重试' }).click()
      await page.locator('[data-title-input]').waitFor()
      expect(await page.locator('[data-title-input]').inputValue()).toBe(recent.title)
    } finally {
      await page.close()
    }
  })
})

function json(res, value) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)) }
function serveUi(pathname, res) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1)
  const path = join(process.cwd(), 'ui', relative)
  try {
    if (!statSync(path).isFile()) throw new Error()
    res.setHeader('content-type', contentTypes[extname(path)] || 'application/octet-stream')
    res.end(readFileSync(path))
  } catch {
    res.statusCode = 404
    res.end('not found')
  }
}
