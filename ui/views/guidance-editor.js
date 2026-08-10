import {
  guidanceElementToMarkdown,
  normalizeGuidanceMarkdown,
  renderGuidanceMarkdown
} from '../guidance-document.js'

export function mountGuidanceEditor({
  root,
  textarea = null,
  initialMarkdown = '',
  placeholder = '',
  labelledBy = '',
  describedBy = '',
  onChange = () => {},
  onSubmit = null,
  forceTextarea = false
} = {}) {
  if (forceTextarea || !supportsContenteditable(root)) {
    return mountTextareaFallback({
      textarea: textarea ?? createFallbackTextarea(root),
      initialMarkdown,
      placeholder,
      labelledBy,
      describedBy,
      onChange,
      onSubmit
    })
  }

  try {
    return mountContenteditable({
      root,
      textarea,
      initialMarkdown,
      placeholder,
      labelledBy,
      describedBy,
      onChange,
      onSubmit
    })
  } catch {
    return mountTextareaFallback({
      textarea: textarea ?? createFallbackTextarea(root),
      initialMarkdown,
      placeholder,
      labelledBy,
      describedBy,
      onChange,
      onSubmit
    })
  }
}

function mountContenteditable({
  root,
  textarea,
  initialMarkdown,
  placeholder,
  labelledBy,
  describedBy,
  onChange,
  onSubmit
}) {
  const document = root.ownerDocument
  const surface = document.createElement('div')
  surface.contentEditable = 'true'
  surface.setAttribute('contenteditable', 'true')
  surface.setAttribute('role', 'textbox')
  surface.setAttribute('aria-multiline', 'true')
  surface.setAttribute('data-guidance-editor-surface', '')
  surface.setAttribute('data-placeholder', placeholder)
  if (labelledBy) surface.setAttribute('aria-labelledby', labelledBy)
  if (describedBy) surface.setAttribute('aria-describedby', describedBy)

  if (textarea) {
    textarea.hidden = true
    textarea.setAttribute?.('hidden', '')
    if (textarea.style) textarea.style.display = 'none'
  }

  root.append(surface)
  let destroyed = false
  let composing = false
  let internalEdit = false
  let lastMarkdown = normalizeGuidanceMarkdown(initialMarkdown)
  let conversionUndo = null
  renderGuidanceMarkdown(surface, lastMarkdown)

  const emitChange = () => {
    if (destroyed || composing || internalEdit) return
    const markdown = guidanceElementToMarkdown(surface)
    if (markdown === lastMarkdown) return
    lastMarkdown = markdown
    onChange(markdown)
  }

  const handleBeforeInput = event => {
    if (destroyed || composing || event.isComposing) return
    if (event.inputType?.startsWith('format')) {
      event.preventDefault()
      return
    }
    if (event.inputType !== 'insertText' || event.data !== ' ') return

    const marker = markerAtCaret(surface)
    if (!marker) return
    event.preventDefault()
    const beforeMarkdown = guidanceElementToMarkdown(surface)
    replaceMarkerWithList(surface, marker)
    lastMarkdown = guidanceElementToMarkdown(surface)
    conversionUndo = { beforeMarkdown, afterMarkdown: lastMarkdown }
    onChange(lastMarkdown)
  }

  const handleInput = () => {
    if (destroyed || composing || internalEdit) return
    // Keep the structural conversion checkpoint while Chromium unwinds the
    // native text edits inside the list. Once native undo returns to the empty
    // converted list, the next Cmd/Ctrl+Z can restore the original marker.
    emitChange()
  }

  const handleKeyDown = event => {
    if (destroyed || composing) return
    const primaryModifier = event.metaKey || event.ctrlKey
    if (primaryModifier && !event.altKey && ['b', 'i', 'u'].includes(event.key.toLowerCase())) {
      event.preventDefault()
      return
    }
    if (primaryModifier && !event.altKey && !event.shiftKey && event.key === 'Enter') {
      if (typeof onSubmit === 'function') {
        event.preventDefault()
        onSubmit()
      }
      return
    }
    if (!conversionUndo) return
    if (!primaryModifier || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'z') return
    if (guidanceElementToMarkdown(surface) !== conversionUndo.afterMarkdown) {
      // Let Chromium undo ordinary text first. Keep the conversion checkpoint
      // so a later undo can restore the marker once the list is empty again.
      return
    }

    event.preventDefault()
    const { beforeMarkdown } = conversionUndo
    conversionUndo = null
    internalEdit = true
    renderGuidanceMarkdown(surface, beforeMarkdown)
    placeCaretAtEnd(surface)
    internalEdit = false
    lastMarkdown = beforeMarkdown
    onChange(beforeMarkdown)
  }

  const handlePaste = event => {
    if (destroyed) return
    event.preventDefault()
    if (composing) return
    const text = event.clipboardData?.getData?.('text/plain') ?? ''
    const emittedInput = insertPlainText(document, text)
    conversionUndo = null
    if (!emittedInput) emitChange()
  }

  const handleDrop = event => {
    if (destroyed) return
    const transfer = event.dataTransfer
    const types = [...(transfer?.types ?? [])]
    const hasFiles = (transfer?.files?.length ?? 0) > 0 || types.includes('Files')
    const hasHtml = types.includes('text/html')
    event.preventDefault()
    if (composing || hasFiles || hasHtml) return
    const emittedInput = insertPlainText(document, transfer?.getData?.('text/plain') ?? '')
    conversionUndo = null
    if (!emittedInput) emitChange()
  }

  const handleCompositionStart = () => {
    composing = true
    conversionUndo = null
  }

  const handleCompositionEnd = () => {
    composing = false
    emitChange()
  }

  surface.addEventListener('beforeinput', handleBeforeInput)
  surface.addEventListener('input', handleInput)
  surface.addEventListener('keydown', handleKeyDown)
  surface.addEventListener('paste', handlePaste)
  surface.addEventListener('drop', handleDrop)
  surface.addEventListener('compositionstart', handleCompositionStart)
  surface.addEventListener('compositionend', handleCompositionEnd)

  return {
    kind: 'contenteditable',
    getMarkdown() {
      return destroyed ? lastMarkdown : guidanceElementToMarkdown(surface)
    },
    setMarkdown(value) {
      if (destroyed) return
      internalEdit = true
      lastMarkdown = normalizeGuidanceMarkdown(value)
      renderGuidanceMarkdown(surface, lastMarkdown)
      internalEdit = false
      conversionUndo = null
    },
    focus() {
      if (!destroyed) surface.focus()
    },
    destroy() {
      if (destroyed) return
      lastMarkdown = guidanceElementToMarkdown(surface)
      destroyed = true
      surface.removeEventListener('beforeinput', handleBeforeInput)
      surface.removeEventListener('input', handleInput)
      surface.removeEventListener('keydown', handleKeyDown)
      surface.removeEventListener('paste', handlePaste)
      surface.removeEventListener('drop', handleDrop)
      surface.removeEventListener('compositionstart', handleCompositionStart)
      surface.removeEventListener('compositionend', handleCompositionEnd)
    }
  }
}

