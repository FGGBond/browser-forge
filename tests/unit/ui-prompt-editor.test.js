import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { createServer } from 'http'
import { readFileSync, statSync } from 'fs'
import { extname, join } from 'path'
import { parseGuidanceMarkdown } from '../../ui/guidance-format.js'

let browser
let server
let baseUrl
let promptText
let savedPrompts
let failSavesRemaining
let delayedSave
let delayedHandoff
let requestEvents
let handoffCalls
let handoffMode
const id = '3d4527e4-4d47-4aea-a4ba-cd61218bbd27'
const managedPath = `/Users/example/Library/Application Support/Browser Forge/recordings/active/${id}`
const exportedPath = '/Users/example/Desktop/Recording-8月10日23:40'
const recording = { id, title: '订单查询', state: 'active', createdAt: '2026-08-08T12:15:00.000Z', durationMs: 42_000, startHost: 'example.com', videoStatus: 'failed', promptStatus: 'empty', sizeBytes: 1024 }
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

beforeAll(async () => {
  browser = await chromium.launch()
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/api/recordings') return json(res, { recordings: [recording] })
    if (url.pathname === `/api/recordings/${id}`) return json(res, recording)
    if (url.pathname === `/api/recordings/${id}/timeline`) return json(res, { events: [] })
    if (url.pathname === `/api/recordings/${id}/prompt` && req.method === 'GET') {
      return json(res, { text: promptText, status: promptText ? 'draft' : 'empty', updatedAt: promptText ? '2026-08-08T12:19:00.000Z' : null })
    }
    if (url.pathname === `/api/recordings/${id}/prompt` && req.method === 'PUT') {
      const body = await readBody(req)
      savedPrompts.push(body.text)
      requestEvents.push('save:start')
      if (delayedSave) await delayedSave
      if (failSavesRemaining > 0) {
        failSavesRemaining -= 1
        requestEvents.push('save:failed')
        res.statusCode = 500
        return json(res, { error: { code: 'FILESYSTEM_FAILURE', message: 'disk full' } })
      }
      promptText = body.text
      requestEvents.push('save:done')
      return json(res, { text: body.text, status: body.text ? 'draft' : 'empty', updatedAt: '2026-08-08T12:20:00.000Z' })
    }
    if (url.pathname === `/api/recordings/${id}/agent-handoff` && req.method === 'POST') {
      handoffCalls += 1
      requestEvents.push('agent-handoff')
      if (handoffMode === 'cancel') {
        res.statusCode = 204
        return res.end()
      }
      if (handoffMode === 'error') {
        res.statusCode = 500
        return json(res, { error: { code: 'FILESYSTEM_FAILURE', message: 'export failed' } })
      }
      const text = buildCompletePrompt(promptText, exportedPath)
      if (delayedHandoff) await delayedHandoff
      return json(res, { recordingId: id, path: exportedPath, text })
    }
    if (url.pathname === `/api/recordings/${id}/external-agent-prompt`) {
      requestEvents.push('legacy-external-prompt')
      res.statusCode = 500
      return json(res, { error: { code: 'LEGACY_ROUTE_USED', message: 'legacy route must not be used' } })
    }
    serveUi(url.pathname, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

beforeEach(() => {
  promptText = ''
  savedPrompts = []
  failSavesRemaining = 0
  delayedSave = null
  delayedHandoff = null
  requestEvents = []
  handoffCalls = 0
  handoffMode = 'success'
})

afterAll(async () => {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
})

describe('three-question guided composer', () => {
  it('uses a centered non-interactive progress pill without moving focus to the question', { timeout: 30000 }, async () => {
    const page = await openGuidance()
    await expectStep(page, 1, '这次录制中，你完成了什么？')
    const progress = page.locator('[data-guidance-progress]')
    expect(await progress.getAttribute('role')).toBe('status')
    expect(await progress.getAttribute('aria-live')).toBe('polite')
    expect((await progress.textContent()).trim()).toBe('第 1 / 3 个问题')
    expect(await progress.locator('button, ol, li').count()).toBe(0)
    expect(await page.locator('[data-guidance-step-jump]').count()).toBe(0)

    const question = page.getByRole('heading', { name: '这次录制中，你完成了什么？' })
    expect(await question.getAttribute('tabindex')).toBe(null)
    expect(await question.evaluate(element => document.activeElement === element)).toBe(false)
    expect(await activeEditorCount(page)).toBe(1)
    expect(await page.locator('.EasyMDEContainer, .CodeMirror, .editor-toolbar').count()).toBe(0)
    await fillActiveEditor(page, '查询订单并读取物流状态')
    await page.locator('[data-guidance-next]').click()
    await expectStep(page, 2, '希望把这段操作变成什么能力？')
    await expectComposerFocused(page)
    expect((await progress.textContent()).trim()).toBe('第 2 / 3 个问题')

    await page.locator('[data-guidance-next]').click()
    await expectStep(page, 3, '怎样证明这个 skill 可以交付？')
    expect((await progress.textContent()).trim()).toBe('第 3 / 3 个问题')

    // 第三次答完后等待自动保存完成(发送按钮 aria-label 变为「检查并完成」),再触发完成
    await page.locator('[data-guidance-send]').waitFor({ state: 'visible' })
    await expect.poll(() => page.locator('[data-guidance-send]').evaluate(b => !b.disabled), { timeout: 3000 }).toBe(true)
    await page.locator('[data-guidance-send]').dispatchEvent('click')
    // 完成态:handoff 卡出现在 composer 上方，补充上下文 composer 仍可使用
    await expectComposerDone(page)
    expect(await page.locator('[data-guidance-review]').count()).toBe(0)
    expect(await page.locator('[data-guidance-progress]').evaluate(el => el.hidden)).toBe(true)
    expect(await page.locator('[data-guidance-progress-text]').textContent()).toBe('已完成 3 / 3 个问题')
    await page.close()
  })

  it('attaches the handoff card above an enabled supplemental composer once done', async () => {
    const page = await openGuidance()
    await completeQuestions(page)
    const layout = await page.evaluate(() => {
      const card = document.querySelector('[data-handoff-card]')
      const composer = document.querySelector('[data-guidance-composer]')
      const send = document.querySelector('[data-guidance-send]')
      const cardStyle = getComputedStyle(card)
      const composerStyle = getComputedStyle(composer)
      const cardRect = card.getBoundingClientRect()
      const composerRect = composer.getBoundingClientRect()
      return {
        insideComposer: composer.contains(card),
        position: cardStyle.position,
        bottom: cardStyle.bottom,
        composerMode: composer.getAttribute('aria-disabled'),
        widthMatch: Math.abs(cardRect.width - composerRect.width) < 1,
        above: cardRect.bottom <= composerRect.top + 8,
        sendDisabled: send.disabled
      }
    })
    expect(layout.insideComposer).toBe(true)
    expect(layout.position).toBe('absolute')
    expect(layout.bottom.endsWith('px')).toBe(true) // bottom: calc(100% + 8px) 在 computed 中解析为 px
    expect(layout.composerMode).toBe('false')
    expect(layout.widthMatch).toBe(true)
    expect(layout.above).toBe(true)
    expect(layout.sendDisabled).toBe(true)
    // 完成态下 composer 继续接收补充上下文，空内容时发送按钮保持禁用
    const surface = page.locator('[data-guidance-composer] [data-guidance-editor-surface]')
    expect(await surface.getAttribute('contenteditable')).toBe('true')
    expect(await surface.getAttribute('data-placeholder')).toContain('补充')
    await page.close()
  })

  it('keeps the completed composer available and persists supplemental context for handoff', { timeout: 15000 }, async () => {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
    const page = await openGuidance(context)
    try {
      await completeQuestions(page)
      await fillActiveEditor(page, '只查询最近两小时，并限定应用 ID 为 ddks-ticket。')
      await expect.poll(() => page.locator('[data-guidance-send]').isDisabled()).toBe(false)
      await page.locator('[data-guidance-send]').dispatchEvent('click')

      await expect.poll(() => savedPrompts.some(text => parseGuidanceMarkdown(text).notes.includes('ddks-ticket'))).toBe(true)
      expect(await page.locator('[data-guidance-composer]').getAttribute('aria-disabled')).toBe('false')
      expect(await readActiveEditor(page)).toContain('ddks-ticket')

      await page.getByRole('button', { name: '导出并复制给外部 Agent' }).dispatchEvent('click')
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('ddks-ticket')
    } finally {
      await context.close()
    }
  })

  it('rejects a stale handoff snapshot when supplemental context changes during export', { timeout: 15000 }, async () => {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
    await installControlledClipboard(context)
    let releaseHandoff
    delayedHandoff = new Promise(resolve => { releaseHandoff = resolve })
    const page = await openGuidance(context)
    try {
      await page.evaluate(() => { window.__clipboardShouldFail = false })
      await completeQuestions(page)
      await fillActiveEditor(page, '导出前的限制。')
      await page.locator('[data-guidance-send]').dispatchEvent('click')
      await expect.poll(() => page.getByRole('button', { name: '导出并复制给外部 Agent' }).isEnabled()).toBe(true)
      await page.getByRole('button', { name: '导出并复制给外部 Agent' }).click()
      await expect.poll(() => handoffCalls).toBe(1)

      await fillActiveEditor(page, '导出期间新增的限制。')
      releaseHandoff()
      delayedHandoff = null

      const status = page.locator('[data-handoff-status]')
      await expect.poll(() => status.textContent()).toContain('内容已更新')
      expect(await page.evaluate(() => window.__copiedText)).toBe('')

      await page.getByRole('button', { name: '重新导出并复制给外部 Agent' }).dispatchEvent('click')
      await expect.poll(() => handoffCalls).toBe(2)
      await expect.poll(() => page.evaluate(() => window.__copiedText)).toContain('导出期间新增的限制')
    } finally {
      releaseHandoff?.()
      delayedHandoff = null
      await context.close()
    }
  })

  it('clears completed handoff success UI as soon as supplemental context changes', { timeout: 10000 }, async () => {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
    const page = await openGuidance(context)
    try {
      await completeQuestions(page)
      await page.getByRole('button', { name: '导出并复制给外部 Agent' }).dispatchEvent('click')
      const status = page.locator('[data-handoff-status]')
      await expect.poll(() => status.textContent()).toContain('已导出并复制')

      await fillActiveEditor(page, '成功交接后新增的限制。')

      await expect.poll(async () => (await status.textContent()).trim()).toBe('')
      await page.getByRole('button', { name: '导出并复制给外部 Agent' }).waitFor()
      expect(handoffCalls).toBe(1)
    } finally {
      await context.close()
    }
  })

  it('describes an external-agent handoff truthfully and keeps message motion reduced-motion safe', async () => {
    const page = await openGuidance()
    await completeQuestions(page)

    const handoffCopy = (await page.locator('.guidance-handoff-copy').textContent()).replace(/\s+/g, ' ').trim()
    expect(handoffCopy).toContain('Browser Forge 只负责导出录制并准备交接提示词')
    expect(handoffCopy).toContain('外部 Agent')
    expect(handoffCopy).not.toMatch(/Browser Forge (?:正在|将会)(?:分析|生成)/)

    const css = readFileSync(join(process.cwd(), 'ui', 'guidance.css'), 'utf8')
    expect(css).toMatch(/\.guidance-chat-item\s*\{[^}]*animation:\s*guidanceMessageIn 1(?:6|7|8)0ms/s)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.guidance-chat-item[\s\S]*animation:\s*none/s)
    await page.close()
  })

  it('renders a bottom composer that grows until its cap and then scrolls internally', async () => {
    const page = await openGuidance()
    const composer = page.locator('[data-guidance-composer]')
    const surface = page.locator('[data-guidance-editor-surface]')
    const styles = await page.evaluate(() => {
      const composer = getComputedStyle(document.querySelector('[data-guidance-composer]'))
      const surface = getComputedStyle(document.querySelector('[data-guidance-editor-surface]'))
      return {
        position: composer.position,
        bottom: composer.bottom,
        surfaceBorder: surface.borderTopWidth,
        surfaceOutline: surface.outlineStyle,
        minHeight: parseFloat(surface.minHeight),
        maxHeight: parseFloat(surface.maxHeight),
        overflowY: surface.overflowY,
        fontFamily: surface.fontFamily
      }
    })

    expect(['sticky', 'relative']).toContain(styles.position)
    expect(styles.surfaceBorder).toBe('0px')
    expect(styles.surfaceOutline).toBe('none')
    expect(styles.minHeight).toBeGreaterThanOrEqual(72)
    expect(styles.maxHeight).toBeLessThanOrEqual(280)
    expect(styles.overflowY).toBe('auto')
    expect(styles.fontFamily.toLowerCase()).not.toContain('monospace')
    expect(await composer.getAttribute('data-guidance-composer')).not.toBe(null)
    await surface.fill('很长的内容\n'.repeat(120))
    expect(await surface.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    await page.close()
  })

  it('walks all questions, preserves answers, renders chat safely, and returns to edit via the pencil', { timeout: 15000 }, async () => {
    const page = await openGuidance()
    await fillActiveEditor(page, '查询订单并读取物流状态')
    await page.locator('[data-guidance-next]').click()
    await expectStep(page, 2, '希望把这段操作变成什么能力？')
    await fillActiveEditor(page, '根据订单号返回承运商和最新节点')

    // 气泡已承载历史答案;回改旧答案走气泡上的铅笔,Q1 气泡原位变编辑卡
    expect(await page.locator('[data-chat-item="actions"] .guidance-chat-text').textContent()).toContain('查询订单并读取物流状态')
    await page.locator('[data-edit-answer="actions"]').click()
    await page.locator('[data-chat-item="actions"] [data-guidance-editor-surface]').waitFor()
    expect(await page.locator('[data-chat-item="actions"] [data-guidance-editor-surface]').textContent()).toContain('查询订单并读取物流状态')
    // composer 仍停留在当前问答步(Q2)
    await expectStep(page, 2, '希望把这段操作变成什么能力？')
    expect(await readActiveEditor(page)).toBe('根据订单号返回承运商和最新节点')
    // 取消:回到气泡显示态且不保存改动
    await page.locator('[data-chat-item="actions"] [data-guidance-editor-surface]').fill('不保存的临时改动')
    await page.locator('[data-chat-edit-cancel="actions"]').click()
    await page.locator('[data-chat-item="actions"] .guidance-chat-text').waitFor()
    expect(await page.locator('[data-chat-item="actions"] .guidance-chat-text').textContent()).toContain('查询订单并读取物流状态')

    await page.locator('[data-guidance-next]').click()
    await expectStep(page, 3, '怎样证明这个 skill 可以交付？')
    await fillActiveEditor(page, '使用 JD123 查询并核对 <script>alert(1)</script>')
    await page.getByRole('button', { name: '检查并完成' }).click()
    await expectComposerDone(page)
    // review 块已删除:三题三答仅由 chat 气泡承载,安全渲染(脚本被转义)
    expect(await page.locator('[data-guidance-review]').count()).toBe(0)
    expect(await page.locator('[data-chat-item]').count()).toBe(3)
    const acceptanceBubble = page.locator('[data-chat-item="acceptance"]')
    expect(await acceptanceBubble.locator('script').count()).toBe(0)
    expect(await acceptanceBubble.locator('.guidance-chat-text').innerHTML()).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')

    // 铅笔回到旧问题:Q2 气泡原位变编辑卡,完成态被解除,composer 恢复可答
    await page.locator('[data-edit-guidance="capability"]').first().click()
    await page.locator('[data-chat-item="capability"] [data-guidance-editor-surface]').waitFor()
    expect(await page.locator('[data-chat-item="capability"] [data-guidance-editor-surface]').textContent()).toContain('根据订单号返回承运商和最新节点')
    expect(await page.locator('[data-handoff-card]').evaluate(el => el.hidden)).toBe(true)
    expect(await page.locator('[data-guidance-composer]').getAttribute('aria-disabled')).toBe('false')
    expect(await readActiveEditor(page)).toBe('')
    await page.close()
  })

  it('restores the supplemental composer when a completed-answer edit is canceled', { timeout: 10000 }, async () => {
    const page = await openGuidance()
    try {
      await completeQuestions(page)
      await fillActiveEditor(page, '取消编辑后仍要保留的补充上下文。')

      await page.locator('[data-edit-answer="capability"]').dispatchEvent('click')
      await expectChatEditing(page, 'capability')
      expect(await page.locator('[data-handoff-card]').evaluate(element => element.hidden)).toBe(true)

      await page.locator('[data-chat-edit-cancel="capability"]').dispatchEvent('click')

      await expectComposerDone(page)
      expect(await page.locator('[data-guidance-step]').getAttribute('data-guidance-step')).toBe('complete')
      expect(await readActiveEditor(page)).toContain('取消编辑后仍要保留的补充上下文')
    } finally {
      await page.close()
    }
  })

  it('keeps 500ms autosave and flushes before step transitions', { timeout: 10000 }, async () => {
    let releaseSave
    delayedSave = new Promise(resolve => { releaseSave = resolve })
    const page = await openGuidance()
    try {
      await fillActiveEditor(page, '必须先保存再进入下一步')
      await page.waitForTimeout(350)
      expect(savedPrompts).toEqual([])

      await page.locator('[data-guidance-next]').click()
      await expect.poll(() => savedPrompts.length, { timeout: 300, interval: 10 }).toBe(1)
      expect(await page.locator('[data-guidance-step]').getAttribute('data-guidance-step')).toBe('1')
      expect(await page.locator('[data-guidance-next]').isDisabled()).toBe(true)

      releaseSave()
      delayedSave = null
      await expectStep(page, 2, '希望把这段操作变成什么能力？')
      expect(parseGuidanceMarkdown(savedPrompts[0]).actions).toBe('必须先保存再进入下一步')
    } finally {
      releaseSave?.()
      delayedSave = null
      await page.close()
    }
  })

  it('blocks navigation and handoff after save failure while keeping local input', { timeout: 10000 }, async () => {
    const page = await openGuidance()
    failSavesRemaining = 1
    await fillActiveEditor(page, '保存失败时保留')
    await page.locator('[data-guidance-next]').click()
    await page.locator('[data-save-error]').waitFor()

    expect(await page.locator('[data-guidance-step]').getAttribute('data-guidance-step')).toBe('1')
    expect(await readActiveEditor(page)).toBe('保存失败时保留')
    expect(handoffCalls).toBe(0)

    await page.locator('[data-retry-save]').click()
    await expect.poll(() => page.locator('[data-save-error]').count()).toBe(0)
    await page.locator('[data-guidance-next]').click()
    await expectStep(page, 2, '希望把这段操作变成什么能力？')
    await page.close()
  })

  it('migrates untouched legacy guidance before the agent handoff', { timeout: 15000 }, async () => {
    const legacy = '# 旧说明\n\n先查询订单，再打开物流详情。'
    promptText = legacy
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
    const page = await openGuidance(context)
    try {
      // legacy 内容已落在第一个问题上;保持 Q2/Q3 为空,直接发送两次即可到达完成态
      await expectStep(page, 2, '希望把这段操作变成什么能力？')
      await page.locator('[data-guidance-send]').dispatchEvent('click')
      await expectStep(page, 3, '怎样证明这个 skill 可以交付？')
      await page.locator('[data-guidance-send]').dispatchEvent('click')
      await expectComposerDone(page)
      await page.getByRole('button', { name: '导出并复制给外部 Agent' }).dispatchEvent('click')

      await expect.poll(() => handoffCalls).toBe(1)
      expect(parseGuidanceMarkdown(savedPrompts[0])).toEqual({ actions: legacy, capability: '', acceptance: '', notes: '', legacy: false })
      expect(requestEvents.indexOf('save:done')).toBeLessThan(requestEvents.indexOf('agent-handoff'))
      expect(requestEvents).not.toContain('legacy-external-prompt')
    } finally {
      await context.close()
    }
  })

  it('flushes, exports, then copies the backend prompt containing the final exported path', { timeout: 10000 }, async () => {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
    const page = await openGuidance(context)
    try {
      await completeQuestions(page)
      const button = page.getByRole('button', { name: '导出并复制给外部 Agent' })
      await button.dispatchEvent('click')
      await expect.poll(() => handoffCalls).toBe(1)
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(exportedPath)
      const copied = await page.evaluate(() => navigator.clipboard.readText())
      expect(copied).toContain('browser-forge skill')
      expect(copied).toContain(exportedPath)
      expect(copied).not.toContain(managedPath)
      expect(requestEvents.at(-2)).toBe('save:done')
      expect(requestEvents.at(-1)).toBe('agent-handoff')
      await expect.poll(() => page.locator('[data-handoff-status]').textContent()).toContain('已导出并复制')
      expect(await page.locator('[data-retry-copy]').isVisible()).toBe(false)
      expect(requestEvents).not.toContain('legacy-external-prompt')
    } finally {
      await context.close()
    }
  })

  it('treats a canceled export as a quiet return', { timeout: 10000 }, async () => {
    handoffMode = 'cancel'
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
    const page = await openGuidance(context)
    try {
      await completeQuestions(page)
      await page.getByRole('button', { name: '导出并复制给外部 Agent' }).dispatchEvent('click')
      await expect.poll(() => handoffCalls).toBe(1)
      await page.waitForTimeout(500)
      expect(await page.evaluate(() => {
        const b = document.querySelector('[data-agent-handoff]')
        return b ? { disabled: b.disabled, visible: !!b.offsetParent, label: b.textContent.trim().slice(0, 50), tone: b.closest('[data-handoff-card]')?.hidden } : null
      })).toEqual({ disabled: false, visible: true, label: '导出并复制给外部 Agent', tone: false })
      expect((await page.locator('[data-handoff-status]').textContent()).trim()).toBe('')
      expect(await page.locator('[data-retry-copy]').isVisible()).toBe(false)
    } finally {
      await context.close()
    }
  })

  it('restores an exported copy failure after editing navigation and never repeats handoff without changes', { timeout: 15000 }, async () => {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
    await installControlledClipboard(context)
    const page = await openGuidance(context)
    try {
      await completeQuestions(page)
      await page.getByRole('button', { name: '导出并复制给外部 Agent' }).dispatchEvent('click')

      await expect.poll(() => page.locator('[data-handoff-status]').textContent(), { timeout: 5000 }).toContain('复制失败')
      expect(await page.locator('[data-handoff-status]').textContent()).toContain(exportedPath)
      expect(handoffCalls).toBe(1)
      // 通过铅笔打开编辑但不改内容 → 已导出的交接保留(handoffCalls 不增长,状态仍显示复制失败)
      await page.locator('[data-edit-answer="acceptance"]').dispatchEvent('click')
      await expectChatEditing(page, 'acceptance')
      await page.locator('[data-chat-edit-send="acceptance"]').click()
      await expectComposerDone(page)

      expect(await page.locator('[data-handoff-status]').textContent()).toContain(exportedPath)
      expect(await page.locator('[data-handoff-status]').textContent()).toContain('复制失败')
      expect(await page.locator('[data-retry-copy]').isVisible()).toBe(true)

      await page.evaluate(() => { window.__clipboardShouldFail = false })
      await page.locator('[data-agent-handoff]').dispatchEvent('click')
      await expect.poll(() => page.locator('[data-handoff-status]').textContent(), { timeout: 5000 }).toContain('已导出并复制')
      await expect.poll(() => page.evaluate(() => window.__copiedText)).toContain(exportedPath)
      expect(handoffCalls).toBe(1)
    } finally {
      await context.close()
    }
  })

  it('invalidates the exported handoff only after guidance actually changes', { timeout: 10000 }, async () => {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
    await installControlledClipboard(context)
    const page = await openGuidance(context)
    try {
      await completeQuestions(page)
      await page.locator('[data-agent-handoff]').dispatchEvent('click')
      await expect.poll(() => handoffCalls).toBe(1)
      await expect.poll(() => page.locator('[data-handoff-status]').textContent()).toContain('复制失败')

      await page.locator('[data-edit-answer="acceptance"]').dispatchEvent('click')
      await expectChatEditing(page, 'acceptance')
      await page.locator('[data-chat-item="acceptance"] [data-guidance-editor-surface]').fill('使用 JD456 查询并与详情页核对')
      await page.locator('[data-chat-edit-send="acceptance"]').click()
      await expectComposerDone(page)

      expect((await page.locator('[data-handoff-status]').textContent()).trim()).toBe('')
      expect(await page.locator('[data-retry-copy]').isVisible()).toBe(false)
      await page.evaluate(() => { window.__clipboardShouldFail = false })
      await page.locator('[data-agent-handoff]').dispatchEvent('click')
      await expect.poll(() => handoffCalls).toBe(2)
    } finally {
      await context.close()
    }
  })

  it('uses dismissible alert semantics for handoff errors without losing copy retry', { timeout: 10000 }, async () => {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
    await installControlledClipboard(context)
    const page = await openGuidance(context)
    try {
      await completeQuestions(page)
      await page.locator('[data-agent-handoff]').dispatchEvent('click')
      const status = page.locator('[data-handoff-status]')
      await expect.poll(() => status.textContent()).toContain('复制失败')
      expect(await status.getAttribute('role')).toBe('alert')
      expect(await page.locator('[data-dismiss-handoff-error]').isVisible()).toBe(true)

      await page.locator('[data-dismiss-handoff-error]').dispatchEvent('click')
      expect((await status.textContent()).trim()).toBe('')
      expect(await page.locator('[data-retry-copy]').isVisible()).toBe(true)

      await page.evaluate(() => { window.__clipboardShouldFail = false })
      await page.locator('[data-retry-copy]').dispatchEvent('click')
      await expect.poll(() => status.textContent(), { timeout: 5000 }).toContain('已导出并复制')
      expect(await status.getAttribute('role')).toBe('status')
      expect(handoffCalls).toBe(1)
    } finally {
      await context.close()
    }
  })

  it('uses a dismissible alert for export failures while pending and success remain status messages', { timeout: 10000 }, async () => {
    handoffMode = 'error'
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
    const page = await openGuidance(context)
    try {
      await completeQuestions(page)
      await page.locator('[data-agent-handoff]').dispatchEvent('click')
      const status = page.locator('[data-handoff-status]')
      await expect.poll(() => status.textContent()).toContain('导出失败')
      expect(await status.getAttribute('role')).toBe('alert')
      expect(await page.locator('[data-dismiss-handoff-error]').isVisible()).toBe(true)

      await page.locator('[data-dismiss-handoff-error]').dispatchEvent('click')
      expect((await status.textContent()).trim()).toBe('')
      // renderHandoffCard 重建按钮,Playwright 需 poll 等到 disabled=false
      await expect.poll(() => page.evaluate(() => {
        const b = document.querySelector('[data-agent-handoff]')
        return b ? !b.disabled : false
      }), { timeout: 5000 }).toBe(true)
    } finally {
      await context.close()
    }
  })
})


async function installControlledClipboard(context) {
  await context.addInitScript(() => {
    window.__clipboardShouldFail = true
    window.__copiedText = ''
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async text => {
          if (window.__clipboardShouldFail) throw new Error('clipboard denied')
          window.__copiedText = text
        },
        readText: async () => window.__copiedText
      }
    })
  })
}

