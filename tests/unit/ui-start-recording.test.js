import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { readFileSync, statSync } from 'fs'
import { extname, join } from 'path'

let browser
let server
let baseUrl
let wss
let startRequests
let startFailure
let permissionCheckResult
let permissionRequestResult
let permissionCheckCount
let permissionRequestCount
let settingsRequestCount
let permissionResetCount
let appRevealCount
let restartCount
let recordingDetailDelayMs
let stopRequestCount
let stopResponseDelayMs
let liveSummary

const grantedPermission = { supported: true, status: 'granted', granted: true, restartRequired: false }
const missingPermission = { supported: true, status: 'not-granted', granted: false, restartRequired: false }
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }

beforeAll(async () => {
  browser = await chromium.launch()
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/api/recordings') return json(res, { recordings: [] })
    if (url.pathname === '/api/recordings/3d4527e4-4d47-4aea-a4ba-cd61218bbd27') {
      const detail = { id: '3d4527e4-4d47-4aea-a4ba-cd61218bbd27', title: '自动完成的录制', state: 'active', createdAt: '2026-08-08T12:15:00.000Z', durationMs: 1000, startHost: 'example.com', visitedHosts: ['example.com'], videoStatus: 'failed', promptStatus: 'empty', sizeBytes: 100 }
      return recordingDetailDelayMs ? setTimeout(() => json(res, detail), recordingDetailDelayMs) : json(res, detail)
    }
    if (url.pathname.endsWith('/timeline')) return json(res, { events: [] })
    if (url.pathname.endsWith('/prompt')) return json(res, { text: '', status: 'empty', updatedAt: null })
    if (url.pathname === '/api/chrome-path') return json(res, { path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
    if (url.pathname === '/api/screen-recording-permission' && req.method === 'GET') {
      permissionCheckCount += 1
      return json(res, permissionCheckResult)
    }
    if (url.pathname === '/api/screen-recording-permission/request' && req.method === 'POST') {
      permissionRequestCount += 1
      return json(res, permissionRequestResult)
    }
    if (url.pathname === '/api/screen-recording-permission/open-settings' && req.method === 'POST') {
      settingsRequestCount += 1
      res.statusCode = 204
      return res.end()
    }
    if (url.pathname === '/api/screen-recording-permission/reveal-app' && req.method === 'POST') {
      appRevealCount += 1
      res.statusCode = 204
      return res.end()
    }
    if (url.pathname === '/api/screen-recording-permission/reset' && req.method === 'POST') {
      permissionResetCount += 1
      return json(res, { ok: true, service: 'ScreenCapture', bundleId: 'com.browserforge.app' })
    }
    if (url.pathname === '/api/restart' && req.method === 'POST') {
      restartCount += 1
      res.statusCode = 202
      return json(res, { ok: true, restarting: true })
    }
    if (url.pathname === '/api/summary') return json(res, liveSummary)
    if (url.pathname === '/api/stop-recording' && req.method === 'POST') {
      stopRequestCount += 1
      const result = { ok: true, recordingId: '3d4527e4-4d47-4aea-a4ba-cd61218bbd27' }
      return stopResponseDelayMs ? setTimeout(() => json(res, result), stopResponseDelayMs) : json(res, result)
    }
    if (url.pathname === '/api/start-recording') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        startRequests.push(JSON.parse(body))
        if (startFailure) return json(res, { ok: false, code: 'SCREEN_RECORDING_PERMISSION_REQUIRED', error: 'capture denied', permission: missingPermission })
        json(res, { ok: true, port: 9333, recordingId: '3d4527e4-4d47-4aea-a4ba-cd61218bbd27' })
      })
      return
    }
    serveUi(url.pathname, res)
  })
  wss = new WebSocketServer({ server })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

afterAll(async () => {
  await browser.close()
  await new Promise(resolve => wss.close(resolve))
  await new Promise(resolve => server.close(resolve))
})

function reset({ check = grantedPermission, request = grantedPermission, failStart = false } = {}) {
  startRequests = []
  startFailure = failStart
  permissionCheckResult = check
  permissionRequestResult = request
  permissionCheckCount = 0
  permissionRequestCount = 0
  settingsRequestCount = 0
  permissionResetCount = 0
  appRevealCount = 0
  restartCount = 0
  recordingDetailDelayMs = 0
  stopRequestCount = 0
  stopResponseDelayMs = 0
  liveSummary = { type: 'summary', startedAt: null, tabs: [], totals: { events: 0, network: 0, console: 0, artifacts: 0 } }
}

