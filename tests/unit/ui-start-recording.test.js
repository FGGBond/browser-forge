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
let helperRevealCount

const grantedPermission = { supported: true, status: 'granted', granted: true, restartRequired: false }
const missingPermission = { supported: true, status: 'not-granted', granted: false, restartRequired: false }
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }

beforeAll(async () => {
  browser = await chromium.launch()
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/api/recordings') return json(res, { recordings: [] })
    if (url.pathname === '/api/recordings/3d4527e4-4d47-4aea-a4ba-cd61218bbd27') return json(res, { id: '3d4527e4-4d47-4aea-a4ba-cd61218bbd27', title: '自动完成的录制', state: 'active', createdAt: '2026-08-08T12:15:00.000Z', durationMs: 1000, startHost: 'example.com', videoStatus: 'failed', promptStatus: 'empty', sizeBytes: 100 })
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
    if (url.pathname === '/api/screen-recording-permission/reveal-helper' && req.method === 'POST') {
      helperRevealCount += 1
      res.statusCode = 204
      return res.end()
    }
    if (url.pathname === '/api/summary') return json(res, { type: 'summary', startedAt: null, tabs: [], totals: { events: 0, network: 0, console: 0, artifacts: 0 } })
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
  helperRevealCount = 0
}

async function openNewRecording() {
  const page = await browser.newPage()
  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: '新建录制' }).first().click()
  await expect.poll(() => page.locator('[data-chrome-path]').inputValue()).toContain('Google Chrome')
  return page
}

describe('managed start recording UI', () => {
  it('starts with detected Chrome only and contains no output-directory control when permission is granted', async () => {
    reset()
    const page = await openNewRecording()

    expect(await page.locator('#output-dir').count()).toBe(0)
    expect(await page.getByText('只会录制 Browser Forge 打开的 Chrome 窗口').count()).toBeGreaterThan(0)

    await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/api/start-recording')),
      page.getByRole('button', { name: '打开 Chrome 并开始录制' }).click()
    ])

    expect(startRequests).toEqual([{ chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }])
    expect(permissionRequestCount).toBe(0)
    await page.locator('[data-stop]').waitFor()
    expect(await page.getByRole('button', { name: '全部录制' }).isDisabled()).toBe(true)
    expect(await page.getByRole('button', { name: '回收站', exact: true }).isDisabled()).toBe(true)
    expect(await page.getByRole('button', { name: '新建录制' }).first().isDisabled()).toBe(true)
    await expect.poll(() => wss.clients.size).toBe(1)
    for (const client of wss.clients) client.send(JSON.stringify({ type: 'recording-completed', recordingId: '3d4527e4-4d47-4aea-a4ba-cd61218bbd27', recording: { id: '3d4527e4-4d47-4aea-a4ba-cd61218bbd27' } }))
    await expect.poll(() => page.locator('[data-title-input]').inputValue()).toBe('自动完成的录制')
    expect(await page.getByRole('button', { name: '全部录制' }).isDisabled()).toBe(false)
    await page.close()
  }, 15_000)

  it('requests permission from macOS and continues into recording when access is granted', async () => {
    reset({ check: missingPermission, request: grantedPermission })
    const page = await openNewRecording()

    await page.getByRole('button', { name: '允许屏幕录制' }).click()

    await page.locator('[data-stop]').waitFor()
    expect(permissionRequestCount).toBe(1)
    expect(startRequests).toHaveLength(1)
    await page.close()
  })

  it('checks the Helper identity again and offers fixed settings/Finder recovery after denial', async () => {
    reset({
      check: missingPermission,
      request: { supported: true, status: 'denied', granted: false, restartRequired: false }
    })
    const page = await openNewRecording()

    await page.getByRole('button', { name: '允许屏幕录制' }).click()

    await expect.poll(() => page.locator('[data-status]').textContent()).toContain('Browser Forge Recorder')
    expect(startRequests).toEqual([])
    expect(permissionRequestCount).toBe(1)
    expect(await page.getByRole('button', { name: '重新请求权限' }).count()).toBe(0)

    await page.getByRole('button', { name: '在 Finder 中显示录制组件' }).click()
    await expect.poll(() => helperRevealCount).toBe(1)
    await page.getByRole('button', { name: '打开系统设置' }).click()
    await expect.poll(() => settingsRequestCount).toBe(1)

    permissionCheckResult = grantedPermission
    await page.getByRole('button', { name: '再次检查权限' }).click()
    await expect.poll(() => permissionCheckCount).toBe(2)
    expect(await page.getByRole('button', { name: '打开 Chrome 并开始录制' }).isDisabled()).toBe(false)
    expect(permissionRequestCount).toBe(1)
    await page.close()
  })

  it('does not launch Chrome and asks for an App restart when macOS reports restart-required', async () => {
    reset({
      check: missingPermission,
      request: { supported: true, status: 'restart-required', granted: false, restartRequired: true }
    })
    const page = await openNewRecording()

    await page.getByRole('button', { name: '允许屏幕录制' }).click()

    await expect.poll(() => page.locator('[data-status]').textContent()).toContain('重新启动 Browser Forge')
    expect(startRequests).toEqual([])
    expect(await page.getByRole('button', { name: '打开系统设置' }).isVisible()).toBe(true)
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
