import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { createServer } from 'http'
import { readFileSync, statSync } from 'fs'
import { extname, join } from 'path'
import { serializeGuidanceMarkdown } from '../../ui/guidance-format.js'

let browser
let server
let baseUrl
let requests
let promptDelayMs = 0
let promptShouldFail = false
let promptText = ''
let promptSaveDelayMs = 0
let promptSaveShouldFail = false
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
      return json(res, { text: promptText, status: promptText ? 'draft' : 'empty', updatedAt: promptText ? '2026-08-08T12:20:00.000Z' : null })
    }
    if (url.pathname === `/api/recordings/${id}/prompt` && req.method === 'PUT') { const body = await readBody(req); requests.push({ method: req.method, path: url.pathname, body }); if (promptSaveDelayMs) await new Promise(resolve => setTimeout(resolve, promptSaveDelayMs)); if (promptSaveShouldFail) { res.statusCode = 500; return json(res, { error: { message: 'disk full' } }) }; promptText = body.text; return json(res, { text: body.text, status: body.text ? 'draft' : 'empty', updatedAt: '2026-08-08T12:20:00.000Z' }) }
    if (url.pathname === `/api/recordings/${id}/external-agent-prompt`) return json(res, { recordingId: id, text: 'complete prompt' })
    if (url.pathname === `/api/recordings/${id}/agent-handoff` && req.method === 'POST') { requests.push({ method: 'POST', path: url.pathname }); return json(res, { recordingId: id, text: 'complete prompt', path: '/Users/example/Desktop/订单查询' }) }
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
  promptText = ''
  promptSaveDelayMs = 0
  promptSaveShouldFail = false
})

afterAll(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)) })

async function newIsolatedPage() {
  const context = await browser.newContext()
  await context.addInitScript(() => {
    try {
      localStorage.removeItem('browser-forge.sidebar-collapsed')
      localStorage.removeItem('browser-forge.sidebar-width')
      localStorage.removeItem('browser-forge.analysis-pane-width')
    } catch {}
  })
  const page = await context.newPage()
  const originalClose = page.close.bind(page)
  page.close = async () => { await originalClose().catch(() => {}); await context.close().catch(() => {}) }
  return page
}

