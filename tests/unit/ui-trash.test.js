import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { createServer } from 'http'
import { readFileSync, statSync } from 'fs'
import { extname, join } from 'path'

let browser
let server
let baseUrl
let requests
let deleteShouldFail
let deleted
const id = 'b6789ee6-dd70-4b26-a829-ff551752e745'
const recording = { id, title: '旧的订单录制', state: 'trashed', createdAt: '2026-08-08T12:15:00.000Z', durationMs: 42_000, startHost: 'example.com', videoStatus: 'complete', promptStatus: 'draft', sizeBytes: 2_621_440 }
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

beforeAll(async () => {
  browser = await chromium.launch()
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/api/recordings') return json(res, { recordings: url.searchParams.get('state') === 'trashed' && !deleted ? [recording] : [] })
    if (url.pathname === `/api/recordings/${id}` && req.method === 'GET') return json(res, recording)
    if (url.pathname === `/api/recordings/${id}/restore`) {
      requests.push({ method: req.method, path: url.pathname })
      return json(res, { ...recording, state: 'active' })
    }
    if (url.pathname === `/api/recordings/${id}` && req.method === 'DELETE') {
      requests.push({ method: req.method, path: url.pathname })
      if (deleteShouldFail) return json(res, { error: '磁盘暂时不可写' }, 500)
      deleted = true
      return json(res, { id, deleted: true })
    }
    serveUi(url.pathname, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

afterAll(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)) })

describe('App recycle bin UI', () => {
  it('uses a single management list with poster, metadata, and direct row actions', async () => {
    requests = []
    deleteShouldFail = false
    deleted = false
    const page = await browser.newPage({ viewport: { width: 1180, height: 760 } })
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: '回收站' }).click()
    expect(await page.getByText('Recycle bin', { exact: true }).count()).toBe(0)

    const row = page.locator('[data-trash-row]')
    await row.waitFor()
    expect(await page.locator('.trash-grid, .trash-detail').count()).toBe(0)
    expect(await row.locator('img').getAttribute('src')).toContain(`/api/recordings/${id}/poster`)
    await row.getByRole('heading', { name: '旧的订单录制' }).waitFor()
    expect(await row.textContent()).toContain('example.com')
    expect(await row.textContent()).toContain('2026')
    expect(await row.textContent()).toContain('00:42')
    expect(await row.textContent()).toContain('2.5 MB')
    await row.getByRole('button', { name: '恢复录制' }).waitFor()
    await row.getByRole('button', { name: '永久删除' }).waitFor()
    expect(await page.getByText(/录制物料|关键事件|画面物料/).count()).toBe(0)

    await row.getByRole('button', { name: '恢复录制' }).click()
    await expect.poll(() => requests.some(item => item.path.endsWith('/restore'))).toBe(true)
    await page.close()
  })

  it('allows cancellation and keeps permanent-delete errors visible in the dialog', async () => {
    requests = []
    deleteShouldFail = false
    deleted = false
    const page = await browser.newPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: '回收站' }).click()
    const row = page.locator('[data-trash-row]')
    await row.getByRole('button', { name: '永久删除' }).click()

    let dialog = page.getByRole('dialog')
    await dialog.waitFor()
    expect(await dialog.textContent()).toContain('旧的订单录制')
    expect(await dialog.textContent()).toContain('2.5 MB')
    expect(await dialog.textContent()).toContain('无法撤销')
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect.poll(() => dialog.count()).toBe(0)
    expect(requests.filter(item => item.method === 'DELETE')).toHaveLength(0)

    deleteShouldFail = true
    await row.getByRole('button', { name: '永久删除' }).click()
    dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: '永久删除' }).click()
    await expect.poll(() => dialog.locator('[data-dialog-error]').textContent()).toBe('磁盘暂时不可写')
    expect(await dialog.isVisible()).toBe(true)

    deleteShouldFail = false
    await dialog.getByRole('button', { name: '永久删除' }).click()
    await expect.poll(() => requests.filter(item => item.method === 'DELETE').length).toBe(2)
    await expect.poll(() => dialog.count()).toBe(0)
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('trash-title')
    await page.close()
  })
})

function json(res, value, status = 200) { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)) }
function serveUi(pathname, res) { const relative = pathname === '/' ? 'index.html' : pathname.slice(1); const path = join(process.cwd(), 'ui', relative); try { if (!statSync(path).isFile()) throw new Error(); res.setHeader('content-type', contentTypes[extname(path)] || 'application/octet-stream'); res.end(readFileSync(path)) } catch { res.statusCode = 404; res.end('not found') } }