async function openNewRecording() {
  const page = await browser.newPage()
  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: '新录制', exact: true }).first().click()
  await expect.poll(() => page.locator('[data-chrome-path]').inputValue()).toContain('Google Chrome')
  return page
}

describe('managed start recording UI', () => {
  it('starts with detected Chrome only and contains no output-directory control when permission is granted', async () => {
    reset()
    const page = await openNewRecording()

    const prepare = page.locator('.recording-prepare')
    expect(await page.locator('#output-dir').count()).toBe(0)
    expect(await prepare.getByRole('heading', { name: '准备录制' }).count()).toBe(1)
    expect(await prepare.getByText('描述这次操作的目标，随后在 Chrome 中完成流程。', { exact: true }).count()).toBe(1)
    expect(await prepare.locator('.nr-suggestion, [data-suggestion]').count()).toBe(0)
    expect(await prepare.getByRole('status').textContent()).toContain('Chrome 与屏幕录制权限已就绪')
    const composer = prepare.locator('.goal-composer')
    expect(await composer.locator('.goal-context-note, .advanced-settings, .permission-actions').count()).toBe(0)
    expect(await prepare.locator('[data-primary-action]').count()).toBe(1)
    expect(await composer.getByRole('button').count()).toBe(1)
    const startButton = composer.getByRole('button', { name: '开始录制' })
    await page.locator('[data-goal-text]').fill('  查询订单状态  ')
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/api/start-recording')),
      startButton.click()
    ])

    expect(startRequests).toEqual([{ chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', goalText: '查询订单状态' }])
    expect(permissionRequestCount).toBe(0)
    await page.locator('[data-stop]').waitFor()
    expect(await page.locator('[data-nav="library"]').isDisabled()).toBe(true)
    expect(await page.getByRole('button', { name: '回收站', exact: true }).isDisabled()).toBe(true)
    expect(await page.getByRole('button', { name: '新录制', exact: true }).first().isDisabled()).toBe(true)
    await expect.poll(() => wss.clients.size).toBe(1)
    const completedRecording = { id: '3d4527e4-4d47-4aea-a4ba-cd61218bbd27', title: '自动完成的录制', state: 'active', createdAt: '2026-08-08T12:15:00.000Z', durationMs: 1000, startHost: 'example.com', visitedHosts: ['example.com'], videoStatus: 'failed', promptStatus: 'empty' }
    for (const client of wss.clients) client.send(JSON.stringify({ type: 'recording-completed', recordingId: completedRecording.id, recording: completedRecording }))
    await expect.poll(() => page.locator('[data-title-input]').inputValue()).toBe('自动完成的录制')
    const sidebarRecording = page.locator(`[data-recording-nav="${completedRecording.id}"]`)
    await sidebarRecording.waitFor()
    expect(await sidebarRecording.getByText('自动完成的录制', { exact: true }).count()).toBe(1)
    expect(await sidebarRecording.getByText('example.com', { exact: true }).count()).toBe(0)
    expect(await sidebarRecording.locator('[data-recording-folder="open"]').count()).toBe(1)
    expect(await page.locator('[data-nav="library"]').isDisabled()).toBe(false)
    await page.close()
  }, 15_000)

  it('keeps active and finalizing states to one primary action and ignores duplicate stop submissions', async () => {
    reset()
    stopResponseDelayMs = 800
    const page = await openNewRecording()

    await page.getByRole('button', { name: '开始录制' }).click()
    const active = page.locator('.recording-active')
    const stopButton = active.locator('[data-stop]')
    await stopButton.waitFor()

    expect(await active.getByRole('heading', { name: '录制进行中' }).count()).toBe(1)
    expect(await active.locator('[data-primary-action]').count()).toBe(1)
    expect(await active.getByRole('status').textContent()).toContain('正在记录 Chrome 中的页面操作')
    expect(await active.getByRole('progressbar').count()).toBe(0)

    const stopped = page.waitForResponse(response => response.url().endsWith('/api/stop-recording'))
    await stopButton.evaluate(button => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await expect.poll(() => stopButton.isDisabled()).toBe(true)
    expect(await active.getByRole('heading', { name: '正在准备回放' }).count()).toBe(1)
    expect(await active.locator('[data-primary-action]').count()).toBe(1)
    expect(await active.getByRole('status').textContent()).toContain('录制已停止，正在整理已捕获的内容')
    expect(await active.getByRole('progressbar').count()).toBe(0)
    expect(stopRequestCount).toBe(1)

    await stopped
    await expect.poll(() => stopRequestCount).toBe(1)
    await page.close()
  }, 15_000)

  it('shows elapsed recording time from the live summary and updates it every second', async () => {
    reset()
    liveSummary.startedAt = Date.now() - 65_000
    const page = await openNewRecording()

    await page.getByRole('button', { name: '开始录制' }).click()
    const elapsed = page.locator('[data-recording-elapsed]')
    await elapsed.waitFor()
    await expect.poll(() => elapsed.textContent()).toMatch(/^01:[0-5]\d$/)

    const initialElapsed = await elapsed.textContent()
    await expect.poll(() => elapsed.textContent(), { timeout: 2500 }).not.toBe(initialElapsed)
    await page.close()
  })

  it('freezes the last page summary while the recording is finalizing', async () => {
    reset()
    stopResponseDelayMs = 1500
    liveSummary.tabs = [{ targetId: 'initial', title: '初始页面', url: 'https://initial.example/' }]
    const page = await openNewRecording()

    try {
      await page.getByRole('button', { name: '开始录制' }).click()
      await page.getByText('初始页面', { exact: true }).waitFor()
      await expect.poll(() => wss.clients.size).toBe(1)

      for (const client of wss.clients) client.send(JSON.stringify({
        type: 'summary',
        startedAt: liveSummary.startedAt,
        tabs: [{ targetId: 'before-stop', title: '停止前页面', url: 'https://before-stop.example/' }]
      }))
      await page.getByText('停止前页面', { exact: true }).waitFor()

      await page.locator('[data-stop]').click()
      await page.getByRole('heading', { name: '正在准备回放' }).waitFor()
      for (const client of wss.clients) client.send(JSON.stringify({
        type: 'summary',
        startedAt: liveSummary.startedAt,
        tabs: [{ targetId: 'after-stop', title: '停止后页面', url: 'https://after-stop.example/' }]
      }))
      await page.waitForTimeout(250)

      expect(await page.getByText('停止前页面', { exact: true }).count()).toBe(1)
      expect(await page.getByText('停止后页面', { exact: true }).count()).toBe(0)
    } finally {
      await page.close()
    }
  }, 10_000)

  it('shows a recordingId-only completion immediately while detail hydration is pending', async () => {
    reset()
    recordingDetailDelayMs = 1200
    const page = await openNewRecording()
    try {
      await page.getByRole('button', { name: '开始录制' }).click()
      await page.locator('[data-stop]').waitFor()
      await expect.poll(() => wss.clients.size).toBeGreaterThan(0)
      for (const client of wss.clients) client.send(JSON.stringify({
        type: 'recording-completed',
        recordingId: '3d4527e4-4d47-4aea-a4ba-cd61218bbd27'
      }))

      const sidebarRecording = page.locator('[data-recording-nav="3d4527e4-4d47-4aea-a4ba-cd61218bbd27"]')
      await sidebarRecording.waitFor({ timeout: 500 })
      expect(await sidebarRecording.locator('strong').textContent()).toMatch(/^Recording-\d+月\d+日\d{2}:\d{2}$/)
      await expect.poll(() => sidebarRecording.locator('strong').textContent(), { timeout: 4000 }).toBe('自动完成的录制')
    } finally {
      recordingDetailDelayMs = 0
      await page.close()
    }
  }, 10_000)

  it('shows a partial completion payload in the sidebar before detail hydration finishes', async () => {
    reset()
    recordingDetailDelayMs = 1200
    const page = await openNewRecording()
    try {
      await page.getByRole('button', { name: '开始录制' }).click()
      await page.locator('[data-stop]').waitFor()
      await expect.poll(() => wss.clients.size).toBeGreaterThan(0)
      for (const client of wss.clients) client.send(JSON.stringify({
        type: 'recording-completed',
        recordingId: '3d4527e4-4d47-4aea-a4ba-cd61218bbd27',
        recording: { id: '3d4527e4-4d47-4aea-a4ba-cd61218bbd27', title: '正在整理的录制' }
      }))

      const sidebarRecording = page.locator('[data-recording-nav="3d4527e4-4d47-4aea-a4ba-cd61218bbd27"]')
      await sidebarRecording.waitFor({ timeout: 500 })
      expect(await sidebarRecording.getByText('正在整理的录制', { exact: true }).count()).toBe(1)
      await expect.poll(() => page.locator('[data-title-input]').inputValue(), { timeout: 4000 }).toBe('自动完成的录制')
      await expect.poll(() => sidebarRecording.locator('strong').textContent()).toBe('自动完成的录制')
    } finally {
      recordingDetailDelayMs = 0
      await page.close()
    }
  }, 10_000)

  it('requests permission from macOS and continues into recording when access is granted', async () => {
    reset({ check: missingPermission, request: grantedPermission })
    const page = await openNewRecording()

    await page.getByRole('button', { name: '开始录制' }).click()

    await page.locator('[data-stop]').waitFor()
    expect(permissionRequestCount).toBe(1)
    expect(startRequests).toHaveLength(1)
    await page.close()
  })

  it('recovers a stale ad-hoc grant by resetting only Browser Forge and opening fixed manual authorization targets', async () => {
    reset({
      check: missingPermission,
      request: { supported: true, status: 'denied', granted: false, restartRequired: false }
    })
    const page = await openNewRecording()

    await page.getByRole('button', { name: '开始录制' }).click()

    await expect.poll(() => settingsRequestCount).toBe(1)
    const notice = page.locator('[data-notice-stack] [role="alert"]').last()
    await expect.poll(() => notice.textContent()).toContain('屏幕录制权限')
    expect(await notice.textContent()).toContain('左侧“全部录制”')
    expect(await notice.textContent()).not.toContain('Browser Forge Recorder')
    expect(await notice.getByRole('button', { name: '关闭提示' }).count()).toBe(1)
    expect(startRequests).toEqual([])
    expect(permissionRequestCount).toBe(1)
    expect(permissionResetCount).toBe(0)
    expect(appRevealCount).toBe(0)

    await notice.getByRole('button', { name: '关闭提示' }).click()
    await expect.poll(() => notice.count()).toBe(0)
    await page.close()
  })

  it('keeps permission recovery out of the composer and opens System Settings automatically only after the user starts', async () => {
    reset({ check: missingPermission, request: { supported: true, status: 'denied', granted: false, restartRequired: false } })
    const page = await openNewRecording()

    expect(settingsRequestCount).toBe(0)
    expect(await page.locator('.goal-composer').getByRole('button').count()).toBe(1)
    await page.getByRole('button', { name: '开始录制' }).click()

    await expect.poll(() => settingsRequestCount).toBe(1)
    expect(await page.getByRole('button', { name: '打开系统设置' }).count()).toBe(0)
    expect(await page.getByRole('button', { name: '再次检查权限' }).count()).toBe(0)
    expect(await page.getByRole('button', { name: '开始录制' }).isDisabled()).toBe(true)
    expect(await page.locator('[data-primary-action]:not([disabled])').count()).toBe(0)
    await page.close()
  })

  it('rechecks permission automatically when the App regains focus', async () => {
    reset({ check: missingPermission, request: { supported: true, status: 'denied', granted: false, restartRequired: false } })
    const page = await openNewRecording()

    await page.getByRole('button', { name: '开始录制' }).click()
    await expect.poll(() => settingsRequestCount).toBe(1)
    permissionCheckResult = grantedPermission
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))

    await expect.poll(() => permissionCheckCount).toBe(2)
    await page.locator('[data-stop]').waitFor()
    expect(startRequests).toHaveLength(1)
    expect(permissionRequestCount).toBe(1)
    expect(permissionResetCount).toBe(0)
    expect(appRevealCount).toBe(0)
    await page.close()
  })

  it('does not launch Chrome and asks for an App restart when macOS reports restart-required', async () => {
    reset({
      check: missingPermission,
      request: { supported: true, status: 'restart-required', granted: false, restartRequired: true }
    })
    const page = await openNewRecording()

    await page.getByRole('button', { name: '开始录制' }).click()

    const notice = page.locator('[data-notice-stack] [role="alert"]').last()
    await expect.poll(() => notice.textContent()).toContain('重新启动 Browser Forge')
    expect(startRequests).toEqual([])
    expect(await page.getByRole('button', { name: '授权后重新启动 Browser Forge' }).isVisible()).toBe(true)
    expect(await page.getByRole('button', { name: '打开系统设置' }).count()).toBe(0)
    expect(await page.getByRole('button', { name: '开始录制' }).isDisabled()).toBe(true)
    const recoveryPrimary = page.locator('[data-primary-action]:not([disabled])')
    expect(await recoveryPrimary.count()).toBe(1)
    expect(await recoveryPrimary.textContent()).toContain('授权后重新启动 Browser Forge')
    await page.getByRole('button', { name: '授权后重新启动 Browser Forge' }).click()
    await expect.poll(() => restartCount).toBe(1)
    await page.close()
  })
})

function json(res, value) {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(value))
}

function serveUi(pathname, res) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1)
  const path = join(process.cwd(), 'ui', relative)
  try {
    if (!statSync(path).isFile()) throw new Error('not file')
    res.setHeader('content-type', contentTypes[extname(path)] || 'application/octet-stream')
    res.end(readFileSync(path))
  } catch {
    res.statusCode = 404
    res.end('not found')
  }
}
