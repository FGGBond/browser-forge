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
      return json(res, { recordingId: id, path: exportedPath, text: buildCompletePrompt(promptText, exportedPath) })
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
  requestEvents = []
  handoffCalls = 0
  handoffMode = 'success'
})

afterAll(async () => {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
})

describe('three-question guided composer', () => {
  it('uses a centered non-interactive progress pill and focuses the composer instead of the question', async () => {
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
    await expectComposerFocused(page)
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

    await page.getByRole('button', { name: '检查并完成' }).click()
    await page.locator('[data-guidance-review]').waitFor()
    expect(await page.locator('[data-guidance-progress]').count()).toBe(0)
    expect(await page.getByText(/第 4 \/ 3/).count()).toBe(0)
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

    expect(styles.position).toBe('sticky')
    expect(styles.bottom).toBe('0px')
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

  it('walks all questions, preserves answers, reviews safely, and returns to edit', async () => {
    const page = await openGuidance()
    await fillActiveEditor(page, '查询订单并读取物流状态')
    await page.locator('[data-guidance-next]').click()
    await expectStep(page, 2, '希望把这段操作变成什么能力？')
    await fillActiveEditor(page, '根据订单号返回承运商和最新节点')

    await page.locator('[data-guidance-previous]').click()
    await expectStep(page, 1, '这次录制中，你完成了什么？')
    expect(await readActiveEditor(page)).toBe('查询订单并读取物流状态')
    await page.locator('[data-guidance-next]').click()
    await expectStep(page, 2, '希望把这段操作变成什么能力？')
    expect(await readActiveEditor(page)).toBe('根据订单号返回承运商和最新节点')

    await page.locator('[data-guidance-next]').click()
    await expectStep(page, 3, '怎样证明这个 skill 可以交付？')
    await fillActiveEditor(page, '使用 JD123 查询并核对 <script>alert(1)</script>')
    await page.getByRole('button', { name: '检查并完成' }).click()

    const review = page.locator('[data-guidance-review]')
    await review.waitFor()
    expect(await review.locator('script').count()).toBe(0)
    expect(await review.innerHTML()).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    await page.locator('[data-edit-guidance="capability"]').click()
    await expectStep(page, 2, '希望把这段操作变成什么能力？')
    expect(await readActiveEditor(page)).toBe('根据订单号返回承运商和最新节点')
    await page.close()
  })

  it('keeps 500ms autosave and flushes before step transitions', async () => {
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

  it('blocks navigation and handoff after save failure while keeping local input', async () => {
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

  it('migrates untouched legacy guidance before the agent handoff', async () => {
    const legacy = '# 旧说明\n\n先查询订单，再打开物流详情。'
    promptText = legacy
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
    const page = await openGuidance(context)
    try {
      await page.locator('[data-guidance-next]').click()
      await page.locator('[data-guidance-next]').click()
      await page.getByRole('button', { name: '检查并完成' }).click()
      await page.getByRole('button', { name: '导出并复制给外部 Agent' }).click()

      await expect.poll(() => handoffCalls).toBe(1)
      expect(parseGuidanceMarkdown(savedPrompts[0])).toEqual({ actions: legacy, capability: '', acceptance: '', legacy: false })
      expect(requestEvents.indexOf('save:done')).toBeLessThan(requestEvents.indexOf('agent-handoff'))
      expect(requestEvents).not.toContain('legacy-external-prompt')
    } finally {
      await context.close()
    }
  })

  it('flushes, exports, then copies the backend prompt containing the final exported path', async () => {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
    const page = await openGuidance(context)
    try {
      await completeQuestions(page)
      const button = page.getByRole('button', { name: '导出并复制给外部 Agent' })
      await button.click()

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

  it('treats a canceled export as a quiet return', async () => {
    handoffMode = 'cancel'
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
    const page = await openGuidance(context)
    try {
      await completeQuestions(page)
      await page.getByRole('button', { name: '导出并复制给外部 Agent' }).click()
      await expect.poll(() => handoffCalls).toBe(1)
      await expect.poll(() => page.getByRole('button', { name: '导出并复制给外部 Agent' }).isEnabled()).toBe(true)
      expect((await page.locator('[data-handoff-status]').textContent()).trim()).toBe('')
      expect(await page.locator('[data-retry-copy]').isVisible()).toBe(false)
    } finally {
      await context.close()
    }
  })

  it('restores an exported copy failure after editing navigation and never repeats handoff without changes', async () => {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
    await installControlledClipboard(context)
    const page = await openGuidance(context)
    try {
      await completeQuestions(page)
      await page.getByRole('button', { name: '导出并复制给外部 Agent' }).click()

      await expect.poll(() => page.locator('[data-handoff-status]').textContent()).toContain('复制失败')
      expect(await page.locator('[data-handoff-status]').textContent()).toContain(exportedPath)
      expect(handoffCalls).toBe(1)

      await page.locator('[data-guidance-previous]').click()
      await expectStep(page, 3, '怎样证明这个 skill 可以交付？')
      await page.getByRole('button', { name: '检查并完成' }).click()
      await page.locator('[data-guidance-review]').waitFor()

      expect(await page.locator('[data-handoff-status]').textContent()).toContain(exportedPath)
      expect(await page.locator('[data-handoff-status]').textContent()).toContain('复制失败')
      expect(await page.locator('[data-retry-copy]').isVisible()).toBe(true)

      await page.evaluate(() => { window.__clipboardShouldFail = false })
      await page.locator('[data-agent-handoff]').click()
      await expect.poll(() => page.evaluate(() => window.__copiedText)).toContain(exportedPath)
      expect(handoffCalls).toBe(1)
      await expect.poll(() => page.locator('[data-handoff-status]').textContent()).toContain('已导出并复制')
    } finally {
      await context.close()
    }
  })

  it('invalidates the exported handoff only after guidance actually changes', async () => {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
    await installControlledClipboard(context)
    const page = await openGuidance(context)
    try {
      await completeQuestions(page)
      await page.locator('[data-agent-handoff]').click()
      await expect.poll(() => handoffCalls).toBe(1)
      await expect.poll(() => page.locator('[data-handoff-status]').textContent()).toContain('复制失败')

      await page.locator('[data-guidance-previous]').click()
      await expectStep(page, 3, '怎样证明这个 skill 可以交付？')
      await fillActiveEditor(page, '使用 JD456 查询并与详情页核对')
      await page.getByRole('button', { name: '检查并完成' }).click()
      await page.locator('[data-guidance-review]').waitFor()

      expect((await page.locator('[data-handoff-status]').textContent()).trim()).toBe('')
      expect(await page.locator('[data-retry-copy]').isVisible()).toBe(false)
      await page.evaluate(() => { window.__clipboardShouldFail = false })
      await page.locator('[data-agent-handoff]').click()
      await expect.poll(() => handoffCalls).toBe(2)
    } finally {
      await context.close()
    }
  })

  it('uses dismissible alert semantics for handoff errors without losing copy retry', async () => {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
    await installControlledClipboard(context)
    const page = await openGuidance(context)
    try {
      await completeQuestions(page)
      await page.locator('[data-agent-handoff]').click()
      const status = page.locator('[data-handoff-status]')
      await expect.poll(() => status.textContent()).toContain('复制失败')
      expect(await status.getAttribute('role')).toBe('alert')
      expect(await page.locator('[data-dismiss-handoff-error]').isVisible()).toBe(true)

      await page.locator('[data-dismiss-handoff-error]').click()
      expect((await status.textContent()).trim()).toBe('')
      expect(await page.locator('[data-retry-copy]').isVisible()).toBe(true)

      await page.evaluate(() => { window.__clipboardShouldFail = false })
      await page.locator('[data-retry-copy]').click()
      await expect.poll(() => status.textContent()).toContain('已导出并复制')
      expect(await status.getAttribute('role')).toBe('status')
      expect(handoffCalls).toBe(1)
    } finally {
      await context.close()
    }
  })

  it('uses a dismissible alert for export failures while pending and success remain status messages', async () => {
    handoffMode = 'error'
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
    const page = await openGuidance(context)
    try {
      await completeQuestions(page)
      await page.locator('[data-agent-handoff]').click()
      const status = page.locator('[data-handoff-status]')
      await expect.poll(() => status.textContent()).toContain('导出失败')
      expect(await status.getAttribute('role')).toBe('alert')
      expect(await page.locator('[data-dismiss-handoff-error]').isVisible()).toBe(true)

      await page.locator('[data-dismiss-handoff-error]').click()
      expect((await status.textContent()).trim()).toBe('')
      expect(await page.locator('[data-agent-handoff]').isEnabled()).toBe(true)
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
  await page.locator('[data-toggle-analysis]').click()
  await page.locator('[data-guidance-step]').waitFor({ timeout: 2_000 })
  await expectComposerFocused(page)
  return page
}

async function completeQuestions(page) {
  await fillActiveEditor(page, '查询订单并读取物流状态')
  await page.locator('[data-guidance-next]').click()
  await expectStep(page, 2, '希望把这段操作变成什么能力？')
  await fillActiveEditor(page, '根据订单号返回物流信息')
  await page.locator('[data-guidance-next]').click()
  await expectStep(page, 3, '怎样证明这个 skill 可以交付？')
  await fillActiveEditor(page, '使用 JD123 查询并与详情页核对')
  await page.getByRole('button', { name: '检查并完成' }).click()
  await page.locator('[data-guidance-review]').waitFor()
}

async function expectStep(page, number, title) {
  const step = page.locator(`[data-guidance-step="${number}"]`)
  await step.waitFor()
  expect((await page.locator('[data-guidance-progress]').textContent()).trim()).toBe(`第 ${number} / 3 个问题`)
  await page.getByText(title, { exact: true }).waitFor()
  expect(await activeEditorCount(page)).toBe(1)
}

async function expectComposerFocused(page) {
  await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute('data-guidance-editor-surface') || document.activeElement?.hasAttribute('data-prompt-textarea'))).toBe(true)
}

async function activeEditorCount(page) {
  return page.locator('[data-guidance-step] [data-guidance-editor-surface], [data-guidance-step] textarea[data-prompt-textarea]:visible').count()
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
    const surface = document.querySelector('[data-guidance-editor-surface]')
    if (surface) {
      return [...surface.children].map(block => block.innerText).join('\n\n').trim()
    }
    return document.querySelector('textarea[data-prompt-textarea]:not([hidden])')?.value ?? ''
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
