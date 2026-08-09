import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { createServer } from 'http'
import { readFileSync, statSync } from 'fs'
import { extname, join } from 'path'

let browser
let server
let baseUrl
let requests
let promptDelayMs = 0
let promptShouldFail = false
const id = '3d4527e4-4d47-4aea-a4ba-cd61218bbd27'
const recording = { id, title: '订单查询', state: 'active', createdAt: '2026-08-08T12:15:00.000Z', durationMs: 42_000, startHost: 'example.com', videoStatus: 'complete', promptStatus: 'empty', sizeBytes: 1048576 }
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

beforeAll(async () => {
  browser = await chromium.launch()
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/api/recordings' && req.method === 'GET') return json(res, { recordings: [recording] })
    if (url.pathname === `/api/recordings/${id}` && req.method === 'GET') return json(res, recording)
    if (url.pathname === `/api/recordings/${id}/prompt` && req.method === 'GET') {
      if (promptDelayMs) await new Promise(resolve => setTimeout(resolve, promptDelayMs))
      if (promptShouldFail) { res.statusCode = 500; return json(res, { error: { message: 'prompt failed' } }) }
      return json(res, { text: '', status: 'empty', updatedAt: null })
    }
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

beforeEach(() => {
  requests = []
  promptDelayMs = 0
  promptShouldFail = false
})

afterAll(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)) })