async function openGuidance(context = browser) {
  const page = await context.newPage()
  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.locator('[data-recording-id]').first().click()
  const toggle = page.locator('[data-toggle-analysis]')
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  await page.locator('[data-guidance-step]').waitFor({ timeout: 3_000 })
  return page
}

async function completeQuestions(page) {
  await fillActiveEditor(page, '查询订单并读取物流状态')
  await page.locator('[data-guidance-next]').dispatchEvent('click')
  await expectStep(page, 2, '希望把这段操作变成什么能力？')
  await fillActiveEditor(page, '根据订单号返回物流信息')
  await page.locator('[data-guidance-next]').dispatchEvent('click')
  await expectStep(page, 3, '怎样证明这个 skill 可以交付？')
  await fillActiveEditor(page, '使用 JD123 查询并与详情页核对')
  await page.locator('[data-guidance-send]').dispatchEvent('click')
  await expectComposerDone(page)
}

// 完成态:吸附 handoff 卡可见、composer 切换为可用的补充上下文输入
async function expectComposerDone(page) {
  await page.locator('[data-handoff-card]').waitFor({ state: 'visible', timeout: 5000 })
  await expect.poll(() => page.locator('[data-guidance-composer]').getAttribute('aria-disabled')).toBe('false')
  await expect.poll(() => activeEditorCount(page)).toBe(1)
}


