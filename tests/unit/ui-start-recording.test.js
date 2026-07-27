import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { createServer } from 'http'
import { readFileSync } from 'fs'
import { join } from 'path'

let browser
let server
let baseUrl
let startRequests

beforeAll(async () => {
  browser = await chromium.launch()
  server = createServer((req, res) => {
    if (req.url === '/api/chrome-path') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }))
      return
    }
    if (req.url === '/api/summary') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ type: 'summary', startedAt: null, updatedAt: Date.now(), tabs: [], totals: { events: 0, network: 0, console: 0, artifacts: 0 } }))
      return
    }
    if (req.url === '/api/start-recording') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        startRequests.push(JSON.parse(body))
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }
    res.setHeader('content-type', 'text/html')
    res.end(readFileSync(join(process.cwd(), 'ui/index.html')))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
})

describe('start recording UI', () => {
  it('uses the Electron native directory picker when available', async () => {
    const page = await browser.newPage()
    await page.addInitScript(() => {
      window.electronAPI = {
        pickOutputDir: async () => '/Users/example/Desktop/browser-forge-output'
      }
    })
    await page.goto(`${baseUrl}?shell=electron`, { waitUntil: 'networkidle' })

    await page.getByRole('button', { name: '选择' }).click()

    expect(await page.locator('#output-dir').inputValue()).toBe('/Users/example/Desktop/browser-forge-output')
    expect(await page.locator('#start-btn').isDisabled()).toBe(false)

    await page.close()
  })

  it('allows first start after choosing an output directory even before Chrome detection has filled the input', async () => {
    startRequests = []
    const page = await browser.newPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await page.evaluate(() => {
      document.getElementById('chrome-path').value = ''
      document.getElementById('output-dir').value = '/tmp/browser-forge-output'
      window.updateStartBtn()
    })

    expect(await page.locator('#start-btn').isDisabled()).toBe(false)
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/api/start-recording')),
      page.click('#start-btn')
    ])

    expect(startRequests).toEqual([
      expect.objectContaining({
        chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        outputDir: '/tmp/browser-forge-output'
      })
    ])

    await page.close()
  })
})
