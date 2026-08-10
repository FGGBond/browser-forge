import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { createServer } from 'http'
import { readFileSync, statSync } from 'fs'
import { extname, join } from 'path'

let browser
let server
let baseUrl
const contentTypes = { '.js': 'text/javascript', '.css': 'text/css' }

beforeAll(async () => {
  browser = await chromium.launch()
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/') {
      res.setHeader('content-type', 'text/html')
      return res.end(`<!doctype html><html><body>
        <div id="root"></div>
        <textarea id="fallback" hidden></textarea>
        <script type="module">
          import { mountGuidanceEditor } from '/views/guidance-editor.js'
          window.changes = []
          window.editor = mountGuidanceEditor({
            root: document.querySelector('#root'),
            textarea: document.querySelector('#fallback'),
            initialMarkdown: '初始段落',
            placeholder: '描述操作',
            labelledBy: 'question-title',
            onChange: value => window.changes.push(value)
          })
        </script>
      </body></html>`)
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
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
})

async function openEditor() {
  const page = await browser.newPage()
  await page.goto(baseUrl)
  await page.waitForFunction(() => window.editor)
  return page
}

async function replaceEditorText(page, text = '') {
  const surface = page.locator('[data-guidance-editor-surface]')
  await surface.click()
  await page.keyboard.press('Meta+A')
  if (text) await page.keyboard.type(text)
  else await page.keyboard.press('Backspace')
  return surface
}

