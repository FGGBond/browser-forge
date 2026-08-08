import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { createServer } from 'http'
import { readFileSync, statSync } from 'fs'
import { extname, join } from 'path'

let browser
let server
let baseUrl
let savedPrompts
let failNextSave
let delayedSave
const id = '3d4527e4-4d47-4aea-a4ba-cd61218bbd27'
const recording = { id, title: '订单查询', state: 'active', createdAt: '2026-08-08T12:15:00.000Z', durationMs: 42_000, startHost: 'example.com', videoStatus: 'failed', promptStatus: 'empty', sizeBytes: 1024 }
const completePrompt = `请使用 browser-forge skill\n/Users/example/Library/Application Support/Browser Forge/recordings/active/${id}\n查询订单状态`
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

beforeAll(async () => {
  browser = await chromium.launch()
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/api/recordings') return json(res, { recordings: [recording] })
    if (url.pathname === `/api/recordings/${id}`) return json(res, recording)
    if (url.pathname === `/api/recordings/${id}/timeline`) return json(res, { events: [] })
    if (url.pathname === `/api/recordings/${id}/prompt` && req.method === 'GET') return json(res, { text: '', status: 'empty', updatedAt: null })
    if (url.pathname === `/api/recordings/${id}/prompt` && req.method === 'PUT') {
      const body = await readBody(req)
      savedPrompts.push(body.text)
      if (delayedSave) await delayedSave
      if (failNextSave) { failNextSave = false; res.statusCode = 500; return json(res, { error: { code: 'FILESYSTEM_FAILURE', message: 'disk full' } }) }
      return json(res, { text: body.text, status: body.text ? 'draft' : 'empty', updatedAt: '2026-08-08T12:20:00.000Z' })
    }
    if (url.pathname === `/api/recordings/${id}/external-agent-prompt`) return json(res, { recordingId: id, text: completePrompt })
    serveUi(url.pathname, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

afterAll(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)) })

describe('guided prompt editor', () => {
  it('shows the template, saves after 500ms, previews, and copies the derived prompt', async () => {
    savedPrompts = []
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
    const page = await context.newPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await page.getByText('订单查询').click()
    const textarea = page.locator('[data-prompt-textarea]')
    await textarea.waitFor()
    expect(await textarea.inputValue()).toContain('我在这段录制中完成了：')
    expect(await textarea.inputValue()).not.toContain('/Library/Application Support/')

    await textarea.fill('查询订单状态')
    expect(await page.locator('[data-save-state]').textContent()).toContain('未保存')
    await expect.poll(() => savedPrompts).toEqual(['查询订单状态'])
    expect(await page.locator('[data-save-state]').textContent()).toContain('已保存')

    await page.locator('[data-preview-agent-prompt]').click()
    await page.locator('[data-agent-prompt-preview]').waitFor()
    expect(await page.locator('[data-agent-prompt-preview]').textContent()).toBe(completePrompt)
    await page.locator('[data-copy-agent-prompt]').click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(completePrompt)
    await context.close()
  })

  it('persists edits made while an earlier autosave is still in flight', async () => {
    savedPrompts = []
    let releaseSave
    delayedSave = new Promise(resolve => { releaseSave = resolve })
    const page = await browser.newPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await page.getByText('订单查询').click()
    const textarea = page.locator('[data-prompt-textarea]')
    await textarea.fill('第一版指导')
    await expect.poll(() => savedPrompts).toEqual(['第一版指导'])
    await textarea.fill('第二版指导')
    releaseSave()
    delayedSave = null

    await expect.poll(() => savedPrompts).toEqual(['第一版指导', '第二版指导'])
    await expect.poll(() => page.locator('[data-save-state]').textContent()).toContain('已保存')
    expect(await textarea.inputValue()).toBe('第二版指导')
    await page.close()
  })

  it('keeps dirty text and prevents navigation when a flush save fails', async () => {
    savedPrompts = []
    failNextSave = true
    const page = await browser.newPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await page.getByText('订单查询').click()
    const textarea = page.locator('[data-prompt-textarea]')
    await textarea.fill('重要指导')
    await page.getByRole('button', { name: '全部录制' }).click()

    await expect.poll(() => savedPrompts).toEqual(['重要指导'])
    expect(await page.locator('[data-prompt-textarea]').inputValue()).toBe('重要指导')
    await expect.poll(() => page.locator('[data-save-state]').textContent()).toContain('保存失败')
    await page.close()
  })
})

function json(res, value) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)) }
function readBody(req) { return new Promise(resolve => { let body = ''; req.on('data', chunk => { body += chunk }); req.on('end', () => resolve(JSON.parse(body || '{}'))) }) }
function serveUi(pathname, res) { const relative = pathname === '/' ? 'index.html' : pathname.slice(1); const path = join(process.cwd(), 'ui', relative); try { if (!statSync(path).isFile()) throw new Error(); res.setHeader('content-type', contentTypes[extname(path)] || 'application/octet-stream'); res.end(readFileSync(path)) } catch { res.statusCode = 404; res.end('not found') } }
