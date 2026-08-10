import { describe, expect, it, vi } from 'vitest'
import { mountGuidanceEditor } from '../../ui/views/guidance-editor.js'

class FakeTextarea extends EventTarget {
  constructor() {
    super()
    this.value = ''
    this.placeholder = ''
    this.hidden = true
    this.style = { display: 'none' }
    this.attributes = new Map()
    this.focus = vi.fn()
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  removeAttribute(name) { this.attributes.delete(name) }
  getAttribute(name) { return this.attributes.get(name) ?? null }
}

function fallbackRoot() {
  return {
    ownerDocument: {
      createElement() {
        throw new Error('contenteditable unavailable')
      }
    },
    append() {}
  }
}

describe('guided composer adapter', () => {
  it('falls back to a textarea when rich editing capabilities are unavailable', () => {
    const textarea = new FakeTextarea()
    const onChange = vi.fn()
    const editor = mountGuidanceEditor({
      root: fallbackRoot(),
      textarea,
      initialMarkdown: '- 打开首页',
      placeholder: '描述你的操作',
      labelledBy: 'question-title',
      describedBy: 'question-help',
      onChange
    })

    expect(editor.kind).toBe('textarea')
    expect(textarea.hidden).toBe(false)
    expect(textarea.style.display).toBe('')
    expect(textarea.value).toBe('- 打开首页')
    expect(textarea.placeholder).toBe('描述你的操作')
    expect(textarea.getAttribute('aria-labelledby')).toBe('question-title')
    expect(textarea.getAttribute('aria-describedby')).toBe('question-help')

    editor.setMarkdown('1. 程序更新')
    expect(editor.getMarkdown()).toBe('1. 程序更新')
    expect(onChange).not.toHaveBeenCalled()

    textarea.value = '用户更新'
    textarea.dispatchEvent(new Event('input'))
    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenLastCalledWith('用户更新')

    editor.focus()
    expect(textarea.focus).toHaveBeenCalledOnce()
  })

  it('detaches fallback listeners and keeps programmatic updates silent after destroy', () => {
    const textarea = new FakeTextarea()
    const onChange = vi.fn()
    const editor = mountGuidanceEditor({ root: fallbackRoot(), textarea, onChange })

    editor.destroy()
    editor.destroy()
    editor.setMarkdown('销毁后程序更新')
    textarea.value = '销毁后用户更新'
    textarea.dispatchEvent(new Event('input'))

    expect(onChange).not.toHaveBeenCalled()
    expect(editor.getMarkdown()).toBe('')
  })

  it('can be explicitly forced to use the textarea fallback', () => {
    const textarea = new FakeTextarea()
    const root = {
      ownerDocument: { createElement: vi.fn() },
      append: vi.fn()
    }

    const editor = mountGuidanceEditor({ root, textarea, forceTextarea: true })

    expect(editor.kind).toBe('textarea')
    expect(root.ownerDocument.createElement).not.toHaveBeenCalled()
  })
})