describe('recording detail UI', () => {
  it('defines a responsive workspace column with restrained, reduced-motion-safe content motion', () => {
    const css = readFileSync(join(process.cwd(), 'ui', 'styles.css'), 'utf8')
    const detailSource = readFileSync(join(process.cwd(), 'ui', 'views', 'detail.js'), 'utf8')

    expect(css).toMatch(/\.analysis-workspace\s*\{[^}]*display:grid[^}]*grid-template-columns:minmax\(560px,\s*1fr\)\s+0/s)
    expect(css).toMatch(/\.analysis-workspace\.analysis-pane-open\s*\{[^}]*grid-template-columns:minmax\(560px,\s*1fr\)\s+var\(--pane-w\)/s)
    expect(css).toMatch(/\.sidebar-resize-handle,\s*\n\.pane-resize-handle\s*\{[^}]*cursor:\s*col-resize/s)
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
    const page = await newIsolatedPage()
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

    await page.locator('[data-guidance-editor-surface]').waitFor({ state: 'attached' })
    await toggle.click()
    await pane.waitFor({ state: 'visible' })
    const questionStyle = await pane.locator('[data-guidance-question-title]').evaluate(element => {
      const style = getComputedStyle(element)
      return { outlineStyle: style.outlineStyle, tabIndex: element.getAttribute('tabindex') }
    })
    expect(questionStyle).toEqual({ outlineStyle: 'none', tabIndex: null })
    expect(await toggle.getAttribute('aria-expanded')).toBe('true')
    expect(await toggle.getByText('去分析', { exact: true }).count()).toBe(1)
    expect(await pane.getAttribute('hidden')).toBeNull()
    expect(await page.locator('.analysis-main').getAttribute('aria-hidden')).toBeNull()
    expect(await page.locator('[data-sidebar-host]').getAttribute('aria-hidden')).toBeNull()
    expect(await page.locator('.analysis-main').evaluate(element => element.inert)).toBe(false)
    expect(await page.locator('[data-sidebar-host]').evaluate(element => element.inert)).toBe(false)
    expect(await pane.getByText('尚未配置 Agent', { exact: true }).count()).toBe(0)
    expect(await pane.getByText('Analysis session', { exact: true }).count()).toBe(0)
    expect(await pane.getByText('分析会话', { exact: true }).count()).toBe(0)
    expect(await pane.getByText('分析指导', { exact: true }).count()).toBe(0)
    const progressStyle = await pane.locator('[data-guidance-progress]').evaluate(element => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return { fontSize: Number.parseFloat(style.fontSize), height: rect.height, left: rect.left, top: rect.top, width: rect.width, position: style.position }
    })
    const paneBox = await pane.boundingBox()
    const composerBox = await pane.locator('[data-guidance-composer]').boundingBox()
    const closeBox = await pane.locator('[data-close-analysis]').boundingBox()
    // 吸附胶囊:悬浮在输入卡片上方,水平居中于卡片,底部紧贴卡片顶
    expect(progressStyle.position).toBe('absolute')
    expect(progressStyle.fontSize).toBeGreaterThanOrEqual(12)
    expect(progressStyle.height).toBeGreaterThanOrEqual(28)
    expect(progressStyle.left).toBeGreaterThanOrEqual(composerBox.x)
    expect(progressStyle.left + progressStyle.width).toBeLessThanOrEqual(composerBox.x + composerBox.width)
    expect(Math.abs(
      (progressStyle.left + progressStyle.width / 2) -
      (composerBox.x + composerBox.width / 2)
    )).toBeLessThanOrEqual(3)
    const gap = composerBox.y - (progressStyle.top + progressStyle.height)
    expect(gap).toBeGreaterThan(2)
    expect(gap).toBeLessThan(24)
    expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(paneBox.x + paneBox.width)
    const headerLayout = await page.locator('.analysis-main .detail-header').evaluate(element => {
      const title = element.querySelector('.detail-title-input')
      return { flexDirection: getComputedStyle(element).flexDirection, titleWidth: title.getBoundingClientRect().width }
    })
    expect(headerLayout).toMatchObject({ flexDirection: 'column' })
    expect(headerLayout.titleWidth).toBeGreaterThanOrEqual(400)
    await expect.poll(() => page.evaluate(() => document.activeElement?.matches('[data-guidance-editor-surface]'))).toBe(true)

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

  it('shows submitted answers as chat bubbles and keeps the next question focused when the hidden pane becomes visible', async () => {
    promptText = serializeGuidanceMarkdown({ actions: '打开订单并读取物流状态', capability: '', acceptance: '' })
    const page = await newIsolatedPage()
    try {
      await openDetail(page)
      await page.locator('[data-toggle-analysis]').click()
      await page.locator('[data-analysis-pane]').waitFor({ state: 'visible' })

      // 已回答的第 1 问以气泡形式保留
      const bubble = page.locator('[data-chat-item="actions"] .guidance-chat-text')
      await bubble.waitFor({ state: 'visible' })
      expect(await bubble.textContent()).toContain('打开订单并读取物流状态')
      // 气泡右下角有铅笔编辑入口
      expect(await page.locator('[data-chat-item="actions"] [data-edit-answer="actions"]').count()).toBe(1)

      // 当前进度指向第 2 个问题,吸附胶囊显示 2 / 3
      await expect.poll(() => page.locator('[data-guidance-progress-text]').textContent()).toBe('第 2 / 3 个问题')
      const title = await page.locator('[data-guidance-question-title]').textContent()
      expect(title).toContain('希望把这段操作变成什么能力')

      const surface = page.locator('[data-guidance-editor-surface]')
      await surface.waitFor({ state: 'visible' })
      expect((await surface.boundingBox()).height).toBeGreaterThan(0)
      await expect.poll(() => page.evaluate(() => document.activeElement?.matches('[data-guidance-editor-surface]'))).toBe(true)
    } finally {
      await page.close()
    }
  })

  it('returns the detail controller before delayed guidance loads so the first navigation click succeeds', async () => {
    promptDelayMs = 900
    const page = await newIsolatedPage()
    try {
      await page.goto(baseUrl, { waitUntil: 'networkidle' })
      await page.getByRole('button', { name: '去分析', exact: true }).click()
      await page.locator('[data-analysis-workspace]').waitFor()
      await page.locator('[data-back]').click()
      await page.locator('.library-view').waitFor({ timeout: 350 })
      await page.waitForTimeout(950)
      expect(await page.locator('.library-view').count()).toBe(1)
      expect(await page.locator('[data-analysis-workspace]').count()).toBe(0)
      expect(await page.locator('[data-guidance-question-title]').count()).toBe(0)
    } finally {
      await page.close()
    }
  })

  it('allows export and trash actions while guidance initialization is still pending', async () => {
    promptDelayMs = 900
    const page = await newIsolatedPage()
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
    const page = await newIsolatedPage()
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
      await page.locator('[data-guidance-editor-surface]').waitFor({ state: 'attached', timeout: 2_000 })
      await page.waitForTimeout(50)
      expect(await page.evaluate(() => document.activeElement?.matches('[data-player-rate]'))).toBe(true)
    } finally {
      await page.close()
    }
  })

  it('flushes immediately before closing the pane and keeps it open when saving fails', async () => {
    promptSaveDelayMs = 260
    const page = await newIsolatedPage()
    try {
      await openDetail(page)
      await page.locator('[data-guidance-editor-surface]').waitFor({ state: 'attached' })
      await page.locator('[data-toggle-analysis]').click()
      await fillActiveEditor(page, '关闭分析栏前必须保存')
      await page.locator('[data-close-analysis]').click()

      await expect.poll(() => requests.some(item => item.method === 'PUT'), { timeout: 180, interval: 10 }).toBe(true)
      expect(await page.locator('[data-toggle-analysis]').getAttribute('aria-expanded')).toBe('true')
      expect(await page.locator('[data-analysis-pane]').getAttribute('hidden')).toBeNull()
      expect(await page.locator('[data-close-analysis]').isDisabled()).toBe(true)
      expect(await page.locator('[data-toggle-analysis]').isDisabled()).toBe(true)
      await expect.poll(() => page.locator('[data-toggle-analysis]').getAttribute('aria-expanded')).toBe('false')

      await page.locator('[data-toggle-analysis]').click()
      await fillActiveEditor(page, '保存失败时分析栏必须保持打开')
      promptSaveShouldFail = true
      await page.locator('[data-toggle-analysis]').click()
      await page.locator('[data-save-error]').waitFor()
      expect(await page.locator('[data-toggle-analysis]').getAttribute('aria-expanded')).toBe('true')
      expect(await page.locator('[data-analysis-pane]').getAttribute('hidden')).toBeNull()
      expect(await page.locator('[data-analysis-workspace]').getAttribute('class')).not.toContain('analysis-pane-closing')
    } finally {
      await page.close()
    }
  }, 8_000)

  it('cancels a pending close when the pane is quickly reopened', async () => {
    const page = await newIsolatedPage()
    try {
      await openDetail(page)
      await page.locator('[data-guidance-editor-surface]').waitFor({ state: 'attached' })
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
    const page = await newIsolatedPage()
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
      await page.locator('[data-guidance-editor-surface]').waitFor({ state: 'attached', timeout: 2_000 })
      expect(await pane.getAttribute('hidden')).not.toBeNull()
      await expect.poll(() => page.evaluate(() => document.activeElement?.matches('[data-toggle-analysis]'))).toBe(true)
    } finally {
      await page.close()
    }
  })

  it('keeps the video workspace usable when guidance loading fails', async () => {
    promptShouldFail = true
    const page = await newIsolatedPage()
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

  it('resizes the analysis pane by dragging its divider within min/max limits and remembers the width', async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    await openDetail(page)
    await page.locator('[data-toggle-analysis]').click()
    const handle = page.locator('.pane-resize-handle')
    await handle.waitFor({ state: 'visible' })
    const pane = page.locator('[data-analysis-pane]')

    const startBox = await waitForLayoutStable(pane)
    expect(startBox.width).toBeGreaterThanOrEqual(300)
    const handleBox = await waitForLayoutStable(handle)
    // 把手贴右栏左缘;从主区主点开始向左拖 = 右栏变宽
    const mid = { x: handleBox.x + handleBox.width / 2, y: handleBox.y + 240 }
    await page.mouse.move(mid.x, mid.y)
    await page.mouse.down()
    await page.mouse.move(mid.x - 120, mid.y, { steps: 6 })
    await page.mouse.up()
    const afterGrow = await waitForLayoutStable(pane)
    expect(afterGrow.width).toBeGreaterThan(startBox.width + 80)

    // 拖窄受最小宽限制
    const midNarrow = { x: handleBox.x + handleBox.width / 2, y: handleBox.y + 240 }
    await page.mouse.move(midNarrow.x, midNarrow.y)
    await page.mouse.down()
    await page.mouse.move(midNarrow.x + 400, midNarrow.y, { steps: 8 })
    await page.mouse.up()
    const afterShrink = await waitForLayoutStable(pane)
    expect(afterShrink.width).toBeGreaterThanOrEqual(280)

    // 宽度持久化:同一 profile 下重开页面仍保持上次拖出的宽度
    const remembered = await page.evaluate(() => localStorage.getItem('browser-forge.analysis-pane-width'))
    expect(Number(remembered)).toBeGreaterThan(0)
    await page.close()

    const page2 = await context.newPage()
    await openDetail(page2, { reset: false })
    await page2.locator('[data-toggle-analysis]').click()
    await page2.locator('[data-analysis-pane]').waitFor({ state: 'visible' })
    const reopened = await page2.locator('[data-analysis-pane]').boundingBox()
    expect(Math.abs(reopened.width - Number(remembered))).toBeLessThanOrEqual(4)
    await page2.close()
    await context.close()
  })

  it('collapses the left sidebar fully when analysis opens and restores it via the reveal affordance', async () => {
    const page = await newIsolatedPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    const shell = page.locator('[data-app-shell]')
    expect(await shell.getAttribute('class')).not.toContain('sidebar-hidden')

    await page.getByRole('button', { name: '去分析', exact: true }).click()
    // 进入详情:右侧分析栏此时还未展开。点击去分析后左侧栏自动全部收起
    await page.locator('[data-toggle-analysis]').click()
    await page.locator('[data-analysis-pane]').waitFor({ state: 'visible' })
    await expect.poll(() => shell.getAttribute('class')).toContain('sidebar-hidden')
    expect(await shell.getAttribute('class')).toContain('sidebar-collapsed')
    expect(await page.locator('[data-sidebar-host]').evaluate(el => el.classList.contains('is-hidden'))).toBe(true)
    // 出现可恢复的「显示侧边栏」入口
    const reveal = page.locator('[data-sidebar-reveal]')
    await reveal.waitFor({ state: 'attached' })
    expect(await reveal.evaluate(el => el.hidden)).toBe(false)
    await reveal.click()
    await expect.poll(() => shell.getAttribute('class')).not.toContain('sidebar-hidden')
    await page.close()
  }, 20_000)

  it('resizes the left sidebar by dragging its divider and respects its min/max bounds', async () => {
    const page = await newIsolatedPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    const sidebar = page.locator('.app-sidebar')
    const startBox = await sidebar.boundingBox()
    expect(startBox.width).toBeGreaterThanOrEqual(180)

    const handle = page.locator('.sidebar-resize-handle')
    await handle.waitFor({ state: 'visible' })
    await waitForLayoutStable(sidebar)
    const handleBox = await waitForLayoutStable(handle)
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 40)
    await page.mouse.down()
    await page.mouse.move(handleBox.x + 160, handleBox.y + 40, { steps: 6 })
    await page.mouse.up()
    const widened = await waitForLayoutStable(sidebar)
    expect(widened.width).toBeGreaterThan(startBox.width + 100)
    const remembered = await page.evaluate(() => localStorage.getItem('browser-forge.sidebar-width'))
    expect(Number(remembered)).toBeGreaterThan(startBox.width)

    // 最小宽限制
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 40)
    await page.mouse.down()
    await page.mouse.move(handleBox.x - 500, handleBox.y + 40, { steps: 8 })
    await page.mouse.up()
    const shrunk = await waitForLayoutStable(sidebar)
    expect(shrunk.width).toBeGreaterThanOrEqual(178)
    await page.close()
  })

  it('completes the three-question conversation flow into a handoff card', { timeout: 20_000 }, async () => {
    const page = await newIsolatedPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: '去分析', exact: true }).click()
    await page.locator('[data-toggle-analysis]').click()
    await page.locator('[data-analysis-pane]').waitFor({ state: 'visible' })

    const answers = ['打开订单并读取物流状态', '接收订单号,返回承运商和最新节点', '使用 JD123 验证结果与页面一致']
    for (const answer of answers) {
      const surface = page.locator('[data-guidance-editor-surface]')
      await surface.waitFor({ state: 'visible' })
      await surface.fill(answer)
      const send = page.locator('[data-guidance-send]')
      await expect.poll(() => send.isEnabled()).toBe(true)
      await send.click()
      const expectedCount = answers.indexOf(answer) + 1
      await expect.poll(async () => page.locator('[data-chat-item]').count()).toBe(expectedCount)
    }

    // 三问完成后吸附 handoff 卡可见、composer 进入 aria-disabled 遮罩态;三问三答由气泡承载
    const card = page.locator('[data-handoff-card]')
    await card.waitFor({ state: 'visible' })
    expect(await page.locator('[data-guidance-composer]').getAttribute('aria-disabled')).toBe('true')
    expect(await page.locator('[data-chat-item]').count()).toBe(3)

    // 导出并复制(复制到剪贴板在 headless 可能被拒;UI 应至少触发 handoff 请求并给出状态)
    await page.locator('[data-agent-handoff]').dispatchEvent('click')
    await expect.poll(() => requests.some(item => item.path.endsWith('/agent-handoff')), { timeout: 3000 }).toBe(true)
    await expect.poll(async () => {
      const el = page.locator('[data-handoff-message]')
      return el.isVisible() ? el.textContent() : ''
    }, { timeout: 3000 }).toContain('录制已导出')
    await page.close()
  })

  it('edits a submitted answer via the pencil and updates its bubble after resend', { timeout: 20_000 }, async () => {
    promptText = serializeGuidanceMarkdown({ actions: '原始回答', capability: '能力回答', acceptance: '验收回答' })
    const page = await newIsolatedPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: '去分析', exact: true }).click()
    await page.locator('[data-toggle-analysis]').click()
    await page.locator('[data-analysis-pane]').waitFor({ state: 'visible' })

    // 全部已提交 → 结果是完成态
    const card = page.locator('[data-handoff-card]')
    await card.waitFor({ state: 'visible' })
    expect(await page.locator('[data-chat-item]').count()).toBe(3)

    // 点铅笔:气泡原地变为编辑卡(pre-filled 原文),composer 遮罩解除
    await page.locator('[data-edit-answer="capability"]').click()
    const editSurface = page.locator('[data-chat-item="capability"] [data-guidance-editor-surface]')
    await editSurface.waitFor({ state: 'visible' })
    await expect.poll(() => editSurface.textContent()).toContain('能力回答')
    expect(await page.locator('[data-guidance-composer]').getAttribute('aria-disabled')).toBe('false')

    // 在气泡编辑卡内修改并发送,气泡原地更新,完成后回到完成态
    await editSurface.fill('改成:返回最新节点和签收状态')
    await page.locator('[data-chat-edit-send="capability"]').click()
    await expect.poll(() => page.locator('[data-chat-item="capability"] .guidance-chat-text').textContent()).toContain('签收状态')
    await card.waitFor({ state: 'visible' })
    expect(await page.locator('[data-guidance-composer]').getAttribute('aria-disabled')).toBe('true')
    expect(await page.locator('[data-chat-item]').count()).toBe(3)
    await page.close()
  })

  it('renames, exports by ID, trashes, and offers undo restore', async () => {
    const page = await newIsolatedPage()
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

async function waitForLayoutStable(locator, { samples = 4, delay = 50 } = {}) {
  let last = await locator.boundingBox()
  for (let i = 0; i < samples; i += 1) {
    await new Promise(resolve => setTimeout(resolve, delay))
    const next = await locator.boundingBox()
    const same = last && next &&
      Math.abs(next.x - last.x) < 0.5 &&
      Math.abs(next.y - last.y) < 0.5 &&
      Math.abs(next.width - last.width) < 0.5 &&
      Math.abs(next.height - last.height) < 0.5
    last = next
    if (same) return next
  }
  return last
}

async function openDetail(page, { reset = true } = {}) {
  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  if (reset) {
    await page.evaluate(() => {
      try {
        localStorage.removeItem('browser-forge.sidebar-collapsed')
        localStorage.removeItem('browser-forge.sidebar-width')
        localStorage.removeItem('browser-forge.analysis-pane-width')
      } catch {}
    })
    await page.reload({ waitUntil: 'networkidle' })
  }
  await page.getByRole('button', { name: '去分析', exact: true }).click()
  await page.locator('[data-analysis-workspace]').waitFor()
}

async function fillActiveEditor(page, value) {
  const surface = page.locator('[data-guidance-editor-surface]')
  if (await surface.count()) return surface.fill(value)
  return page.locator('[data-guidance-composer] [data-prompt-textarea]:visible').fill(value)
}

async function readActiveEditor(page) {
  return page.evaluate(() => {
    const surface = document.querySelector('[data-guidance-editor-surface]')
    if (surface) return [...surface.children].map(block => block.innerText).join('\n\n').trim()
    return document.querySelector('[data-guidance-composer] [data-prompt-textarea]:not([hidden])')?.value ?? ''
  })
}

function json(res, value) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)) }
function readBody(req) { return new Promise(resolve => { let body = ''; req.on('data', chunk => { body += chunk }); req.on('end', () => resolve(body ? JSON.parse(body) : {})) }) }
function serveUi(pathname, res) { const relative = pathname === '/' ? 'index.html' : pathname.slice(1); const path = join(process.cwd(), 'ui', relative); try { if (!statSync(path).isFile()) throw new Error(); res.setHeader('content-type', contentTypes[extname(path)] || 'application/octet-stream'); res.end(readFileSync(path)) } catch { res.statusCode = 404; res.end('not found') } }
