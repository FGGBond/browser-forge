import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountMarkdownEditor } from '../../ui/views/markdown-editor.js'

const toolbar = ['bold', 'italic', 'unordered-list', 'ordered-list', 'link', 'preview']
const toolbarLabels = ['加粗', '斜体', '无序列表', '有序列表', '插入链接', '预览']
const toolbarMarks = ['B', 'I', '•', '1.', '链', '预览']

class FakeTextarea extends EventTarget {
  constructor() {
    super()
    this.value = ''
    this.placeholder = ''
    this.hidden = false
    this.style = { display: '' }
    this.focus = vi.fn()
  }
}

class FakeEasyMDE {
  static options
  static instance

  constructor(options) {
    FakeEasyMDE.options = options
    FakeEasyMDE.instance = this
    this.currentValue = options.initialValue
    this.changeHandler = null
    this.buttons = toolbar.map(() => ({
      setAttribute: vi.fn()
    }))
    this.gui = {
      toolbar: {
        querySelectorAll: vi.fn(() => this.buttons)
      }
    }
    this.codemirror = {
      focus: vi.fn(),
      on: vi.fn((event, handler) => {
        if (event === 'change') this.changeHandler = handler
      })
    }
    this.toTextArea = vi.fn()
  }

  value(nextValue) {
    if (arguments.length > 0) this.currentValue = nextValue
    return this.currentValue
  }
}

describe('markdown editor adapter', () => {
  let textarea

  beforeEach(() => {
    textarea = new FakeTextarea()
    globalThis.window = { EasyMDE: FakeEasyMDE }
    FakeEasyMDE.options = undefined
    FakeEasyMDE.instance = undefined
  })

  afterEach(() => {
    delete globalThis.window
  })

  it('mounts EasyMDE with a compact local toolbar and accessible Chinese labels', () => {
    const onChange = vi.fn()
    const editor = mountMarkdownEditor({
      textarea,
      initialValue: '**动作**',
      placeholder: '请填写动作',
      onChange
    })

    expect(editor.kind).toBe('easymde')
    expect(FakeEasyMDE.options).toMatchObject({
      element: textarea,
      initialValue: '**动作**',
      placeholder: '请填写动作',
      autofocus: false,
      spellChecker: false,
      status: false,
      toolbar,
      autoDownloadFontAwesome: false,
      minHeight: '220px'
    })
    expect(FakeEasyMDE.instance.codemirror.on).toHaveBeenCalledWith('change', expect.any(Function))
    FakeEasyMDE.instance.buttons.forEach((button, index) => {
      expect(button.setAttribute).toHaveBeenCalledWith('aria-label', toolbarLabels[index])
      expect(button.setAttribute).toHaveBeenCalledWith('title', toolbarLabels[index])
      expect(button.textContent).toBe(toolbarMarks[index])
    })

    FakeEasyMDE.instance.currentValue = '更新动作'
    FakeEasyMDE.instance.changeHandler()
    expect(onChange).toHaveBeenCalledWith('更新动作')
  })

  it('exposes value, focus, and destroy controls for EasyMDE', () => {
    const editor = mountMarkdownEditor({ textarea, initialValue: '动作' })

    expect(editor.getValue()).toBe('动作')
    editor.setValue('新动作')
    expect(editor.getValue()).toBe('新动作')
    editor.focus()
    expect(FakeEasyMDE.instance.codemirror.focus).toHaveBeenCalledOnce()
    editor.destroy()
    expect(FakeEasyMDE.instance.toTextArea).toHaveBeenCalledOnce()
  })

  it('falls back to the native textarea when EasyMDE is unavailable', () => {
    delete window.EasyMDE
    const onChange = vi.fn()
    const editor = mountMarkdownEditor({
      textarea,
      initialValue: '动作',
      placeholder: '请填写动作',
      onChange
    })

    expect(editor.kind).toBe('textarea')
    expect(textarea.value).toBe('动作')
    expect(textarea.placeholder).toBe('请填写动作')
    textarea.value = '更新动作'
    textarea.dispatchEvent(new Event('input'))
    expect(onChange).toHaveBeenCalledWith('更新动作')

    expect(editor.getValue()).toBe('更新动作')
    editor.setValue('再次更新')
    expect(editor.getValue()).toBe('再次更新')
    editor.focus()
    expect(textarea.focus).toHaveBeenCalledOnce()
    editor.destroy()
    textarea.value = '销毁后更新'
    textarea.dispatchEvent(new Event('input'))
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('falls back to the native textarea when EasyMDE initialization throws', () => {
    window.EasyMDE = class BrokenEasyMDE {
      constructor({ element }) {
        element.hidden = true
        element.style.display = 'none'
        throw new Error('initialization failed')
      }
    }
    const onChange = vi.fn()

    const editor = mountMarkdownEditor({ textarea, initialValue: '动作', onChange })

    expect(editor.kind).toBe('textarea')
    expect(textarea.hidden).toBe(false)
    expect(textarea.style.display).toBe('')
    textarea.value = '仍可编辑'
    textarea.dispatchEvent(new Event('input'))
    expect(onChange).toHaveBeenCalledWith('仍可编辑')
  })
})