async function expectChatEditing(page, key) {
  // 铅笔编辑态:气泡原位变编辑卡
  await page.locator(`[data-chat-item="${key}"] [data-guidance-editor-surface]`).waitFor({ timeout: 3000 })
}

async function expectStep(page, number, title) {
  await page.locator(`[data-guidance-step="${number}"]`).waitFor({ timeout: 3000 })
  const progress = await page.locator('[data-guidance-progress]').textContent()
  expect(progress.trim()).toBe(`第 ${number} / 3 个问题`)
  await page.getByRole('heading', { name: title }).waitFor({ timeout: 3000 })
  expect(await activeEditorCount(page)).toBe(1)
}

async function expectComposerFocused(page) {
  await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute('data-guidance-editor-surface') || document.activeElement?.hasAttribute('data-prompt-textarea'))).toBe(true)
}

async function activeEditorCount(page) {
  return page.locator('[data-guidance-composer] [data-guidance-editor-surface], [data-guidance-composer] textarea[data-prompt-textarea]:visible').count()
}

async function fillActiveEditor(page, value) {
  const surface = page.locator('[data-guidance-editor-surface]')
  if (await surface.count()) {
    await surface.fill(value)
    return
  }
  await page.locator('textarea[data-prompt-textarea]:visible').fill(value)
}

async function readActiveEditor(page) {
  return page.evaluate(() => {
    const composer = document.querySelector('[data-guidance-composer]')
    if (!composer) return ''
    const surface = composer.querySelector('[data-guidance-editor-surface]')
    if (surface) {
      return [...surface.children].map(block => block.innerText).join('\n\n').trim()
    }
    return composer.querySelector('textarea[data-prompt-textarea]:not([hidden])')?.value ?? ''
  })
}

function buildCompletePrompt(text, path) {
  const fields = parseGuidanceMarkdown(text)
  return [
    '请使用已安装的 browser-forge skill。',
    `录制路径：${path}`,
    `本次录制中的动作与意图：${fields.actions}`,
    `希望提取的 skill 能力：${fields.capability}`,
    `Skill 验收标准：${fields.acceptance}`,
    `补充上下文：${fields.notes}`,
    '根据 timeline.json 中的 videoOffsetMs 使用内置零依赖视频抽帧工具。',
    '交付可独立运行的 skill、清晰输入输出契约和 CLI 工具。'
  ].join('\n')
}

function json(res, value) {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(value))
}

function readBody(req) {
  return new Promise(resolve => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => resolve(JSON.parse(body || '{}')))
  })
}

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
