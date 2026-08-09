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

  const handleInput = () => onChange(textarea.value)
  textarea.addEventListener('input', handleInput)

  return {
    kind: 'textarea',
    getValue: () => textarea.value,
    setValue: value => { textarea.value = value },
    focus: () => textarea.focus(),
    destroy: () => textarea.removeEventListener('input', handleInput)
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
      minHeight: '220px'
    })
    labelToolbar(instance)
    instance.codemirror.on('change', () => onChange(instance.value()))

    return {
      kind: 'easymde',
      getValue: () => instance.value(),
      setValue: value => instance.value(value),
      focus: () => instance.codemirror.focus(),
      destroy: () => instance.toTextArea()
    }
  } catch {
    return mountTextareaFallback({ textarea, onChange })
  }
}
