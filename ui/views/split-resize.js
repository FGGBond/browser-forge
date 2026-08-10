import { readNumberPreference, writeNumberPreference } from '../layout-prefs.js'

export const SIDEBAR_MIN_WIDTH = 180
export const SIDEBAR_MAX_WIDTH = 420
export const SIDEBAR_COLLAPSED_WIDTH = 68
export const SIDEBAR_DEFAULT_WIDTH = 240

const clampNumber = (value, min, max) => Math.min(Math.max(value, min), max)

export function mountSplitHandle({
  handle,
  getWidth,
  setWidth,
  onDragStart = () => {},
  onDragEnd = () => {},
  onReset = null,
  invert = false,
  min = 0,
  max = Number.POSITIVE_INFINITY,
  isEnabled = () => true,
  storageKey = null,
  step = 8,
  bigStep = 24
} = {}) {
  if (!handle) return () => {}
  let dragging = false
  let startCoord = 0
  let startWidth = 0

  const clamp = value => clampNumber(value, min, max)
  const applyWidth = raw => setWidth(clamp(raw))
  const persist = width => {
    if (Number.isFinite(width) && storageKey) writeNumberPreference(storageKey, width)
  }

  const handlePointerMove = event => {
    if (!dragging) return
    const rawClientX = event.clientX
    const clientX = Number.isFinite(rawClientX) && rawClientX !== 0
      ? rawClientX
      : Number(event.screenX ?? event.pageX ?? 0)
    if (!Number.isFinite(clientX)) return
    const delta = (invert ? -1 : 1) * (clientX - startCoord)
    applyWidth(startWidth + delta)
    event.preventDefault()
  }

  const finishDrag = () => {
    if (!dragging) return
    dragging = false
    handle.classList.remove('is-dragging')
    document.body.classList.remove('split-resizing')
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', finishDrag)
    window.removeEventListener('pointercancel', finishDrag)
    const width = getWidth()
    persist(width)
    onDragEnd(width)
  }

  const handlePointerDown = event => {
    if (!isEnabled()) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const width = getWidth()
    if (!Number.isFinite(width)) return
    event.preventDefault()
    dragging = true
    const eventClientX = event.clientX
    startCoord = Number.isFinite(eventClientX) && eventClientX !== 0
      ? eventClientX
      : Number(event.screenX ?? event.pageX ?? 0)
    startWidth = width
    handle.classList.add('is-dragging')
    document.body.classList.add('split-resizing')
    try { handle.setPointerCapture?.(event.pointerId) } catch {}
    onDragStart(width)
    window.addEventListener('pointermove', handlePointerMove, { passive: false })
    window.addEventListener('pointerup', finishDrag)
    window.addEventListener('pointercancel', finishDrag)
  }

  const handleDoubleClick = () => {
    if (!isEnabled() || typeof onReset !== 'function') return
    const width = onReset()
    persist(width)
    onDragEnd(getWidth())
  }

  const handleKeyDown = event => {
    if (!isEnabled()) return
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const width = getWidth()
    if (!Number.isFinite(width)) return
    let next = width
    if (event.key === 'Home') next = min
    else if (event.key === 'End') next = max
    else {
      const delta = (event.shiftKey ? bigStep : step) * (event.key === 'ArrowRight' ? 1 : -1)
      next = width + (invert ? -delta : delta)
    }
    const applied = applyWidth(next)
    persist(getWidth())
    onDragStart(width)
    onDragEnd(getWidth())
    if (Number.isFinite(applied)) handle.setAttribute('aria-valuenow', String(Math.round(applied)))
  }

  handle.addEventListener('pointerdown', handlePointerDown)
  handle.addEventListener('dblclick', handleDoubleClick)
  handle.addEventListener('keydown', handleKeyDown)

  return () => {
    finishDrag()
    handle.removeEventListener('pointerdown', handlePointerDown)
    handle.removeEventListener('dblclick', handleDoubleClick)
    handle.removeEventListener('keydown', handleKeyDown)
  }
}

export function mountSidebarResize({
  shell,
  sidebarElement,
  storageKey = 'sidebar-width',
  isCollapsed = () => false,
  onWidthChange = () => {},
  onDraggingChange = () => {}
} = {}) {
  if (!shell || !sidebarElement) return () => {}
  const handle = document.createElement('div')
  handle.className = 'sidebar-resize-handle'
  handle.setAttribute('role', 'separator')
  handle.setAttribute('aria-orientation', 'vertical')
  handle.setAttribute('aria-label', '调整侧边栏宽度(方向键,Home 最小,End 最大)')
  handle.setAttribute('aria-valuemin', String(SIDEBAR_MIN_WIDTH))
  handle.setAttribute('aria-valuemax', String(SIDEBAR_MAX_WIDTH))
  handle.setAttribute('aria-valuenow', String(SIDEBAR_DEFAULT_WIDTH))
  handle.tabIndex = 0
  sidebarElement.append(handle)

  const readWidth = () => {
    const rect = sidebarElement.getBoundingClientRect()
    return rect.width > 0 ? rect.width : SIDEBAR_DEFAULT_WIDTH
  }
  const applyWidth = width => {
    const clamped = clampNumber(width, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH)
    shell.style.setProperty('--sidebar-w', `${Math.round(clamped)}px`)
    handle.setAttribute('aria-valuenow', String(Math.round(clamped)))
    onWidthChange(clamped)
    return clamped
  }

  const initial = clampNumber(
    readNumberPreference(storageKey, SIDEBAR_DEFAULT_WIDTH),
    SIDEBAR_MIN_WIDTH,
    SIDEBAR_MAX_WIDTH
  )
  applyWidth(initial)

  const syncEnabled = () => {
    handle.dataset.disabled = isCollapsed() ? 'true' : ''
  }
  syncEnabled()

  const detach = mountSplitHandle({
    handle,
    getWidth: readWidth,
    setWidth: applyWidth,
    isEnabled: () => !isCollapsed(),
    onDragStart: width => onDraggingChange(true, width),
    onDragEnd: width => onDraggingChange(false, width),
    onReset: () => applyWidth(SIDEBAR_DEFAULT_WIDTH),
    min: SIDEBAR_MIN_WIDTH,
    max: SIDEBAR_MAX_WIDTH,
    storageKey
  })

  return {
    applyWidth,
    syncEnabled,
    handle,
    detach() {
      detach()
      handle.remove()
    }
  }
}
