import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { createServer } from 'http'
import { readFileSync, statSync } from 'fs'
import { extname, join } from 'path'

let browser
let server
let baseUrl
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }

beforeAll(async () => {
  browser = await chromium.launch()
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/api/recordings') return json(res, { recordings: [] })
    if (url.pathname === '/api/chrome-path') return json(res, { path: '/Applications/Google Chrome.app' })
    if (url.pathname === '/api/start-recording') return json(res, { ok: true, port: 9333, recordingId: '3d4527e4-4d47-4aea-a4ba-cd61218bbd27' })
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

describe('live Inspector and responsive shell', () => {
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

  it('renders live event and screenshot material after recording starts', async () => {
    const page = await browser.newPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: '新建录制' }).first().click()
    await page.getByRole('button', { name: '打开 Chrome 并开始录制' }).click()
    await page.locator('.screenshot-card').waitFor()

    expect(await page.locator('.metric').first().textContent()).toContain('2')
    expect(await page.locator('.event-item').count()).toBe(1)
    expect(await page.locator('.screenshot-grid img').getAttribute('src')).toContain('/api/screenshots/')
    expect(await page.getByText('Orders').count()).toBeGreaterThan(0)
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
