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
const recording = { id, title: '订单查询', state: 'active', createdAt: '2026-08-08T12:15:00.000Z', durationMs: 42_000, startHost: 'example.com', visitedHosts: ['example.com', 'checkout.example.com'], videoStatus: 'complete', promptStatus: 'empty', sizeBytes: 1048576 }
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
  it('defines a shell-owned context column with restrained, reduced-motion-safe content motion', () => {
    const css = readFileSync(join(process.cwd(), 'ui', 'styles.css'), 'utf8')
    const detailSource = readFileSync(join(process.cwd(), 'ui', 'views', 'detail.js'), 'utf8')
    const contextSource = readFileSync(join(process.cwd(), 'ui', 'views', 'context-pane.js'), 'utf8')

    expect(css).toMatch(/\.app-shell \{[^}]*grid-template-columns:var\(--sidebar-w\) minmax\(560px,1fr\) var\(--context-w\)/s)
    expect(css).toMatch(/\.sidebar-resize-handle,\s*\n\.pane-resize-handle\s*\{[^}]*cursor:\s*col-resize/s)
    expect(css).toMatch(/\.workspace-context-host\s*\{[^}]*position:sticky[^}]*top:0[^}]*height:100vh/s)
    expect(css).toMatch(/@media \(max-width:1103px\)[\s\S]*?\.workspace-context-host \{[^}]*position:fixed/s)
    expect(css).toMatch(/\.analysis-pane-inner\s*\{[^}]*opacity:0[^}]*transform:translateX\(10px\)/s)
    expect(css).toMatch(/\.app-shell\.analysis-pane-open:not\(\.analysis-pane-closing\) \.analysis-pane-inner\s*\{[^}]*opacity:1[^}]*transform:none[^}]*transition:transform 200ms cubic-bezier\(\.2,\.8,\.2,1\),opacity 180ms cubic-bezier\(\.2,\.8,\.2,1\)/s)
    expect(css).toMatch(/\.app-shell\.analysis-pane-closing \.analysis-pane-inner\s*\{[^}]*opacity:0[^}]*transform:translateX\(10px\)[^}]*transition:transform 140ms cubic-bezier\(\.4,0,\.2,1\),opacity 140ms cubic-bezier\(\.4,0,\.2,1\)/s)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[^{]*\{[^}]*\.analysis-pane-inner[^}]*transform:none[^}]*transition-property:opacity[^}]*transition-duration:120ms/s)
    expect(css).not.toContain('.analysis-backdrop')
    expect(css).not.toContain('transition:all')
    expect(detailSource).not.toContain('data-analysis-pane')
    expect(detailSource).not.toContain('renderPromptEditor')
    expect(detailSource).not.toContain('data-analysis-backdrop')
    expect(detailSource).not.toContain('aria-modal')
    expect(detailSource).not.toContain('role="dialog"')
    expect(detailSource).not.toContain('setBackgroundInert')
    expect(detailSource).not.toContain("document.addEventListener('keydown'")
    expect(contextSource).toContain('aria-label="分析指导"')
    expect(contextSource).toContain('analysis-pane-closing')
    expect(contextSource).toContain('clearTimeout(closeTimer)')
    expect(contextSource).toContain('loadingRecordingId')
    expect(detailSource).toContain('data-detail-titlebar')
    expect(detailSource).toContain('data-evidence-strip')
    expect(detailSource).toContain('data-object-actions')
  })

  it('opens as an evidence-first three-pane workspace at the reference viewport', async () => {
    const page = await newIsolatedPage()
    await page.setViewportSize({ width: 1512, height: 869 })
    await openDetail(page)

    const pane = page.locator('[data-analysis-pane]')
    await pane.waitFor({ state: 'visible' })
    await page.locator('[data-video-player]').waitFor({ state: 'visible' })

    const geometry = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect()
      const sidebar = rect('.app-sidebar')
      const workspace = rect('[data-analysis-workspace]')
      const pane = rect('[data-analysis-pane]')
      const titlebar = rect('[data-detail-titlebar]')
      const video = rect('.analysis-video-card')
      const actions = rect('[data-object-actions]')
      return {
        sidebarWidth: sidebar.width,
        centerWidth: pane.left - workspace.left,
        paneWidth: pane.width,
        titlebarHeight: titlebar.height,
        videoWidth: video.width,
        actionsTop: actions.top,
        videoBottom: video.bottom
      }
    })

    expect(geometry.sidebarWidth).toBeGreaterThanOrEqual(238)
    expect(geometry.sidebarWidth).toBeLessThanOrEqual(242)
    expect(geometry.paneWidth).toBeGreaterThanOrEqual(470)
    expect(geometry.paneWidth).toBeLessThanOrEqual(482)
    expect(geometry.centerWidth).toBeGreaterThan(760)
    expect(geometry.titlebarHeight).toBeGreaterThanOrEqual(42)
    expect(geometry.titlebarHeight).toBeLessThanOrEqual(44)
    expect(geometry.videoWidth / geometry.centerWidth).toBeGreaterThan(0.82)
    expect(geometry.videoWidth / geometry.centerWidth).toBeLessThan(0.92)
    expect(geometry.actionsTop).toBeGreaterThanOrEqual(geometry.videoBottom)

    const evidenceText = await page.locator('[data-evidence-strip]').textContent()
    expect(evidenceText).toContain('0:42')
    expect(evidenceText).toContain('example.com')
    expect(evidenceText).toContain('checkout.example.com')
    expect(evidenceText).toContain('视频可用')
    expect(evidenceText).toContain('2026')
    expect(await page.locator('[data-object-actions]').count()).toBe(1)
    expect(await page.getByRole('button', { name: '导出录制' }).count()).toBe(1)
    expect(await page.getByRole('button', { name: '移入回收站' }).count()).toBe(1)
    expect(await page.locator('[data-analysis-pane][hidden]').count()).toBe(0)
    await pane.evaluate(element => {
      const scroll = element.querySelector('[data-guidance-chat-scroll]')
      const history = element.querySelector('[data-guidance-chat-list]')
      history.style.minHeight = '1400px'
      scroll.scrollTop = scroll.scrollHeight
    })
    await page.waitForTimeout(50)
    const stickyComposer = await page.evaluate(() => {
      const pane = document.querySelector('[data-analysis-pane]').getBoundingClientRect()
      const composer = document.querySelector('[data-guidance-composer]').getBoundingClientRect()
      return { paneTop: pane.top, paneBottom: pane.bottom, composerTop: composer.top, composerBottom: composer.bottom }
    })
    expect(stickyComposer.composerTop).toBeGreaterThanOrEqual(stickyComposer.paneTop)
    expect(stickyComposer.composerBottom).toBeLessThanOrEqual(stickyComposer.paneBottom + 1)
    await page.close()
  }, 20_000)

  it('changes responsive modes before the three panes can overflow', async () => {
    const page = await newIsolatedPage()
    await page.setViewportSize({ width: 1276, height: 760 })
    await openDetail(page)
    for (const [width, expectedSidebar, drawer] of [[1276, 240, false], [1275, 68, false], [1104, 68, false], [1103, 68, true]]) {
      await page.setViewportSize({ width, height: 760 })
      if (drawer && await page.locator('[data-toggle-analysis]').getAttribute('aria-expanded') === 'false') await openContextDrawer(page)
      const geometry = await page.evaluate(() => {
        const sidebar = document.querySelector('.app-sidebar').getBoundingClientRect()
        const pane = document.querySelector('[data-analysis-pane]').getBoundingClientRect()
        const contextHost = document.querySelector('[data-context-host]')
        return { sidebarWidth: sidebar.width, paneRight: pane.right, panePosition: getComputedStyle(contextHost).position }
      })
      expect(geometry.sidebarWidth).toBeGreaterThanOrEqual(expectedSidebar - 2)
      expect(geometry.sidebarWidth).toBeLessThanOrEqual(expectedSidebar + 2)
      expect(geometry.paneRight).toBeLessThanOrEqual(width + 0.5)
      expect(geometry.panePosition === 'fixed').toBe(drawer)
    }
    await page.close()
  }, 20_000)

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
    expect(await toggle.getAttribute('aria-expanded')).toBe('true')
    expect(await toggle.getByText('说明', { exact: true }).count()).toBe(1)
    expect(await toggle.isVisible()).toBe(false)
    expect(await pane.getAttribute('id')).toBe('recording-analysis-guidance')
    expect(await pane.getAttribute('aria-label')).toBe('分析指导')
    expect(await pane.getAttribute('hidden')).toBeNull()
    expect(await pane.getAttribute('role')).toBeNull()
    expect(await pane.getAttribute('aria-modal')).toBeNull()
    expect(await page.locator('[data-analysis-backdrop]').count()).toBe(0)

    await page.locator('[data-guidance-editor-surface]').waitFor({ state: 'attached' })
    await pane.waitFor({ state: 'visible' })
    const questionStyle = await pane.locator('[data-guidance-question-title]').evaluate(element => {
      const style = getComputedStyle(element)
      return { outlineStyle: style.outlineStyle, tabIndex: element.getAttribute('tabindex') }
    })
    expect(questionStyle).toEqual({ outlineStyle: 'none', tabIndex: null })
    expect(await toggle.getAttribute('aria-expanded')).toBe('true')
    expect(await toggle.getByText('说明', { exact: true }).count()).toBe(1)
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
    expect(gap).toBeLessThanOrEqual(25)
    expect(paneBox.width).toBeGreaterThanOrEqual(470)
    const headerLayout = await page.locator('.analysis-main .detail-header').evaluate(element => {
      const title = element.querySelector('.detail-title-input')
      return { display: getComputedStyle(element).display, height: element.getBoundingClientRect().height, titleWidth: title.getBoundingClientRect().width }
    })
    expect(headerLayout).toMatchObject({ display: 'grid', height: 44 })
    expect(headerLayout.titleWidth).toBeGreaterThanOrEqual(140)
    expect(await page.locator('[data-guidance-editor-surface]').isEditable()).toBe(true)

    const rateButton = page.locator('[data-player-rate]')
    await expect.poll(() => rateButton.isVisible()).toBe(true)
    expect(await rateButton.isEnabled()).toBe(true)
    await rateButton.click()
    expect(await rateButton.textContent()).toBe('1.5×')
    await fillActiveEditor(page, '边看视频边补充分析指导')
    expect(await readActiveEditor(page)).toBe('边看视频边补充分析指导')

    await page.keyboard.press('Escape')
    expect(await toggle.getAttribute('aria-expanded')).toBe('true')
    expect(await pane.getAttribute('hidden')).toBeNull()
    expect(await page.locator('[data-app-shell]').getAttribute('class')).toContain('analysis-pane-open')
    await page.close()
  })

  it('shows submitted answers as chat bubbles and keeps the next question editable in the persistent context pane', async () => {
    promptText = serializeGuidanceMarkdown({ actions: '打开订单并读取物流状态', capability: '', acceptance: '' })
    const page = await newIsolatedPage()
    try {
      await openDetail(page)
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
      expect(await surface.isEditable()).toBe(true)
    } finally {
      await page.close()
    }
  })

  it('keeps a delayed shell context load alive while navigating from detail back to the repository', async () => {
    promptDelayMs = 900
    const page = await newIsolatedPage()
    try {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: '去分析', exact: true }).waitFor()
      await page.getByRole('button', { name: '去分析', exact: true }).click()
      await page.locator('[data-analysis-workspace]').waitFor()
      await page.locator('[data-back]').click()
      await page.locator('.library-view').waitFor({ timeout: 350 })
      await page.locator('[data-context-host] [data-guidance-editor-surface]').waitFor({ state: 'attached', timeout: 2_000 })
      expect(await page.locator('.library-view').count()).toBe(1)
      expect(await page.locator('[data-analysis-workspace]').count()).toBe(0)
      expect(await page.locator('[data-context-host] [data-guidance-question-title]').count()).toBe(1)
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
      await page.setViewportSize({ width: 820, height: 760 })
      await openDetail(page)
      await openContextDrawer(page)
      await page.locator('[data-guidance-editor-surface]').waitFor({ state: 'attached' })
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
      await page.locator('[data-close-analysis]').click()
      await page.locator('[data-save-error]').waitFor()
      expect(await page.locator('[data-toggle-analysis]').getAttribute('aria-expanded')).toBe('true')
      expect(await page.locator('[data-analysis-pane]').getAttribute('hidden')).toBeNull()
      expect(await page.locator('[data-app-shell]').getAttribute('class')).not.toContain('analysis-pane-closing')
    } finally {
      await page.close()
    }
  }, 8_000)

  it('cancels a pending close when the pane is quickly reopened', async () => {
    const page = await newIsolatedPage()
    try {
      await page.setViewportSize({ width: 820, height: 760 })
      await openDetail(page)
      await openContextDrawer(page)
      await page.locator('[data-guidance-editor-surface]').waitFor({ state: 'attached' })
      const pane = page.locator('[data-analysis-pane]')
      const toggle = page.locator('[data-toggle-analysis]')
      await page.locator('[data-close-analysis]').click()
      expect(await pane.getAttribute('hidden')).toBeNull()
      expect(await page.locator('[data-app-shell]').getAttribute('class')).toContain('analysis-pane-closing')
      await toggle.click()
      await page.waitForTimeout(220)
      expect(await toggle.getAttribute('aria-expanded')).toBe('true')
      expect(await pane.getAttribute('hidden')).toBeNull()
      const workspaceClass = await page.locator('[data-app-shell]').getAttribute('class')
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
      await page.setViewportSize({ width: 820, height: 760 })
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
      const analyze = page.getByRole('button', { name: '去分析', exact: true })
      await analyze.waitFor()
      await analyze.click()
      await openContextDrawer(page)
      const pane = page.locator('[data-analysis-pane]')
      const toggle = page.locator('[data-toggle-analysis]')
      await toggle.waitFor({ state: 'visible' })
      expect(await toggle.getAttribute('aria-expanded')).toBe('true')
      await page.locator('[data-close-analysis]').click()
      await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
      await page.locator('[data-guidance-editor-surface]').waitFor({ state: 'attached', timeout: 2_000 })
      await page.locator('[data-context-host]').waitFor({ state: 'hidden' })
      expect(await page.locator('[data-context-host]').getAttribute('hidden')).not.toBeNull()
      await expect.poll(() => page.evaluate(() => document.activeElement?.matches('[data-toggle-analysis]'))).toBe(true)
    } finally {
      await page.close()
    }
  })

  it('keeps the video workspace usable when guidance loading fails', async () => {
    promptShouldFail = true
    const page = await newIsolatedPage()
    try {
      await page.setViewportSize({ width: 820, height: 760 })
      await page.goto(baseUrl, { waitUntil: 'networkidle' })
      await page.getByRole('button', { name: '去分析', exact: true }).click()
      await openContextDrawer(page)
      const toggle = page.locator('[data-toggle-analysis]')
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
    const context = await browser.newContext({ viewport: { width: 1512, height: 869 } })
    const page = await context.newPage()
    await openDetail(page)
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
    await page2.locator('[data-analysis-pane]').waitFor({ state: 'visible' })
    const reopened = await page2.locator('[data-analysis-pane]').boundingBox()
    expect(Math.abs(reopened.width - Number(remembered))).toBeLessThanOrEqual(4)
    await page2.close()
    await context.close()
  })

  it('keeps the left navigation stable when analysis opens', async () => {
    const page = await newIsolatedPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    const shell = page.locator('[data-app-shell]')
    const sidebar = page.locator('.app-sidebar')
    const initialWidth = (await sidebar.boundingBox()).width
    expect(initialWidth).toBeGreaterThan(230)

    await page.getByRole('button', { name: '去分析', exact: true }).click()
    await page.locator('[data-analysis-pane]').waitFor({ state: 'visible' })

    expect(await shell.getAttribute('class')).not.toContain('sidebar-collapsed')
    expect((await sidebar.boundingBox()).width).toBeGreaterThan(230)
    expect(await page.locator('[data-sidebar-reveal]').count()).toBe(0)
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

    // 三问完成后 handoff 卡可见，composer 继续用于补充上下文；三问三答由气泡承载
    const card = page.locator('[data-handoff-card]')
    await card.waitFor({ state: 'visible' })
    expect(await page.locator('[data-guidance-composer]').getAttribute('aria-disabled')).toBe('false')
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
    expect(await page.locator('[data-guidance-composer]').getAttribute('aria-disabled')).toBe('false')
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
  if (reset) {
    await page.addInitScript(() => {
      try {
        localStorage.removeItem('browser-forge.sidebar-collapsed')
        localStorage.removeItem('browser-forge.sidebar-width')
        localStorage.removeItem('browser-forge.analysis-pane-width')
      } catch {}
    })
  }
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  const analyze = page.getByRole('button', { name: '去分析', exact: true })
  await analyze.waitFor()
  await analyze.click()
  await page.locator('[data-analysis-workspace]').waitFor()
}

async function openContextDrawer(page) {
  const toggle = page.locator('[data-toggle-analysis]')
  await toggle.waitFor({ state: 'visible' })
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  await page.locator('[data-context-host]').waitFor({ state: 'visible' })
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