describe('recording detail UI', () => {
  it('defines a responsive workspace column with restrained, reduced-motion-safe content motion', () => {
    const css = readFileSync(join(process.cwd(), 'ui', 'styles.css'), 'utf8')
    const detailSource = readFileSync(join(process.cwd(), 'ui', 'views', 'detail.js'), 'utf8')

    expect(css).toMatch(/\.analysis-workspace\s*\{[^}]*display:grid[^}]*grid-template-columns:minmax\(0,\s*1fr\)\s+0/s)
    expect(css).toMatch(/\.analysis-workspace\.analysis-pane-open\s*\{[^}]*grid-template-columns:minmax\(520px,\s*1fr\)\s+minmax\(360px,\s*390px\)/s)
    expect(css).toMatch(/\.analysis-pane\s*\{[^}]*position:sticky[^}]*top:0[^}]*height:100vh[^}]*overflow:auto/s)
    expect(css).not.toMatch(/\.analysis-pane\s*\{[^}]*(?:position:fixed|position:absolute)/s)
    expect(css).toMatch(/\.analysis-pane-inner\s*\{[^}]*opacity:0[^}]*transform:translateX\(10px\)/s)
    expect(css).toMatch(/\.analysis-workspace\.analysis-pane-open:not\(\.analysis-pane-closing\) \.analysis-pane-inner\s*\{[^}]*opacity:1[^}]*transform:none[^}]*transition:transform 180ms cubic-bezier\(\.2,\.8,\.2,1\),opacity 180ms cubic-bezier\(\.2,\.8,\.2,1\)/s)
    expect(css).toMatch(/\.analysis-workspace\.analysis-pane-closing \.analysis-pane-inner\s*\{[^}]*opacity:0[^}]*transform:translateX\(10px\)[^}]*transition:transform 140ms cubic-bezier\(\.4,0,\.2,1\),opacity 140ms cubic-bezier\(\.4,0,\.2,1\)/s)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[^{]*\{[^}]*\.analysis-pane-inner[^}]*transform:none[^}]*transition-property:opacity[^}]*transition-duration:120ms/s)
    expect(css).not.toContain('.analysis-backdrop')
    expect(css).not.toContain('transition:all')
    expect(detailSource).not.toContain('data-analysis-backdrop')
    expect(detailSource).not.toContain('aria-modal')
    expect(detailSource).not.toContain('role="dialog"')
    expect(detailSource).not.toContain('setBackgroundInert')
    expect(detailSource).not.toContain("document.addEventListener('keydown'")
    expect(detailSource).not.toContain('analysis-pane-header')
    expect(detailSource).not.toContain('recording-analysis-guidance-title')
    expect(detailSource).toContain('aria-label="分析指导"')
    expect(detailSource).toContain('analysis-pane-closing')
    expect(detailSource).toContain('clearTimeout(closeTimer)')
    expect(detailSource).toContain('createPromptControllerProxy')
    expect(detailSource).not.toMatch(/promptController\s*=\s*await renderPromptEditor/)
  })

  it('keeps video controls and guidance editing operable together without modal semantics', async () => {
    const page = await browser.newPage()
    await openDetail(page)

    const video = page.locator('video')
    expect(await video.getAttribute('src')).toBe(`/api/recordings/${id}/video`)
    expect(await video.getAttribute('poster')).toBe(`/api/recordings/${id}/poster`)
    expect(await video.getAttribute('controls')).toBeNull()
    expect(await page.getByText('录制物料', { exact: true }).count()).toBe(0)
    expect(await page.getByText('关键事件', { exact: true }).count()).toBe(0)
    expect(requests.some(item => item.path.endsWith('/timeline'))).toBe(false)
    expect(await page.getByText('Chrome 窗口视频', { exact: true }).count()).toBe(0)
    expect(await page.getByText('支持前后跳转、倍速和全屏。', { exact: true }).count()).toBe(0)
    expect(await page.getByText('视频完整', { exact: true }).count()).toBe(0)
    expect(await page.getByText('00:42', { exact: true }).count()).toBe(0)

    const pane = page.locator('[data-analysis-pane]')
    const toggle = page.locator('[data-toggle-analysis]')
    expect(await toggle.getAttribute('aria-controls')).toBe('recording-analysis-guidance')
    expect(await toggle.getAttribute('aria-expanded')).toBe('false')
    expect(await toggle.getByText('去分析', { exact: true }).count()).toBe(1)
    expect(await pane.getAttribute('id')).toBe('recording-analysis-guidance')
    expect(await pane.getAttribute('aria-label')).toBe('分析指导')
    expect(await pane.getAttribute('hidden')).not.toBeNull()
    expect(await pane.getAttribute('role')).toBeNull()
    expect(await pane.getAttribute('aria-modal')).toBeNull()
    expect(await page.locator('[data-analysis-backdrop]').count()).toBe(0)

    await page.locator('[data-guidance-step-title]').waitFor({ state: 'attached' })
    await toggle.click()
    await pane.waitFor({ state: 'visible' })
    expect(await toggle.getAttribute('aria-expanded')).toBe('true')
    expect(await toggle.getByText('去分析', { exact: true }).count()).toBe(1)
    expect(await pane.getAttribute('hidden')).toBeNull()
    expect(await page.locator('.analysis-main').getAttribute('aria-hidden')).toBeNull()
    expect(await page.locator('[data-sidebar-host]').getAttribute('aria-hidden')).toBeNull()
    expect(await page.locator('.analysis-main').evaluate(element => element.inert)).toBe(false)
    expect(await page.locator('[data-sidebar-host]').evaluate(element => element.inert)).toBe(false)
    expect(await pane.getByText('尚未配置 Agent', { exact: true }).count()).toBe(1)
    expect(await pane.getByText('Analysis session', { exact: true }).count()).toBe(0)
    expect(await pane.getByText('分析会话', { exact: true }).count()).toBe(0)
    expect(await pane.getByText('分析指导', { exact: true }).count()).toBe(0)
    const statusBox = await pane.locator('.guidance-agent-status').boundingBox()
    const closeBox = await pane.locator('[data-close-analysis]').boundingBox()
    expect(Math.abs(closeBox.y - statusBox.y)).toBeLessThanOrEqual(2)
    expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(statusBox.x + statusBox.width)
    await expect.poll(() => page.evaluate(() => document.activeElement?.matches('[data-guidance-step-title]'))).toBe(true)

    const rateButton = page.locator('[data-player-rate]')
    await expect.poll(() => rateButton.isVisible()).toBe(true)
    expect(await rateButton.isEnabled()).toBe(true)
    await rateButton.click()
    expect(await rateButton.textContent()).toBe('1.5×')
    await fillActiveEditor(page, '边看视频边补充分析指导')
    expect(await readActiveEditor(page)).toBe('边看视频边补充分析指导')

    await page.keyboard.press('Escape')
    expect(await toggle.getAttribute('aria-expanded')).toBe('true')
    await page.locator('[data-close-analysis]').click()
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
    expect(await pane.getAttribute('hidden')).toBeNull()
    expect(await page.locator('[data-analysis-workspace]').getAttribute('class')).toContain('analysis-pane-closing')
    await expect.poll(() => page.evaluate(() => document.activeElement?.matches('[data-toggle-analysis]'))).toBe(true)
    await expect.poll(() => pane.getAttribute('hidden')).not.toBeNull()
    expect(await page.locator('[data-analysis-workspace]').getAttribute('class')).not.toContain('analysis-pane-open')
    await page.close()
  })

  it('returns the detail controller before delayed guidance loads so the first navigation click succeeds', async () => {
    promptDelayMs = 900
    const page = await browser.newPage()
    try {
      await page.goto(baseUrl, { waitUntil: 'networkidle' })
      await page.getByRole('button', { name: '去分析', exact: true }).click()
      await page.locator('[data-analysis-workspace]').waitFor()
      await page.locator('[data-back]').click()
      await page.locator('.library-view').waitFor({ timeout: 350 })
      await page.waitForTimeout(950)
      expect(await page.locator('.library-view').count()).toBe(1)
      expect(await page.locator('[data-analysis-workspace]').count()).toBe(0)
      expect(await page.locator('[data-guidance-step-title]').count()).toBe(0)
    } finally {
      await page.close()
    }
  })

  it('allows export and trash actions while guidance initialization is still pending', async () => {
    promptDelayMs = 900
    const page = await browser.newPage()
    try {
      await page.goto(baseUrl, { waitUntil: 'networkidle' })
      await page.getByRole('button', { name: '去分析', exact: true }).click()
      await page.locator('[data-analysis-workspace]').waitFor()
      await page.locator('[data-export]').click()
      await expect.poll(() => requests.some(item => item.path.endsWith('/export')), { timeout: 350 }).toBe(true)
      await page.locator('[data-trash]').click()
      await expect.poll(() => requests.some(item => item.path.endsWith('/trash')), { timeout: 350 }).toBe(true)
      await page.locator('[data-undo-trash]').waitFor()
    } finally {
      await page.close()
    }
  })

  it('does not steal focus when delayed guidance resolves after the user operates video controls', async () => {
    promptDelayMs = 700
    const page = await browser.newPage()
    try {
      await page.goto(baseUrl, { waitUntil: 'networkidle' })
      await page.getByRole('button', { name: '去分析', exact: true }).click()
      const toggle = page.locator('[data-toggle-analysis]')
      await toggle.waitFor()
      await toggle.click()
      const rateButton = page.locator('[data-player-rate]')
      await rateButton.click()
      expect(await rateButton.textContent()).toBe('1.5×')
      await expect.poll(() => page.evaluate(() => document.activeElement?.matches('[data-player-rate]'))).toBe(true)
      await page.locator('[data-guidance-step-title]').waitFor({ state: 'attached', timeout: 2_000 })
      await page.waitForTimeout(50)
      expect(await page.evaluate(() => document.activeElement?.matches('[data-player-rate]'))).toBe(true)
    } finally {
      await page.close()
    }
  })

  it('cancels a pending close when the pane is quickly reopened', async () => {
    const page = await browser.newPage()
    try {
      await openDetail(page)
      await page.locator('[data-guidance-step-title]').waitFor({ state: 'attached' })
      const pane = page.locator('[data-analysis-pane]')
      const toggle = page.locator('[data-toggle-analysis]')
      await toggle.click()
      await page.locator('[data-close-analysis]').click()
      expect(await pane.getAttribute('hidden')).toBeNull()
      expect(await page.locator('[data-analysis-workspace]').getAttribute('class')).toContain('analysis-pane-closing')
      await toggle.click()
      await page.waitForTimeout(220)
      expect(await toggle.getAttribute('aria-expanded')).toBe('true')
      expect(await pane.getAttribute('hidden')).toBeNull()
      const workspaceClass = await page.locator('[data-analysis-workspace]').getAttribute('class')
      expect(workspaceClass).toContain('analysis-pane-open')
      expect(workspaceClass).not.toContain('analysis-pane-closing')
    } finally {
      await page.close()
    }
  })

  it('does not reopen or steal focus when guidance finishes loading after a quick close', async () => {
    promptDelayMs = 800
    const page = await browser.newPage()
    try {
      await page.goto(baseUrl, { waitUntil: 'networkidle' })
      await page.getByRole('button', { name: '去分析', exact: true }).click()
      const pane = page.locator('[data-analysis-pane]')
      const toggle = page.locator('[data-toggle-analysis]')
      await toggle.waitFor()
      await toggle.click()
      expect(await toggle.getAttribute('aria-expanded')).toBe('true')
      await page.locator('[data-close-analysis]').click()
      await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
      await page.locator('[data-guidance-step-title]').waitFor({ state: 'attached', timeout: 2_000 })
      expect(await pane.getAttribute('hidden')).not.toBeNull()
      await expect.poll(() => page.evaluate(() => document.activeElement?.matches('[data-toggle-analysis]'))).toBe(true)
    } finally {
      await page.close()
    }
  })

  it('keeps the video workspace usable when guidance loading fails', async () => {
    promptShouldFail = true
    const page = await browser.newPage()
    try {
      await page.goto(baseUrl, { waitUntil: 'networkidle' })
      await page.getByRole('button', { name: '去分析', exact: true }).click()
      const toggle = page.locator('[data-toggle-analysis]')
      await toggle.waitFor()
      await toggle.click()
      await page.locator('[data-prompt-load-error]').waitFor()
      expect(await page.locator('video').isVisible()).toBe(true)
      expect(await page.locator('[data-player-rate]').isEnabled()).toBe(true)
      expect(await page.locator('[data-prompt-load-error]').textContent()).toContain('无法读取分析指导')
      await page.locator('[data-close-analysis]').click()
      await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
    } finally {
      await page.close()
    }
  })

  it('renames, exports by ID, trashes, and offers undo restore', async () => {
    const page = await browser.newPage()
    await openDetail(page)
    const input = page.locator('[data-title-input]')
    await input.fill('新名称')
    await input.press('Enter')
    await expect.poll(() => requests.some(item => item.method === 'PATCH' && item.body.title === '新名称')).toBe(true)
    await expect.poll(() => page.locator(`[data-recording-nav="${id}"] strong`).textContent()).toBe('新名称')
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

async function openDetail(page) {
  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: '去分析', exact: true }).click()
  await page.locator('[data-analysis-workspace]').waitFor()
}

