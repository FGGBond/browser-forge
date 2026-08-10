import { renderPromptEditor } from './prompt-editor.js'
import { mountSplitHandle } from './split-resize.js'
import { readNumberPreference, writeNumberPreference } from '../layout-prefs.js'

const PANE_EXIT_FALLBACK_MS = 190
const REDUCED_MOTION_EXIT_FALLBACK_MS = 130
const PANE_MIN_WIDTH = 300
const PANE_MAX_WIDTH = 680
const PANE_DEFAULT_WIDTH = 476
const MAIN_MIN_WIDTH = 560
const PANE_WIDTH_KEY = 'analysis-pane-width'
const DRAWER_QUERY = '(max-width: 1103px)'

export function createContextPane({ shell, host, toggle, api, onOpenChange = () => {} }) {
  host.innerHTML = `
    <aside class="analysis-pane" id="recording-analysis-guidance" data-analysis-pane aria-label="分析指导">
      <div class="analysis-pane-inner">
        <button class="icon-button analysis-pane-close" type="button" data-close-analysis aria-label="关闭录制说明">${closeIcon()}</button>
        <div class="context-status-slot" data-context-status></div>
        <section class="analysis-prompt" data-prompt-slot></section>
      </div>
    </aside>`

  const pane = host.querySelector('[data-analysis-pane]')
  const promptSlot = host.querySelector('[data-prompt-slot]')
  const contextStatus = host.querySelector('[data-context-status]')
  const close = host.querySelector('[data-close-analysis]')
  const drawerQuery = globalThis.matchMedia?.(DRAWER_QUERY)
  const reducedMotionQuery = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')
  const paneInner = host.querySelector('.analysis-pane-inner')

  let controller = null
  let recordingId = null
  let loadingRecordingId = null
  let loadingPromise = null
  let placeholderSignature = null
  let loadRevision = 0
  let open = true
  let closeTimer = null
  let closeTransitionEnd = null
  let closeMotionChange = null
  let closeRevision = 0
  let closePending = false
  let destroyed = false

  const clampPaneWidth = width => Math.min(Math.max(width, PANE_MIN_WIDTH), PANE_MAX_WIDTH)
  const maxPaneWidth = () => {
    const width = shell.getBoundingClientRect().width
    const sidebarWidth = shell.querySelector('.app-sidebar')?.getBoundingClientRect().width || 0
    return Math.max(PANE_MIN_WIDTH, Math.min(PANE_MAX_WIDTH, Math.floor(width - sidebarWidth - MAIN_MIN_WIDTH)))
  }
  const applyPaneWidth = width => {
    const requested = clampPaneWidth(width)
    const clamped = drawerQuery?.matches ? requested : Math.min(requested, maxPaneWidth())
    shell.style.setProperty('--context-w', `${Math.round(clamped)}px`)
    return clamped
  }
  const readPaneWidth = () => pane.getBoundingClientRect().width || readNumberPreference(PANE_WIDTH_KEY, PANE_DEFAULT_WIDTH)
  applyPaneWidth(readNumberPreference(PANE_WIDTH_KEY, PANE_DEFAULT_WIDTH))

  const handle = document.createElement('div')
  handle.className = 'pane-resize-handle'
  handle.setAttribute('role', 'separator')
  handle.setAttribute('aria-orientation', 'vertical')
  handle.setAttribute('aria-label', '调整说明栏宽度(方向键,Home 最窄,End 最宽)')
  handle.setAttribute('aria-valuemin', String(PANE_MIN_WIDTH))
  handle.setAttribute('aria-valuemax', String(PANE_MAX_WIDTH))
  handle.setAttribute('aria-valuenow', String(Math.round(readPaneWidth())))
  handle.tabIndex = 0
  host.prepend(handle)

  const detachResize = mountSplitHandle({
    handle,
    getWidth: readPaneWidth,
    setWidth: width => {
      const applied = applyPaneWidth(width)
      handle.setAttribute('aria-valuenow', String(Math.round(applied)))
      return applied
    },
    invert: true,
    min: PANE_MIN_WIDTH,
    max: PANE_MAX_WIDTH,
    storageKey: PANE_WIDTH_KEY,
    onDragStart: width => {
      shell.classList.add('pane-resizing')
      handle.setAttribute('aria-valuenow', String(Math.round(width)))
    },
    onDragEnd: width => {
      shell.classList.remove('pane-resizing')
      handle.setAttribute('aria-valuenow', String(Math.round(width)))
    },
    onReset: () => {
      const applied = applyPaneWidth(PANE_DEFAULT_WIDTH)
      handle.setAttribute('aria-valuenow', String(Math.round(applied)))
      return applied
    }
  })

  const resizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => {
      if (drawerQuery?.matches) return
      const applied = applyPaneWidth(readPaneWidth())
      writeNumberPreference(PANE_WIDTH_KEY, applied)
      handle.setAttribute('aria-valuenow', String(Math.round(applied)))
    })
    : null
  resizeObserver?.observe(shell)

  const updateToggle = () => {
    const label = open ? '关闭录制说明' : '打开录制说明'
    toggle.setAttribute('aria-expanded', String(open))
    toggle.setAttribute('aria-label', label)
    toggle.setAttribute('title', label)
  }
  const clearCloseWatchers = () => {
    if (closeTimer !== null) clearTimeout(closeTimer)
    closeTimer = null
    if (closeTransitionEnd) paneInner.removeEventListener('transitionend', closeTransitionEnd)
    closeTransitionEnd = null
    if (closeMotionChange) reducedMotionQuery?.removeEventListener?.('change', closeMotionChange)
    closeMotionChange = null
  }
  const cancelClose = () => {
    closeRevision += 1
    clearCloseWatchers()
    shell.classList.remove('analysis-pane-closing')
  }
  const finishClose = revision => {
    if (destroyed || open || revision !== closeRevision) return
    clearCloseWatchers()
    shell.classList.remove('analysis-pane-closing', 'analysis-pane-open')
    host.hidden = true
  }
  const hasActiveExitTransition = () => paneInner.getAnimations().some(animation => {
    const property = animation.transitionProperty
    const isCssTransition = typeof CSSTransition === 'undefined' || animation instanceof CSSTransition
    return isCssTransition && ['opacity', 'transform'].includes(property) && !['finished', 'idle'].includes(animation.playState)
  })
  const armCloseFallback = revision => {
    if (closeTimer !== null) clearTimeout(closeTimer)
    const delay = reducedMotionQuery?.matches ? REDUCED_MOTION_EXIT_FALLBACK_MS : PANE_EXIT_FALLBACK_MS
    closeTimer = setTimeout(() => finishClose(revision), delay)
  }
  const watchCloseCompletion = revision => {
    clearCloseWatchers()
    closeTransitionEnd = event => {
      if (event.target !== paneInner || !['opacity', 'transform'].includes(event.propertyName)) return
      requestAnimationFrame(() => {
        if (destroyed || open || revision !== closeRevision || hasActiveExitTransition()) return
        finishClose(revision)
      })
    }
    closeMotionChange = () => armCloseFallback(revision)
    paneInner.addEventListener('transitionend', closeTransitionEnd)
    reducedMotionQuery?.addEventListener?.('change', closeMotionChange)
    armCloseFallback(revision)
  }
  const setOpen = (next, { restoreFocus = true } = {}) => {
    if (!drawerQuery?.matches && !next) next = true
    if (next) {
      const wasHidden = host.hidden
      cancelClose()
      const revision = closeRevision
      open = true
      host.hidden = false
      if (wasHidden) shell.classList.remove('analysis-pane-open', 'analysis-pane-closing')
      else shell.classList.add('analysis-pane-open')
      updateToggle()
      onOpenChange(true)
      requestAnimationFrame(() => {
        if (destroyed || !open || revision !== closeRevision) return
        shell.classList.add('analysis-pane-open')
        controller?.refresh?.()
      })
      return
    }
    if (!open) return
    open = false
    closeRevision += 1
    const revision = closeRevision
    watchCloseCompletion(revision)
    shell.classList.add('analysis-pane-open', 'analysis-pane-closing')
    updateToggle()
    onOpenChange(false)
    if (restoreFocus) toggle.focus({ preventScroll: true })
  }
  const setClosePending = pending => {
    closePending = Boolean(pending)
    close.disabled = closePending
    toggle.disabled = closePending
  }
  const closePane = async () => {
    if (!open || closePending) return false
    setClosePending(true)
    try {
      if (!await flush()) return false
      if (destroyed) return false
      setClosePending(false)
      setOpen(false)
      return true
    } finally {
      if (!destroyed && closePending) setClosePending(false)
    }
  }

  const setPlaceholder = ({ title = '录制说明', message = '选择一段录制，或开始新录制后在这里补充上下文。' } = {}) => {
    const signature = `${title}\n${message}`
    if (recordingId === null && !controller && !loadingRecordingId && placeholderSignature === signature && promptSlot.firstElementChild) return
    recordingId = null
    loadingRecordingId = null
    loadingPromise = null
    placeholderSignature = signature
    loadRevision += 1
    controller?.destroy()
    controller = null
    delete host.dataset.contextRecordingId
    contextStatus.replaceChildren()
    promptSlot.innerHTML = `<div class="context-placeholder" data-context-placeholder><span aria-hidden="true">${contextIcon()}</span><strong>${escapeHtml(title)}</strong><p>${escapeHtml(message)}</p></div>`
  }

  const setSwitchError = visible => {
    contextStatus.innerHTML = visible
      ? '<div class="inline-error context-switch-error" data-context-switch-error role="alert">录制说明未切换：请先重试保存当前内容。</div>'
      : ''
  }

  const showRecording = async (nextRecordingId, { forceReload = false } = {}) => {
    if (!nextRecordingId) {
      setPlaceholder()
      return true
    }
    if (recordingId === nextRecordingId) {
      if (controller && !forceReload) return true
      if (loadingRecordingId === nextRecordingId && loadingPromise && !forceReload) return loadingPromise
    }
    if (controller && !await controller.beforeNavigate()) {
      setSwitchError(true)
      return false
    }

    const revision = ++loadRevision
    setSwitchError(false)
    controller?.destroy()
    controller = null
    recordingId = nextRecordingId
    host.dataset.contextRecordingId = nextRecordingId
    loadingRecordingId = nextRecordingId
    placeholderSignature = null
    promptSlot.innerHTML = '<div class="context-loading" role="status" aria-live="polite"><span class="loading-ring"></span><span>正在读取录制说明…</span></div>'

    const currentLoad = (async () => {
      try {
        const nextController = await renderPromptEditor({ container: promptSlot, recordingId: nextRecordingId, api })
        if (destroyed || revision !== loadRevision || recordingId !== nextRecordingId) {
          nextController.destroy()
          return false
        }
        controller = nextController
        if (open) requestAnimationFrame(() => controller?.refresh?.())
        return true
      } catch (error) {
        if (destroyed || revision !== loadRevision) return false
        promptSlot.innerHTML = `<div class="inline-error context-load-error" data-prompt-load-error role="alert"><strong>无法读取分析指导</strong><span>${escapeHtml(error.message)}</span><button class="button quiet" type="button" data-retry-prompt>重试</button></div>`
        promptSlot.querySelector('[data-retry-prompt]')?.addEventListener('click', () => {
          void showRecording(nextRecordingId, { forceReload: true })
        })
        return false
      } finally {
        if (revision === loadRevision) {
          loadingRecordingId = null
          loadingPromise = null
        }
      }
    })()
    loadingPromise = currentLoad
    return currentLoad
  }

  const flush = () => controller?.flush?.() ?? Promise.resolve(true)
  const beforeNavigate = () => controller?.beforeNavigate?.() ?? Promise.resolve(true)
  const beforeSwitch = async () => {
    const allowed = await beforeNavigate()
    setSwitchError(!allowed)
    return allowed
  }
  const hideDrawerImmediately = () => {
    cancelClose()
    open = false
    host.hidden = true
    shell.classList.remove('analysis-pane-open')
    updateToggle()
    onOpenChange(false)
  }
  const handleDrawerChange = event => {
    handle.hidden = event.matches
    if (event.matches) hideDrawerImmediately()
    else setOpen(true, { restoreFocus: false })
  }

  toggle.addEventListener('click', () => { if (open) void closePane(); else setOpen(true) })
  close.addEventListener('click', () => { void closePane() })
  drawerQuery?.addEventListener?.('change', handleDrawerChange)
  handleDrawerChange(drawerQuery || { matches: false })
  setPlaceholder()

  return {
    showRecording,
    showPlaceholder: setPlaceholder,
    flush,
    beforeNavigate,
    beforeSwitch,
    setOpen,
    get recordingId() { return recordingId },
    destroy() {
      destroyed = true
      loadRevision += 1
      loadingRecordingId = null
      loadingPromise = null
      cancelClose()
      drawerQuery?.removeEventListener?.('change', handleDrawerChange)
      resizeObserver?.disconnect()
      detachResize()
      handle.remove()
      controller?.destroy()
      controller = null
    }
  }
}

function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]) }
function closeIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8"/></svg>' }
function contextIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4zM14 5v14M7 9h4M7 13h4"/></svg>' }
