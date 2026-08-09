import { renderSafeMarkdown } from '../safe-markdown.js'

const TOOLBAR = ['bold', 'italic', 'unordered-list', 'ordered-list', 'link', 'preview']

const TOOLBAR_PRESENTATION = [
  { label: '加粗', mark: 'B' },
  { label: '斜体', mark: 'I' },
  { label: '无序列表', mark: '•' },
  { label: '有序列表', mark: '1.' },
  { label: '插入链接', mark: '链' },
  { label: '预览', mark: '预览' }
]

function mountTextareaFallback({ textarea, onChange }) {
  textarea.hidden = false
  textarea.removeAttribute?.('hidden')
  if (textarea.style) textarea.style.display = ''

  let destroyed = false
  const handleInput = () => {
    if (!destroyed) onChange(textarea.value)
  }
  textarea.addEventListener('input', handleInput)

  return {
    kind: 'textarea',
    getValue: () => textarea.value,
    setValue: value => {
      if (!destroyed) textarea.value = value
    },
    focus: () => {
      if (!destroyed) textarea.focus()
    },
    destroy: () => {
      if (destroyed) return
      destroyed = true
      textarea.removeEventListener('input', handleInput)
    }
  }
}

function labelToolbar(instance) {
  const buttons = instance.gui?.toolbar?.querySelectorAll('button') ?? []
  buttons.forEach((button, index) => {
    const presentation = TOOLBAR_PRESENTATION[index]
    if (!presentation) return
    button.textContent = presentation.mark
    button.setAttribute('aria-label', presentation.label)
    button.setAttribute('title', presentation.label)
    button.tabIndex = 0
  })
}

export function mountMarkdownEditor({
  textarea,
  initialValue = '',
  placeholder = '',
  onChange = () => {}
}) {
  textarea.value = initialValue
  textarea.placeholder = placeholder

  const EasyMDE = globalThis.window?.EasyMDE
  if (typeof EasyMDE !== 'function') {
    return mountTextareaFallback({ textarea, onChange })
  }

  try {
    const instance = new EasyMDE({
      element: textarea,
      initialValue,
      placeholder,
      autofocus: false,
      spellChecker: false,
      status: false,
      toolbar: TOOLBAR,
      autoDownloadFontAwesome: false,
      minHeight: '220px',
      previewRender: renderSafeMarkdown
    })
    labelToolbar(instance)

    let destroyed = false
    let silentUpdate = false
    const handleChange = () => {
      if (!destroyed && !silentUpdate) onChange(instance.value())
    }
    instance.codemirror.on('change', handleChange)

    return {
      kind: 'easymde',
      getValue: () => instance.value(),
      setValue: value => {
        if (destroyed) return
        silentUpdate = true
        try {
          instance.value(value)
        } finally {
          silentUpdate = false
        }
      },
      focus: () => {
        if (!destroyed) instance.codemirror.focus()
      },
      destroy: () => {
        if (destroyed) return
        destroyed = true
        instance.codemirror.off('change', handleChange)
        instance.toTextArea()
      }
    }
  } catch {
    return mountTextareaFallback({ textarea, onChange })
  }
}