async function fillActiveEditor(page, value) {
  await page.evaluate(nextValue => {
    const wrapper = document.querySelector('[data-guidance-step] .CodeMirror')
    if (wrapper?.CodeMirror) return wrapper.CodeMirror.setValue(nextValue)
    const textarea = document.querySelector('[data-guidance-step] [data-prompt-textarea]')
    textarea.value = nextValue
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}

async function readActiveEditor(page) {
  return page.evaluate(() => {
    const wrapper = document.querySelector('[data-guidance-step] .CodeMirror')
    if (wrapper?.CodeMirror) return wrapper.CodeMirror.getValue()
    return document.querySelector('[data-guidance-step] [data-prompt-textarea]')?.value ?? ''
  })
}

function json(res, value) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)) }
function readBody(req) { return new Promise(resolve => { let body = ''; req.on('data', chunk => { body += chunk }); req.on('end', () => resolve(body ? JSON.parse(body) : {})) }) }
function serveUi(pathname, res) { const relative = pathname === '/' ? 'index.html' : pathname.slice(1); const path = join(process.cwd(), 'ui', relative); try { if (!statSync(path).isFile()) throw new Error(); res.setHeader('content-type', contentTypes[extname(path)] || 'application/octet-stream'); res.end(readFileSync(path)) } catch { res.statusCode = 404; res.end('not found') } }
