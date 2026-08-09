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
const id = '3d4527e4-4d47-4aea-a4ba-cd61218bbd27'
const recordingPath = `/Users/example/Library/Application Support/Browser Forge/recordings/active/${id}`
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
    if (url.pathname === `/api/recordings/${id}/external-agent-prompt`) {
      requestEvents.push('external-prompt')
      return json(res, { recordingId: id, text: buildCompletePrompt(promptText) })
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
})

afterAll(async () => {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
})

describe('three-step guidance editor', () => {
  it('walks all three Markdown questions, reviews safely, and returns to edit an answer', async () => {
    const page = await openGuidance()

    await expectStep(page, 1, '这次录制中，你完成了什么？')
    expect(await page.getByText('尚未配置 Agent', { exact: true }).count()).toBe(1)
    expect(await page.getByText('browser-forge skill', { exact: true }).count()).toBe(1)
    expect(await page.getByText('Agent guidance', { exact: true }).count()).toBe(0)
    expect(await page.getByText('说明尚未保存', { exact: true }).count()).toBe(0)
    expect(await page.locator('[data-save-state]').count()).toBe(0)
    expect(await activeEditorCount(page)).toBe(1)

    await fillActiveEditor(page, '# 查询订单\n\n读取 **物流状态**。')
    await page.locator('[data-guidance-next]').click()
    await expectStep(page, 2, '希望把这段操作变成什么能力？')
    await fillActiveEditor(page, '根据订单号返回承运商和最新节点')

    await page.locator('[data-guidance-previous]').click()
    await expectStep(page, 1, '这次录制中，你完成了什么？')
    expect(await readActiveEditor(page)).toBe('# 查询订单\n\n读取 **物流状态**。')
    await page.locator('[data-guidance-next]').click()
    expect(await readActiveEditor(page)).toBe('根据订单号返回承运商和最新节点')

    await page.locator('[data-guidance-next]').click()
    await expectStep(page, 3, '怎样证明这个 skill 可以交付？')
    await fillActiveEditor(page, '使用 JD123 查询并与详情页核对\n\n<script>alert(1)</script>')
    await page.getByRole('button', { name: '检查并完成' }).click()

    await page.locator('[data-guidance-review]').waitFor()
    expect(await activeEditorCount(page)).toBe(0)
    await page.getByRole('heading', { name: '查询订单' }).waitFor()
    await page.getByText('读取 物流状态。').waitFor()
    await page.getByText('根据订单号返回承运商和最新节点').waitFor()
    await page.getByText('使用 JD123 查询并与详情页核对').waitFor()
    expect(await page.locator('[data-guidance-review] script').count()).toBe(0)
    expect(await page.locator('[data-guidance-review]').innerHTML()).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')

    await page.locator('[data-edit-guidance="capability"]').click()
    await expectStep(page, 2, '希望把这段操作变成什么能力？')
    expect(await readActiveEditor(page)).toBe('根据订单号返回承运商和最新节点')
    await page.close()
  })

  it('keeps empty guidance empty and preserves a legacy prompt verbatim in the first answer', async () => {
    let page = await openGuidance()
    expect(await readActiveEditor(page)).toBe('')
    expect(await page.locator('[data-prompt-textarea]').getAttribute('placeholder')).toBeTruthy()
    await page.waitForTimeout(650)
    expect(savedPrompts).toEqual([])
    await page.close()

    const legacy = '# 旧说明\n\n先查询订单，再打开物流详情。\n\n- 保留登录状态\n- 不要提交表单'
    promptText = legacy
    page = await openGuidance()
    expect(await readActiveEditor(page)).toBe(legacy)
    await page.locator('[data-guidance-next]').click()
    await fillActiveEditor(page, '把旧操作变成可复用的订单查询能力')

    await expect.poll(() => savedPrompts.length).toBe(1)
    expect(parseGuidanceMarkdown(savedPrompts[0])).toEqual({
      actions: legacy,
      capability: '把旧操作变成可复用的订单查询能力',
      acceptance: '',
      legacy: false
    })
    await page.close()
  })

  it('autosaves the complete structured guidance after 500ms without normal save-state microcopy', async () => {
    const page = await openGuidance()
    await fillActiveEditor(page, '查询订单并读取物流状态')

    await page.waitForTimeout(350)
    expect(savedPrompts).toEqual([])
    await expect.poll(() => savedPrompts.length).toBe(1)
    expect(parseGuidanceMarkdown(savedPrompts[0])).toEqual({
      actions: '查询订单并读取物流状态',
      capability: '',
      acceptance: '',
      legacy: false
    })
    expect(await page.locator('[data-save-state]').count()).toBe(0)
    for (const status of ['未保存', '正在保存', '已保存', '说明尚未保存']) {
      expect(await page.getByText(status, { exact: true }).count()).toBe(0)
    }
    await page.close()
  })

  it('continues with the newest revision when an earlier autosave is still in flight', async () => {
    let releaseSave
    delayedSave = new Promise(resolve => { releaseSave = resolve })
    const page = await openGuidance()

    await fillActiveEditor(page, '第一版指导')
    await expect.poll(() => savedPrompts.length).toBe(1)
    await fillActiveEditor(page, '第二版指导')
    releaseSave()
    delayedSave = null

    await expect.poll(() => savedPrompts.length).toBe(2)
    expect(savedPrompts.map(text => parseGuidanceMarkdown(text).actions)).toEqual(['第一版指导', '第二版指导'])
    expect(await readActiveEditor(page)).toBe('第二版指导')
    await page.close()
  })

  it('keeps dirty content through save failure, supports dismiss and retry, and hides the alert after recovery', async () => {
    failSavesRemaining = 1
    const page = await openGuidance()
    await fillActiveEditor(page, '重要指导')

    const alert = page.locator('[data-save-error]')
    await alert.waitFor()
    expect(await alert.getAttribute('role')).toBe('alert')
    expect(await alert.textContent()).toContain('保存失败，内容仍保留在编辑器中。')
    expect(await readActiveEditor(page)).toBe('重要指导')

    await page.locator('[data-dismiss-save-error]').click()
    await expect.poll(() => alert.count()).toBe(0)
    expect(await readActiveEditor(page)).toBe('重要指导')

    await fillActiveEditor(page, '重要指导（自动恢复）')
    await expect.poll(() => savedPrompts.length).toBe(2)
    expect(parseGuidanceMarkdown(savedPrompts.at(-1)).actions).toBe('重要指导（自动恢复）')
    expect(await alert.count()).toBe(0)

    failSavesRemaining = 1
    await fillActiveEditor(page, '重要指导（手动重试）')
    await alert.waitFor()
    await page.locator('[data-retry-save]').click()
    await expect.poll(() => alert.count()).toBe(0)
    await expect.poll(() => savedPrompts.length).toBe(4)
    expect(parseGuidanceMarkdown(savedPrompts.at(-1)).actions).toBe('重要指导（手动重试）')
    await page.close()
  })

  it('returns false from flush/beforeNavigate on failure so navigation is blocked', async () => {
    failSavesRemaining = 1
    const page = await openGuidance()
    await fillActiveEditor(page, '离开前必须保存的指导')
    await page.locator('[data-close-analysis]').click()
    await page.locator('[data-nav="library"]').click()

    await page.locator('[data-analysis-workspace]').waitFor()
    expect(savedPrompts).toHaveLength(1)
    await page.locator('[data-toggle-analysis]').click()
    await page.locator('[data-save-error]').waitFor()
    expect(await page.locator('[data-save-error]').textContent()).toContain('保存失败，内容仍保留在编辑器中。')
    expect(await readActiveEditor(page)).toBe('离开前必须保存的指导')
    await page.close()
  })

  it('flushes all three answers before copying the external Agent prompt', async () => {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
    const page = await openGuidance(context)
    await fillActiveEditor(page, '查询订单并读取物流状态')
    await page.locator('[data-guidance-next]').click()
    await fillActiveEditor(page, '根据订单号返回物流信息')
    await page.locator('[data-guidance-next]').click()
    await fillActiveEditor(page, '使用 JD123 查询并与详情页核对')
    await page.getByRole('button', { name: '检查并完成' }).click()
    await page.locator('[data-copy-agent-prompt]').click()

    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toBe('')
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    for (const required of [
      'browser-forge skill',
      recordingPath,
      '查询订单并读取物流状态',
      '根据订单号返回物流信息',
      '使用 JD123 查询并与详情页核对',
      'videoOffsetMs',
      '必须实际执行用户给出的验收任务',
      '可独立运行的 skill',
      'CLI'
    ]) {
      expect(copied).toContain(required)
    }
    expect(requestEvents.at(-2)).toBe('save:done')
    expect(requestEvents.at(-1)).toBe('external-prompt')
    await expect.poll(() => page.locator('[data-copy-agent-prompt]').textContent()).toContain('已复制')
    await context.close()
  })

  it('renders 待补充 for unanswered items on the review page', async () => {
    const page = await openGuidance()
    await page.locator('[data-guidance-next]').click()
    await page.locator('[data-guidance-next]').click()
    await page.getByRole('button', { name: '检查并完成' }).click()

    expect(await page.getByText('待补充', { exact: true }).count()).toBe(3)
    expect(await page.locator('[data-edit-guidance]').count()).toBe(3)
    await page.close()
  })
})