function mountTextareaFallback({ textarea, initialMarkdown, placeholder, labelledBy, describedBy, onChange, onSubmit }) {
  if (!textarea?.addEventListener) throw new TypeError('A textarea is required when contenteditable is unavailable')
  textarea.hidden = false
  textarea.removeAttribute?.('hidden')
  if (textarea.style) textarea.style.display = ''
  textarea.value = normalizeGuidanceMarkdown(initialMarkdown)
  textarea.placeholder = placeholder
  if (labelledBy) textarea.setAttribute?.('aria-labelledby', labelledBy)
  if (describedBy) textarea.setAttribute?.('aria-describedby', describedBy)

  let destroyed = false
  let lastMarkdown = textarea.value
  const handleInput = () => {
    if (destroyed) return
    lastMarkdown = normalizeGuidanceMarkdown(textarea.value)
    onChange(lastMarkdown)
  }
  textarea.addEventListener('input', handleInput)

  return {
    kind: 'textarea',
    getMarkdown: () => destroyed ? lastMarkdown : normalizeGuidanceMarkdown(textarea.value),
    setMarkdown(value) {
      if (destroyed) return
      lastMarkdown = normalizeGuidanceMarkdown(value)
      textarea.value = lastMarkdown
    },
    focus() {
      if (!destroyed) textarea.focus()
    },
    destroy() {
      if (destroyed) return
      lastMarkdown = normalizeGuidanceMarkdown(textarea.value)
      destroyed = true
      textarea.removeEventListener('input', handleInput)
    }
  }
}

