import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { createServer } from 'http'
import { readFileSync, statSync } from 'fs'
import { extname, join } from 'path'

let browser
let server
let baseUrl
let requests
const id = '3d4527e4-4d47-4aea-a4ba-cd61218bbd27'
const recording = { id, title: '订单查询', state: 'active', createdAt: '2026-08-08T12:15:00.000Z', durationMs: 42_000, startHost: 'example.com', videoStatus: 'complete', promptStatus: 'empty', sizeBytes: 1048576 }
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

beforeAll(async () => {
  browser = await chromium.launch()
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/api/recordings' && req.method === 'GET') return json(res, { recordings: [recording] })
    if (url.pathname === `/api/recordings/${id}` && req.method === 'GET') return json(res, recording)
    if (url.pathname === `/api/recordings/${id}/prompt` && req.method === 'GET') return json(res, { text: '', status: 'empty', updatedAt: null })
    if (url.pathname === `/api/recordings/${id}/prompt` && req.method === 'PUT') { const body = await readBody(req); requests.push({ method: req.method, path: url.pathname, body }); return json(res, { text: body.text, status: body.text ? 'draft' : 'empty', updatedAt: '2026-08-08T12:20:00.000Z' }) }
    if (url.pathname === `/api/recordings/${id}/external-agent-prompt`) return json(res, { recordingId: id, text: 'complete prompt' })
    if (url.pathname === `/api/recordings/${id}/timeline`) { requests.push({ method: 'GET', path: url.pathname }); return json(res, { events: [
      { type: 'click', label: '提交', videoOffsetMs: 12_345, timestamp: Date.parse(recording.createdAt) + 12_345 },
      { type: 'click', label: '超出视频', videoOffsetMs: 50_000 },
      { type: 'navigation', label: '无关联画面' }
    ] }) }
    if ([`/api/recordings/${id}`, `/api/recordings/${id}/export`, `/api/recordings/${id}/trash`, `/api/recordings/${id}/restore`].includes(url.pathname)) {
      const body = await readBody(req)
      requests.push({ method: req.method, path: url.pathname, body })
      if (req.method === 'PATCH') return json(res, { ...recording, title: body.title })
      if (url.pathname.endsWith('/export')) return json(res, { path: '/Users/example/Desktop/订单查询' })
      if (url.pathname.endsWith('/trash')) return json(res, { ...recording, state: 'trashed' })
      if (url.pathname.endsWith('/restore')) return json(res, recording)
    }
    if (url.pathname === '/api/chrome-path') return json(res, { path: '/Applications/Google Chrome.app' })
    serveUi(url.pathname, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

afterAll(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)) })

describe('recording detail UI', () => {
  it('shows a private video workspace and collapsible Agent-ready analysis pane without internal materials', async () => {
    requests = []
    const page = await browser.newPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await page.locator('[data-recording-id]').click()
    const video = page.locator('video')
    await video.waitFor()
    expect(await video.getAttribute('src')).toBe(`/api/recordings/${id}/video`)
    expect(await video.getAttribute('poster')).toBe(`/api/recordings/${id}/poster`)
    expect(await video.getAttribute('controls')).toBeNull()
    expect(await page.getByText('录制物料', { exact: true }).count()).toBe(0)
    expect(await page.getByText('关键事件', { exact: true }).count()).toBe(0)
    expect(requests.some(item => item.path.endsWith('/timeline'))).toBe(false)
    const pane = page.locator('[data-analysis-pane]')
    await pane.waitFor()
    expect(await pane.getByText('Agent 尚未配置', { exact: true }).count()).toBe(1)
    expect(await page.locator('[data-prompt-textarea]').count()).toBe(1)
    await page.locator('[data-close-analysis]').click()
    expect(await pane.isHidden()).toBe(true)
    await page.locator('[data-toggle-analysis]').click()
    expect(await pane.isVisible()).toBe(true)
    await page.close()
  })

  it('renames, exports by ID, trashes, and offers undo restore', async () => {
    requests = []
    const page = await browser.newPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await page.locator('[data-recording-id]').click()
    const input = page.locator('[data-title-input]')
    await input.fill('新名称')
    await input.press('Enter')
    await expect.poll(() => requests.some(item => item.method === 'PATCH' && item.body.title === '新名称')).toBe(true)
    await input.fill('不保存')
    await input.press('Escape')
    expect(await input.inputValue()).toBe('新名称')

    await page.locator('[data-export]').click()
    await expect.poll(() => requests.some(item => item.path.endsWith('/export'))).toBe(true)
    await page.locator('[data-trash]').click()
    await page.locator('[data-undo-trash]').waitFor()
    await page.locator('[data-undo-trash]').click()
    await expect.poll(() => requests.some(item => item.path.endsWith('/restore'))).toBe(true)
    expect(requests.find(item => item.path.endsWith('/export')).body).not.toHaveProperty('destination')
    await page.close()
  })
})

function json(res, value) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)) }
function readBody(req) { return new Promise(resolve => { let body = ''; req.on('data', chunk => { body += chunk }); req.on('end', () => resolve(body ? JSON.parse(body) : {})) }) }
function serveUi(pathname, res) { const relative = pathname === '/' ? 'index.html' : pathname.slice(1); const path = join(process.cwd(), 'ui', relative); try { if (!statSync(path).isFile()) throw new Error(); res.setHeader('content-type', contentTypes[extname(path)] || 'application/octet-stream'); res.end(readFileSync(path)) } catch { res.statusCode = 404; res.end('not found') } }
