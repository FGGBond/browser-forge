import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { createServer } from 'http'
import { readFileSync, statSync } from 'fs'
import { extname, join } from 'path'

let browser
let server
let baseUrl
let requests
const id = 'b6789ee6-dd70-4b26-a829-ff551752e745'
const recording = { id, title: '旧的订单录制', state: 'trashed', createdAt: '2026-08-08T12:15:00.000Z', durationMs: 42_000, startHost: 'example.com', videoStatus: 'complete', promptStatus: 'draft', sizeBytes: 2_621_440 }
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

beforeAll(async () => {
  browser = await chromium.launch()
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/api/recordings') return json(res, { recordings: url.searchParams.get('state') === 'trashed' ? [recording] : [] })
    if (url.pathname === `/api/recordings/${id}` && req.method === 'GET') return json(res, recording)
    if (url.pathname === `/api/recordings/${id}/restore` || (url.pathname === `/api/recordings/${id}` && req.method === 'DELETE')) {
      requests.push({ method: req.method, path: url.pathname })
      return json(res, req.method === 'DELETE' ? { id, deleted: true } : { ...recording, state: 'active' })
    }
    serveUi(url.pathname, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

afterAll(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)) })

describe('App recycle bin UI', () => {
  it('restores material and permanently deletes only after title-and-size confirmation', async () => {
    requests = []
    const page = await browser.newPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: '回收站' }).click()
    await page.getByText('旧的订单录制').click()
    expect(await page.locator('[data-copy-agent-prompt]').count()).toBe(0)
    await page.getByText('2.5 MB').waitFor()
    expect(await page.getByText('2.5 MB').count()).toBeGreaterThan(0)

    await page.locator('[data-restore]').click()
    await expect.poll(() => requests.some(item => item.path.endsWith('/restore'))).toBe(true)

    await page.getByRole('button', { name: '回收站' }).click()
    await page.getByText('旧的订单录制').click()
    await page.locator('[data-delete-permanently]').click()
    const dialog = page.locator('[data-delete-dialog]')
    await dialog.waitFor()
    expect(await dialog.textContent()).toContain('旧的订单录制')
    expect(await dialog.textContent()).toContain('2.5 MB')
    await dialog.locator('[data-confirm-delete]').click()
    await expect.poll(() => requests.some(item => item.method === 'DELETE')).toBe(true)
    await page.close()
  })
})

function json(res, value) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)) }
function serveUi(pathname, res) { const relative = pathname === '/' ? 'index.html' : pathname.slice(1); const path = join(process.cwd(), 'ui', relative); try { if (!statSync(path).isFile()) throw new Error(); res.setHeader('content-type', contentTypes[extname(path)] || 'application/octet-stream'); res.end(readFileSync(path)) } catch { res.statusCode = 404; res.end('not found') } }
