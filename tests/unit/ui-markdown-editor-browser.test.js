import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { createServer } from 'http'
import { readFileSync, statSync } from 'fs'
import { extname, join } from 'path'

let browser
let server
let baseUrl
let previewRequests
const contentTypes = { '.js': 'text/javascript', '.css': 'text/css' }

beforeAll(async () => {
  browser = await chromium.launch()
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/') {
      res.setHeader('content-type', 'text/html')
      return res.end(`<!doctype html><html><head>
        <link rel="stylesheet" href="/vendor/easymde/easymde.min.css">
      </head><body><textarea id="editor"></textarea>
        <script src="/vendor/easymde/easymde.min.js"></script>
        <script type="module">
          import { mountMarkdownEditor } from '/views/markdown-editor.js'
          const VendoredEasyMDE = window.EasyMDE
          window.EasyMDE = class TestEasyMDE extends VendoredEasyMDE {
            constructor(options) {
              super(options)
              window.realEasyMDE = this
            }
          }
          window.changes = []
          window.rawHtmlExecuted = false
          window.editor = mountMarkdownEditor({
            textarea: document.querySelector('#editor'),
            initialValue: '初始内容',
            onChange: value => window.changes.push(value)
          })
        </script>
      </body></html>`)
    }
    if (url.pathname === '/raw-missing.png' || url.pathname === '/markdown-remote.png') {
      previewRequests.push(url.pathname)
      res.statusCode = 404
      return res.end('missing')
    }
    const path = join(process.cwd(), 'ui', url.pathname.slice(1))
    try {
      if (!statSync(path).isFile()) throw new Error()
      res.setHeader('content-type', contentTypes[extname(path)] || 'application/octet-stream')
      res.end(readFileSync(path))
    } catch {
      res.statusCode = 404
      res.end('not found')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

afterAll(async () => {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
})

describe('vendored EasyMDE security and accessibility integration', () => {
  it('uses a safe preview without executing raw HTML or requesting markdown images', async () => {
    previewRequests = []
    const page = await browser.newPage()
    await page.goto(baseUrl)
    await page.waitForFunction(() => window.editor)
    await page.evaluate(baseUrl => {
      window.editor.setValue([
        `<img src="${baseUrl}/raw-missing.png" onerror="window.rawHtmlExecuted = true">`,
        '',
        `![远程图](${baseUrl}/markdown-remote.png)`,
        '',
        '[危险](javascript:alert(1))',
        '',
        '[安全](https://example.com/docs)'
      ].join('\n'))
    }, baseUrl)

    await page.locator('.editor-toolbar button').nth(5).click()
    await page.waitForTimeout(100)

    expect(await page.evaluate(() => window.rawHtmlExecuted)).toBe(false)
    expect(await page.locator('.editor-preview img').count()).toBe(0)
    expect(await page.locator('.editor-preview a[href^="javascript:"]').count()).toBe(0)
    expect(await page.locator('.editor-preview a[href="https://example.com/docs"]').count()).toBe(1)
    expect(previewRequests).toEqual([])
    await page.close()
  })

  it('restores toolbar tab stops and keeps setValue silent across destruction', async () => {
    const page = await browser.newPage()
    await page.goto(baseUrl)
    await page.waitForFunction(() => window.editor)

    expect(await page.locator('.editor-toolbar button').evaluateAll(buttons => buttons.map(button => button.tabIndex)))
      .toEqual([0, 0, 0, 0, 0, 0])

    await page.evaluate(() => window.editor.setValue('程序更新'))
    expect(await page.evaluate(() => window.changes)).toEqual([])

    await page.evaluate(() => window.realEasyMDE.codemirror.setValue('用户更新'))
    expect(await page.evaluate(() => window.changes)).toEqual(['用户更新'])

    await page.evaluate(() => {
      window.editor.destroy()
      window.editor.setValue('销毁后程序更新')
      window.realEasyMDE.codemirror.setValue('销毁后陈旧更新')
    })
    expect(await page.evaluate(() => window.changes)).toEqual(['用户更新'])
    await page.close()
  })
})