describe('guided composer in Chromium', () => {
  it('mounts a restricted contenteditable and safely converts DOM to Markdown', async () => {
    const page = await openEditor()

    expect(await page.evaluate(() => window.editor.kind)).toBe('contenteditable')
    const surface = page.locator('[data-guidance-editor-surface]')
    expect(await surface.getAttribute('contenteditable')).toBe('true')
    expect(await surface.getAttribute('role')).toBe('textbox')
    expect(await surface.getAttribute('aria-multiline')).toBe('true')
    expect(await surface.getAttribute('aria-labelledby')).toBe('question-title')

    await page.evaluate(() => window.editor.setMarkdown([
      '<img src=x onerror="window.injected=true">',
      '',
      '- 列表项',
      '',
      '1. 第一步'
    ].join('\n')))

    expect(await page.locator('[data-guidance-editor-surface] img').count()).toBe(0)
    expect(await page.evaluate(() => window.injected)).toBeUndefined()
    expect(await page.evaluate(() => window.editor.getMarkdown())).toBe([
      '<img src=x onerror="window.injected=true">',
      '',
      '- 列表项',
      '',
      '1. 第一步'
    ].join('\n'))
    expect(await page.evaluate(() => window.changes)).toEqual([])
    await page.close()
  })

  it('converts line-start markers without replacing the active block node on ordinary input', async () => {
    const page = await openEditor()
    const surface = await replaceEditorText(page)

    await page.evaluate(() => {
      window.originalSurface = document.querySelector('[data-guidance-editor-surface]')
      window.originalBlock = window.originalSurface.firstElementChild
    })
    await page.keyboard.type('- ')

    expect(await surface.locator('ul > li').count()).toBe(1)
    expect(await page.evaluate(() => window.editor.getMarkdown())).toBe('- ')
    await page.evaluate(() => { window.convertedList = document.querySelector('[data-guidance-editor-surface] ul') })

    await page.keyboard.type('搜索订单')
    expect(await page.evaluate(() => window.editor.getMarkdown())).toBe('- 搜索订单')
    expect(await page.evaluate(() => window.originalSurface === document.querySelector('[data-guidance-editor-surface]'))).toBe(true)
    expect(await page.evaluate(() => window.convertedList === document.querySelector('[data-guidance-editor-surface] ul'))).toBe(true)
    await page.close()
  })

  it('supports ordered-list conversion, Enter continuation, empty-item exit, and Shift+Enter soft breaks', async () => {
    const page = await openEditor()
    await replaceEditorText(page)

    await page.keyboard.type('1. 第一步')
    await page.keyboard.press('Enter')
    await page.keyboard.type('第二步')
    expect(await page.evaluate(() => window.editor.getMarkdown())).toBe('1. 第一步\n2. 第二步')

    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('补充说明')
    expect(await page.evaluate(() => window.editor.getMarkdown())).toBe('1. 第一步\n2. 第二步\n  补充说明')

    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.type('列表之后')
    expect(await page.evaluate(() => window.editor.getMarkdown())).toBe('1. 第一步\n2. 第二步\n  补充说明\n\n列表之后')
    await page.close()
  })

  it('blocks rich-text formatting so the editable DOM stays limited to paragraphs and lists', async () => {
    const page = await openEditor()
    await replaceEditorText(page, '普通文字')
    const surface = page.locator('[data-guidance-editor-surface]')

    await page.keyboard.press('Meta+A')
    await page.keyboard.press('Meta+b')

    expect(await surface.locator('b, strong, i, em, u, span').count()).toBe(0)
    expect(await page.evaluate(() => window.editor.getMarkdown())).toBe('普通文字')
    await page.close()
  })

  it('pastes only plain text and rejects HTML or file drops', async () => {
    const page = await openEditor()
    await replaceEditorText(page)
    await page.evaluate(() => { window.changes = [] })

    await page.locator('[data-guidance-editor-surface]').evaluate(element => {
      const transfer = new DataTransfer()
      transfer.setData('text/plain', '安全文本')
      transfer.setData('text/html', '<img src=x onerror=alert(1)>')
      element.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer
      }))
    })
    expect(await page.evaluate(() => window.editor.getMarkdown())).toBe('安全文本')
    expect(await page.evaluate(() => window.changes)).toEqual(['安全文本'])
    expect(await page.locator('[data-guidance-editor-surface] img').count()).toBe(0)

    const beforeDrop = await page.evaluate(() => window.editor.getMarkdown())
    await page.locator('[data-guidance-editor-surface]').evaluate(element => {
      const transfer = new DataTransfer()
      transfer.items.add(new File(['secret'], 'secret.txt', { type: 'text/plain' }))
      transfer.setData('text/html', '<b>不应插入</b>')
      element.dispatchEvent(new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer
      }))
    })
    expect(await page.evaluate(() => window.editor.getMarkdown())).toBe(beforeDrop)
    await page.close()
  })

  it('suppresses marker conversion and change callbacks during composition', async () => {
    const page = await openEditor()
    const surface = await replaceEditorText(page)
    await page.evaluate(() => { window.changes = [] })

    await surface.dispatchEvent('compositionstart', { data: '' })
    await surface.evaluate(element => {
      element.firstElementChild.textContent = '- '
      element.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertCompositionText',
        data: ' '
      }))
    })

    expect(await surface.locator('ul').count()).toBe(0)
    expect(await page.evaluate(() => window.changes)).toEqual([])

    await surface.dispatchEvent('compositionend', { data: '- ' })
    expect(await surface.locator('ul').count()).toBe(0)
    expect(await page.evaluate(() => window.changes)).toEqual(['\\- '])
    await page.close()
  })

  it('allows Cmd+Z to undo an automatic list conversion in real Chromium', async () => {
    const page = await openEditor()
    const surface = await replaceEditorText(page)

    await page.keyboard.type('- ')
    expect(await surface.locator('ul').count()).toBe(1)

    await page.keyboard.press('Meta+z')
    await expect.poll(() => page.evaluate(() => window.editor.getMarkdown())).toBe('-')
    expect(await surface.locator('ul').count()).toBe(0)
    await page.close()
  })

  it('preserves the automatic list conversion checkpoint through native text undo', async () => {
    for (const scenario of [
      { marker: '- ', list: 'ul', converted: '- ', restored: '-' },
      { marker: '1. ', list: 'ol', converted: '1. ', restored: '1.' }
    ]) {
      const page = await openEditor()
      try {
        const surface = await replaceEditorText(page)
        await page.keyboard.type(scenario.marker)
        await page.keyboard.insertText('item')
        expect(await surface.locator(`${scenario.list} > li`).count()).toBe(1)

        await page.keyboard.press('Meta+z')
        await expect.poll(() => page.evaluate(() => window.editor.getMarkdown())).toBe(scenario.converted)
        expect(await surface.locator(`${scenario.list} > li`).count()).toBe(1)

        await page.keyboard.press('Meta+z')
        await expect.poll(() => page.evaluate(() => window.editor.getMarkdown())).toBe(scenario.restored)
        expect(await surface.locator(scenario.list).count()).toBe(0)
      } finally {
        await page.close()
      }
    }
  })

  it('destroys listeners and preserves silent programmatic updates', async () => {
    const page = await openEditor()
    await page.evaluate(() => {
      window.editor.setMarkdown('程序更新')
      window.editor.destroy()
      window.editor.setMarkdown('销毁后更新')
      document.querySelector('[data-guidance-editor-surface]').dispatchEvent(new InputEvent('input', { bubbles: true }))
    })

    expect(await page.evaluate(() => window.changes)).toEqual([])
    expect(await page.evaluate(() => window.editor.getMarkdown())).toBe('程序更新')
    await page.close()
  })
})
