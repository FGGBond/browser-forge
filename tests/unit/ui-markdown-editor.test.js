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

class FakeButton {
  constructor() {
    this.tabIndex = -1
    this.textContent = ''
    this.attributes = new Map()
  }

  setAttribute(name, value) {
    this.attributes.set(name, value)
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null
  }
}

class FakeCodeMirror {
  constructor() {
    this.handlers = new Map()
    this.focus = vi.fn()
    this.on = vi.fn((event, handler) => {
      const handlers = this.handlers.get(event) ?? new Set()
      handlers.add(handler)
      this.handlers.set(event, handlers)
    })
    this.off = vi.fn((event, handler) => {
      this.handlers.get(event)?.delete(handler)
    })
  }

  emit(event) {
    for (const handler of this.handlers.get(event) ?? []) handler()
  }
}

class FakeEasyMDE {
  static options
  static instance

  constructor(options) {
    FakeEasyMDE.options = options
    FakeEasyMDE.instance = this
    this.currentValue = options.initialValue
    this.buttons = toolbar.map(() => new FakeButton())
    this.gui = {
      toolbar: {
        querySelectorAll: vi.fn(() => this.buttons)
      }
    }
    this.codemirror = new FakeCodeMirror()
    this.toTextArea = vi.fn()
  }

  value(nextValue) {
    if (arguments.length > 0) {
      this.currentValue = nextValue
      this.codemirror.emit('change')
    }
    return this.currentValue
  }

  simulateUserChange(nextValue) {
    this.currentValue = nextValue
    this.codemirror.emit('change')
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

  it('mounts EasyMDE with a compact local toolbar, safe preview, and keyboard-accessible Chinese labels', () => {
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
      minHeight: '220px',
      previewRender: expect.any(Function)
    })
    expect(FakeEasyMDE.options.previewRender('<img src="https://attacker.invalid/x" onerror="alert(1)">'))
      .not.toMatch(/<(?:img|script)\b|<[^>]+\s(?:onerror|src)\s*=/i)
    expect(FakeEasyMDE.instance.codemirror.on).toHaveBeenCalledWith('change', expect.any(Function))
    FakeEasyMDE.instance.buttons.forEach((button, index) => {
      expect(button.getAttribute('aria-label')).toBe(toolbarLabels[index])
      expect(button.getAttribute('title')).toBe(toolbarLabels[index])
      expect(button.textContent).toBe(toolbarMarks[index])
      expect(button.tabIndex).toBe(0)
    })

    FakeEasyMDE.instance.simulateUserChange('更新动作')
    expect(onChange).toHaveBeenCalledWith('更新动作')
  })

  it('keeps programmatic EasyMDE updates silent and detaches the exact change handler on destroy', () => {
    const onChange = vi.fn()
    const editor = mountMarkdownEditor({ textarea, initialValue: '动作', onChange })
    const instance = FakeEasyMDE.instance
    const changeHandler = instance.codemirror.on.mock.calls.find(([event]) => event === 'change')[1]

    expect(editor.getValue()).toBe('动作')
    editor.setValue('新动作')
    expect(editor.getValue()).toBe('新动作')
    expect(onChange).not.toHaveBeenCalled()

    instance.simulateUserChange('用户动作')
    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenLastCalledWith('用户动作')

    editor.focus()
    expect(instance.codemirror.focus).toHaveBeenCalledOnce()
    editor.destroy()
    expect(instance.codemirror.off).toHaveBeenCalledWith('change', changeHandler)
    expect(instance.toTextArea).toHaveBeenCalledOnce()

    editor.setValue('销毁后程序更新')
    instance.simulateUserChange('销毁后陈旧事件')
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('keeps native textarea fallback programmatic updates silent before and after destroy', () => {
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

    editor.setValue('程序更新')
    expect(editor.getValue()).toBe('程序更新')
    expect(onChange).not.toHaveBeenCalled()

    textarea.value = '用户更新'
    textarea.dispatchEvent(new Event('input'))
    expect(onChange).toHaveBeenCalledWith('用户更新')

    editor.focus()
    expect(textarea.focus).toHaveBeenCalledOnce()
    editor.destroy()
    editor.setValue('销毁后程序更新')
    textarea.value = '销毁后用户更新'
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
    editor.setValue('程序更新')
    expect(onChange).not.toHaveBeenCalled()
    textarea.value = '仍可编辑'
    textarea.dispatchEvent(new Event('input'))
    expect(onChange).toHaveBeenCalledWith('仍可编辑')
  })
})
