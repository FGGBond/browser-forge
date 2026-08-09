import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { createServer } from 'http'
import { readFileSync, statSync } from 'fs'
import { extname, join } from 'path'

let browser
let server
let baseUrl
let stopRequests
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }

beforeAll(async () => {
  browser = await chromium.launch()
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/api/recordings') return json(res, { recordings: [] })
    if (url.pathname === '/api/chrome-path') return json(res, { path: '/Applications/Google Chrome.app' })
    if (url.pathname === '/api/screen-recording-permission') return json(res, { supported: true, status: 'granted', granted: true, restartRequired: false })
    if (url.pathname === '/api/start-recording') return json(res, { ok: true, port: 9333, recordingId: '3d4527e4-4d47-4aea-a4ba-cd61218bbd27' })
    if (url.pathname === '/api/stop-recording') { stopRequests += 1; return json(res, { ok: true, recording: { id: '3d4527e4-4d47-4aea-a4ba-cd61218bbd27' } }) }
    if (url.pathname === '/api/summary') return json(res, {
      type: 'summary', startedAt: Date.now(), totals: { events: 2, network: 5, console: 1, artifacts: 1 },
      tabs: [{
        title: 'Orders', url: 'https://example.com/orders', counts: { events: 2 },
        recent: {
          events: [{ type: 'click', selector: 'BUTTON', timestamp: Date.now() }],
          artifacts: [{ kind: 'Screenshot', title: 'checkout.png', timestamp: Date.now(), thumbnailUrl: '/api/screenshots/tab-1/123.png' }]
        }
      }]
    })
    if (url.pathname.startsWith('/api/screenshots/')) {
      res.setHeader('content-type', 'image/png')
      res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lw9p8wAAAABJRU5ErkJggg==', 'base64'))
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

describe('recording status and responsive shell', () => {
  it('marks the Electron shell and uses a compact top navigation on narrow screens', async () => {
    const page = await browser.newPage({ viewport: { width: 640, height: 720 } })
    await page.goto(`${baseUrl}?shell=electron`, { waitUntil: 'networkidle' })
    const layout = await page.evaluate(() => ({
      bodyClass: document.body.className,
      columns: getComputedStyle(document.querySelector('.app-shell')).gridTemplateColumns,
      sidebarHeight: Math.round(document.querySelector('.app-sidebar').getBoundingClientRect().height),
      navLabelDisplay: getComputedStyle(document.querySelector('.primary-nav span')).display
    }))
    expect(layout.bodyClass).toContain('shell-electron')
    expect(layout.columns).toBe('640px')
    expect(layout.sidebarHeight).toBe(58)
    expect(layout.navLabelDisplay).toBe('none')
    await page.close()
  })

  it('keeps recording status, opened-page summaries, and stop as the primary action', async () => {
    const page = await browser.newPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: '新录制' }).first().click()
    await page.getByRole('button', { name: '开始录制' }).click()
    await page.locator('[data-open-pages]').waitFor()

    await page.getByText('正在录制', { exact: true }).waitFor()
    await page.getByRole('button', { name: '停止录制' }).waitFor()
    expect(await page.locator('[data-open-pages]').textContent()).toContain('Orders')
    expect(await page.locator('[data-open-pages]').textContent()).toContain('example.com')
    expect(await page.locator('[data-open-pages]').getAttribute('aria-live')).toBeNull()
    expect(await page.locator('[data-tab-count]').getAttribute('aria-live')).toBe('polite')
    expect(await page.locator('.current-page').count()).toBe(0)
    expect(await page.locator('.metric, .event-item, .screenshot-card, .screenshot-grid').count()).toBe(0)
    expect(await page.getByText(/录制物料|关键事件|画面物料/).count()).toBe(0)
    await page.close()
  })

  it('stacks the recording workspace in narrow windows and exposes semantic focus', async () => {
    stopRequests = 0
    const page = await browser.newPage({ viewport: { width: 520, height: 720 } })
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: '新录制' }).first().click()
    await page.getByRole('button', { name: '开始录制' }).click()
    const stop = page.getByRole('button', { name: '停止录制' })
    await stop.waitFor()
    await page.locator('[data-open-pages]').waitFor()

    const result = await page.evaluate(() => {
      const header = document.querySelector('.live-header')
      const button = document.querySelector('[data-stop]')
      const pages = document.querySelector('[data-open-pages]')
      const style = getComputedStyle(button)
      return {
        headerDirection: getComputedStyle(header).flexDirection,
        stopWidth: Math.round(button.getBoundingClientRect().width),
        headerWidth: Math.round(header.getBoundingClientRect().width),
        pagesColumns: getComputedStyle(pages).gridTemplateColumns,
        focusRule: Array.from(document.styleSheets).flatMap(sheet => Array.from(sheet.cssRules)).find(rule => rule.selectorText?.includes('button:focus-visible'))?.cssText || '',
        transitionDuration: style.transitionDuration,
        transitionTiming: style.transitionTimingFunction,
        unlabeledIconButtons: Array.from(document.querySelectorAll('button')).filter(item => {
          const visible = item.getClientRects().length > 0
          return visible && item.querySelector('svg') && !item.textContent.trim() && !item.getAttribute('aria-label')
        }).length
      }
    })
    expect(result.headerDirection).toBe('column')
    expect(result.stopWidth).toBe(result.headerWidth)
    expect(result.pagesColumns.split(' ').length).toBe(1)
    expect(result.focusRule).toContain('var(--accent)')
    expect(result.focusRule).toContain('var(--focus-ring)')
    expect(result.unlabeledIconButtons).toBe(0)
    expect(result.transitionDuration.split(', ').every(value => Number.parseFloat(value) >= 0.16 && Number.parseFloat(value) <= 0.22)).toBe(true)
    expect(result.transitionTiming.split(', ').every(value => value === 'ease-out')).toBe(true)
    await stop.press('Enter')
    await expect.poll(() => stopRequests).toBe(1)
    await page.close()
  })

  it('gates hover motion and removes transform motion for reduced-motion users', async () => {
    const page = await browser.newPage()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    const result = await page.evaluate(() => {
      const sheets = Array.from(document.styleSheets)
      const rules = sheets.flatMap(sheet => Array.from(sheet.cssRules))
      const hover = rules.find(rule => rule.conditionText?.includes('hover: hover') && rule.conditionText?.includes('pointer: fine'))
      const button = getComputedStyle(document.querySelector('.button'))
      return { hasHoverGate: Boolean(hover), transitionProperty: button.transitionProperty, transform: button.transform }
    })
    expect(result.hasHoverGate).toBe(true)
    expect(result.transitionProperty).not.toContain('transform')
    expect(result.transform).toBe('none')
    await page.close()
  })
})

function json(res, value) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)) }
function serveUi(pathname, res) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1)
  const path = join(process.cwd(), 'ui', relative)
  try {
    if (!statSync(path).isFile()) throw new Error('not file')
    res.setHeader('content-type', contentTypes[extname(path)] || 'application/octet-stream')
    res.end(readFileSync(path))
  } catch { res.statusCode = 404; res.end('not found') }
}
