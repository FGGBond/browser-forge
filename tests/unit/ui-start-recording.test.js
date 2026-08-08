import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { createServer } from 'http'
import { readFileSync, statSync } from 'fs'
import { extname, join } from 'path'

let browser
let server
let baseUrl
let startRequests

const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }

beforeAll(async () => {
  browser = await chromium.launch()
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/api/recordings') return json(res, { recordings: [] })
    if (url.pathname === '/api/chrome-path') return json(res, { path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
    if (url.pathname === '/api/summary') return json(res, { type: 'summary', startedAt: null, tabs: [], totals: { events: 0, network: 0, console: 0, artifacts: 0 } })
    if (url.pathname === '/api/start-recording') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        startRequests.push(JSON.parse(body))
        json(res, { ok: true, port: 9333, recordingId: '3d4527e4-4d47-4aea-a4ba-cd61218bbd27' })
      })
      return
    }
    serveUi(url.pathname, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

afterAll(async () => {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
})

describe('managed start recording UI', () => {
  it('starts with detected Chrome only and contains no output-directory control', async () => {
    startRequests = []
    const page = await browser.newPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: '新建录制' }).first().click()

    await expect.poll(() => page.locator('[data-chrome-path]').inputValue()).toContain('Google Chrome')
    expect(await page.locator('#output-dir').count()).toBe(0)
    expect(await page.getByText('只会录制 Browser Forge 打开的 Chrome 窗口').count()).toBeGreaterThan(0)

    await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/api/start-recording')),
      page.getByRole('button', { name: '打开 Chrome 并开始录制' }).click()
    ])

    expect(startRequests).toEqual([{ chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }])
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