async function openGuidance(context = browser) {
  const page = await context.newPage()
  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.locator('[data-recording-id]').click()
  await page.locator('[data-toggle-analysis]').click()
  await page.locator('[data-guidance-step]').waitFor({ timeout: 2_000 })
  return page
}

async function expectStep(page, number, title) {
  const step = page.locator('[data-guidance-step]')
  await step.waitFor()
  expect(await step.getAttribute('data-guidance-step')).toBe(String(number))
  expect(await page.locator('[data-guidance-progress]').textContent()).toContain(`${number}/3`)
  await page.getByText(title, { exact: true }).waitFor()
  expect(await activeEditorCount(page)).toBe(1)
}

async function activeEditorCount(page) {
  return page.locator('[data-guidance-step] .EasyMDEContainer, [data-guidance-step] textarea[data-prompt-textarea]:visible').count()
}

async function fillActiveEditor(page, value) {
  await page.evaluate(nextValue => {
    const wrapper = document.querySelector('[data-guidance-step] .CodeMirror')
    if (wrapper?.CodeMirror) {
      wrapper.CodeMirror.setValue(nextValue)
      return
    }
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

function buildCompletePrompt(text) {
  const fields = parseGuidanceMarkdown(text)
  return [
    '请使用已安装的 browser-forge skill。',
    `录制路径：${recordingPath}`,
    `本次录制中的动作与意图：${fields.actions}`,
    `希望提取的 skill 能力：${fields.capability}`,
    `Skill 验收标准：${fields.acceptance}`,
    '根据 timeline.json 中的 videoOffsetMs 使用内置零依赖视频抽帧工具。',
    '交付可独立运行的 skill、清晰输入输出契约和 CLI 工具。',
    '必须实际执行用户给出的验收任务，并逐项说明是否满足验收标准。'
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