function supportsContenteditable(root) {
  const document = root?.ownerDocument
  if (!root?.append || !document?.createElement || !document?.createTextNode || !document?.createDocumentFragment) return false
  if (typeof document.createRange !== 'function') return false
  if (typeof document.defaultView?.getSelection !== 'function') return false
  return true
}

function createFallbackTextarea(root) {
  const textarea = root?.ownerDocument?.createElement?.('textarea')
  if (!textarea) throw new TypeError('A root or textarea is required to mount the guidance editor')
  root.append(textarea)
  return textarea
}

function markerAtCaret(surface) {
  const selection = surface.ownerDocument.defaultView.getSelection()
  if (!selection || selection.rangeCount !== 1 || !selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  if (!surface.contains(range.startContainer)) return null

  let block = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement
  while (block && block.parentElement !== surface) block = block.parentElement
  if (!block || !['p', 'div'].includes(block.tagName?.toLowerCase())) return null
  if (!caretIsAtEnd(block, range)) return null

  const text = block.textContent?.replace(/[\u200b\ufeff]/g, '') ?? ''
  if (text === '-') return { block, type: 'unordered-list' }
  if (text === '1.') return { block, type: 'ordered-list' }
  return null
}

function caretIsAtEnd(block, range) {
  const tail = block.ownerDocument.createRange()
  tail.selectNodeContents(block)
  tail.setStart(range.endContainer, range.endOffset)
  return tail.toString() === ''
}

function replaceMarkerWithList(surface, { block, type }) {
  const document = surface.ownerDocument
  const list = document.createElement(type === 'ordered-list' ? 'ol' : 'ul')
  const item = document.createElement('li')
  item.append(document.createElement('br'))
  list.append(item)
  block.replaceWith(list)
  placeCaretAtStart(item)
}

function insertPlainText(document, text) {
  const value = String(text ?? '').replace(/\r\n?/g, '\n')
  if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, value)) return true

  const selection = document.defaultView?.getSelection?.()
  if (!selection || selection.rangeCount === 0) return false
  const range = selection.getRangeAt(0)
  range.deleteContents()
  const parts = value.split('\n')
  const fragment = document.createDocumentFragment()
  let lastNode = null
  parts.forEach((part, index) => {
    if (index > 0) {
      lastNode = document.createElement('br')
      fragment.append(lastNode)
    }
    if (part) {
      lastNode = document.createTextNode(part)
      fragment.append(lastNode)
    }
  })
  range.insertNode(fragment)
  if (lastNode) {
    range.setStartAfter(lastNode)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
  }
  return false
}

function placeCaretAtStart(element) {
  const document = element.ownerDocument
  const selection = document.defaultView.getSelection()
  const range = document.createRange()
  range.selectNodeContents(element)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}

function placeCaretAtEnd(element) {
  const document = element.ownerDocument
  const selection = document.defaultView.getSelection()
  const range = document.createRange()
  range.selectNodeContents(element)
  range.collapse(false)
  selection.removeAllRanges()
  selection.addRange(range)
  element.focus()
}
