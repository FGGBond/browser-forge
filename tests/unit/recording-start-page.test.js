import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { chromium } from 'playwright'

const pageHtml = await readFile(join(process.cwd(), 'ui', 'recording-start.html'), 'utf8')

let browser

beforeAll(async () => {
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser?.close()
})

describe('recording start page', () => {
  it('keeps the recorder window identity title from the URL query', async () => {
    const page = await browser.newPage()
    await page.route('http://browser-forge.test/**', route => route.fulfill({
      contentType: 'text/html',
      body: pageHtml
    }))
    await page.route('http://browser-forge.test/api/recording-ready', route => route.fulfill({ json: { ready: true } }))

    await page.goto('http://browser-forge.test/recording-start.html?bfRecordingTitle=Browser%20Forge%20Recording%20%C2%B7%20token')

    await expect.poll(() => page.title()).toBe('Browser Forge Recording · token')
    await page.close()
  })

  it('provides a real URL form that navigates the current app-mode window', async () => {
    const page = await browser.newPage()
    let ready = false
    await page.route('http://browser-forge.test/**', route => route.fulfill({
      contentType: 'text/html',
      body: pageHtml
    }))
    await page.route('http://browser-forge.test/api/recording-ready', route => route.fulfill({ json: { ready } }))
    await page.route('https://example.com/**', route => route.fulfill({
      contentType: 'text/html',
      body: '<title>Example destination</title>'
    }))
    await page.goto('http://browser-forge.test/recording-start.html?bfRecordingTitle=Browser%20Forge%20Recording%20%C2%B7%20token')

    const input = page.getByRole('textbox', { name: '目标网址' })
    expect(await input.isVisible()).toBe(true)
    const start = page.getByRole('button', { name: '开始' })
    expect(await start.isVisible()).toBe(true)
    expect(await start.isDisabled()).toBe(true)
    expect(await page.getByText('请在地址栏输入').count()).toBe(0)

    ready = true
    await expect.poll(() => start.isEnabled()).toBe(true)
    await input.fill('https://example.com/orders')
    await page.getByRole('button', { name: '开始' }).click()

    await expect.poll(() => page.url()).toBe('https://example.com/orders')
    await expect.poll(() => page.title()).toBe('Example destination')
    await page.close()
  })

  it.each(['javascript:alert(document.domain)', 'data:text/html,hello', 'file:///tmp/secret', 'mailto:test@example.com'])('rejects unsafe destination %s', async destination => {
    const page = await browser.newPage()
    await page.route('http://browser-forge.test/**', route => route.fulfill({ contentType: 'text/html', body: pageHtml }))
    await page.route('http://browser-forge.test/api/recording-ready', route => route.fulfill({ json: { ready: true } }))
    await page.goto('http://browser-forge.test/recording-start.html?bfRecordingTitle=Browser%20Forge')
    const start = page.getByRole('button', { name: '开始' })
    await expect.poll(() => start.isEnabled()).toBe(true)
    await page.getByRole('textbox', { name: '目标网址' }).fill(destination)
    await start.click()
    expect(page.url()).toContain('/recording-start.html')
    expect(await page.getByRole('textbox', { name: '目标网址' }).evaluate(element => element.validationMessage)).toContain('http:// 或 https://')
    await page.close()
  })
})
