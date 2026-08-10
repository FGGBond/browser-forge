import { api } from './api.js'
import { createState } from './state.js'
import { renderLibrary } from './views/library.js'
import { renderNewRecording, renderRecording } from './views/recording.js'
import { renderDetail } from './views/detail.js'
import { renderTrash } from './views/trash.js'
import { readSidebarCollapsed, renderSidebar, writeSidebarCollapsed } from './views/sidebar.js'
import { mountSidebarResize } from './views/split-resize.js'

const state = createState({
  route: 'library',
  filter: 'active',
  query: '',
  recordings: [],
  selectedId: null,
  activeRecording: null,
  sidebarCollapsed: readSidebarCollapsed(),
  analysisPaneOpen: true
})

export function upsertRecording(recordings = [], recording) {
  if (!recording?.id) return recordings
  const previous = recordings.find(item => item.id === recording.id)
  const next = { ...previous, ...recording }
  const remaining = recordings.filter(item => item.id !== recording.id)
  if (next.state && next.state !== 'active') return remaining
  return [next, ...remaining].sort((left, right) => recordingTime(right) - recordingTime(left))
}

function recordingTime(recording) {
  const value = Date.parse(recording?.createdAt || '')
  return Number.isNaN(value) ? 0 : value
}

function completionPreview(result) {
  const source = result?.recording || {}
  const id = source.id || result?.recordingId
  if (!id) return null
  const preview = { ...source, id }
  if (!preview.title) preview.title = pendingRecordingTitle(new Date())
  if (!preview.state) preview.state = 'active'
  if (!preview.createdAt) preview.createdAt = new Date().toISOString()
  return preview
}

function isCompleteRecording(recording) {
  return Boolean(
    recording?.id && recording.title && recording.state && recording.createdAt &&
    Number.isFinite(Number(recording.durationMs)) &&
    Object.hasOwn(recording, 'startHost') && Array.isArray(recording.visitedHosts) &&
    recording.videoStatus && recording.promptStatus
  )
}

function pendingRecordingTitle(date) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `Recording-${Number(values.month)}月${Number(values.day)}日${values.hour}:${values.minute}`
}

const root = document.getElementById('app')
const isElectron = new URLSearchParams(location.search).get('shell') === 'electron'
document.body.classList.toggle('shell-electron', isElectron)
root.innerHTML = `
  <div class="app-shell" data-app-shell>
    <div data-sidebar-host></div>
    <main class="app-main" data-main></main>
  </div>`
const shell = root.querySelector('[data-app-shell]')
const sidebarHost = root.querySelector('[data-sidebar-host]')
const main = root.querySelector('[data-main]')
let cleanupView
let beforeNavigate
let navigating = false

const beforeCloseHook = async () => {
  const activeBeforeNavigate = beforeNavigate
  if (!activeBeforeNavigate) return true
  try {
    return await activeBeforeNavigate() !== false
  } catch {
    return false
  }
}
window.__browserForgeBeforeClose = beforeCloseHook
window.addEventListener('pagehide', () => {
  if (window.__browserForgeBeforeClose === beforeCloseHook) delete window.__browserForgeBeforeClose
}, { once: true })

const SIDEBAR_LABEL_ENTER_DURATION_MS = 170
const SIDEBAR_LABEL_EXIT_DURATION_MS = 110
const SIDEBAR_REDUCED_MOTION_DURATION_MS = 80
let sidebarElement = null
let sidebarStructureKey = ''
let detachSidebarResize = null
let sidebarTargetCollapsed = null
let sidebarMotionRevision = 0
let sidebarMotionTimer = null
let sidebarMotionFrames = []

const sidebarActions = {
  onNew: () => navigate('new-recording'),
  onNavigate: (route, id) => id ? navigate('detail', { selectedId: id }) : navigate(route),
  onToggle: () => {
    const sidebarCollapsed = !state.value.sidebarCollapsed
    writeSidebarCollapsed(sidebarCollapsed)
    state.update({ sidebarCollapsed })
  }
}

function sidebarKey(value) {
  return JSON.stringify([
    value.route,
    value.selectedId,
    value.route === 'recording',
    value.recordings.map(recording => [recording.id, recording.title, recording.state])
  ])
}

function sidebarRenderOptions(container, value) {
  return {
    container,
    recordings: value.recordings,
    route: value.route,
    selectedId: value.selectedId,
    collapsed: value.sidebarCollapsed,
    locked: value.route === 'recording',
    ...sidebarActions
  }
}

function renderSidebarStructure(value) {
  const nextKey = sidebarKey(value)
  if (sidebarElement && nextKey === sidebarStructureKey) return
  sidebarStructureKey = nextKey

  if (!sidebarElement) {
    renderSidebar(sidebarRenderOptions(sidebarHost, value))
    sidebarElement = sidebarHost.querySelector('.app-sidebar')
    mountSidebarResizeHandleIfNeeded()
    return
  }

  if (!sidebarElement.isConnected) {
    if (detachSidebarResize) { detachSidebarResize(); detachSidebarResize = null }
    sidebarElement = null
    return
  }
  const staging = document.createElement('div')
  renderSidebar(sidebarRenderOptions(staging, value))
  const nextSidebar = staging.querySelector('.app-sidebar')
  if (!nextSidebar) return
  const resizeHandle = sidebarElement.querySelector('.sidebar-resize-handle')
  const nextChildren = Array.from(nextSidebar.childNodes).filter(
    node => !node.classList?.contains('sidebar-resize-handle')
  )
  sidebarElement.replaceChildren(...nextChildren)
  if (resizeHandle) sidebarElement.append(resizeHandle)
}

function setSidebarMotionPhase(phase) {
  shell.setAttribute('data-sidebar-motion', phase)
}

function cancelSidebarMotion() {
  sidebarMotionRevision += 1
  if (sidebarMotionTimer !== null) clearTimeout(sidebarMotionTimer)
  sidebarMotionTimer = null
  for (const frame of sidebarMotionFrames) cancelAnimationFrame(frame)
  sidebarMotionFrames = []
  return sidebarMotionRevision
}

function scheduleSidebarFrame(callback) {
  const frame = requestAnimationFrame(() => {
    sidebarMotionFrames = sidebarMotionFrames.filter(value => value !== frame)
    callback()
  })
  sidebarMotionFrames.push(frame)
}

function sidebarMotionDuration(normalDuration) {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ? SIDEBAR_REDUCED_MOTION_DURATION_MS
    : normalDuration
}

function syncSidebarResizeEnabled() {
  sidebarElement?.querySelectorAll('.sidebar-resize-handle').forEach(handle => {
    handle.dataset.disabled = state.value.sidebarCollapsed ? 'true' : ''
  })
}

function updateSidebarToggle(collapsed) {
  const toggle = sidebarElement?.querySelector('[data-sidebar-toggle]')
  if (!toggle) return
  const label = collapsed ? '展开侧边栏' : '收起侧边栏'
  toggle.setAttribute('aria-label', label)
  toggle.setAttribute('title', label)
  const copy = toggle.querySelector('.sidebar-label')
  if (copy) copy.textContent = label
  const direction = toggle.querySelector('svg path:last-child')
  if (direction) direction.setAttribute('d', collapsed ? 'M12 7l3 3-3 3' : 'M15 7l-3 3 3 3')
}

function mountSidebarResizeHandleIfNeeded() {
  if (!sidebarElement || detachSidebarResize) return
  const controller = mountSidebarResize({
    shell,
    sidebarElement,
    isCollapsed: () => state.value.sidebarCollapsed,
    onWidthChange: () => {},
    onDraggingChange: dragging => {
      shell.classList.toggle('sidebar-resizing', dragging)
    }
  })
  detachSidebarResize = () => controller.detach()
}

function initializeSidebarMotion(collapsed) {
  sidebarTargetCollapsed = collapsed
  shell.classList.toggle('sidebar-collapsed', collapsed)
  sidebarElement.classList.toggle('is-collapsed', collapsed)
  sidebarElement.classList.toggle('sidebar-labels-hidden', collapsed)
  updateSidebarToggle(collapsed)
  setSidebarMotionPhase(collapsed ? 'collapsed' : 'expanded')
  mountSidebarResizeHandleIfNeeded()
}

function transitionSidebar(collapsed) {
  const revision = cancelSidebarMotion()
  sidebarTargetCollapsed = collapsed
  updateSidebarToggle(collapsed)

  if (collapsed) {
    setSidebarMotionPhase('collapsing')
    sidebarElement.classList.add('sidebar-labels-hidden')
    shell.classList.add('sidebar-collapsed')
    sidebarElement.classList.add('is-collapsed')
    sidebarMotionTimer = setTimeout(() => {
      if (revision !== sidebarMotionRevision || !sidebarTargetCollapsed) return
      setSidebarMotionPhase('collapsed')
      sidebarMotionTimer = null
    }, sidebarMotionDuration(SIDEBAR_LABEL_EXIT_DURATION_MS))
    return
  }

  shell.classList.remove('sidebar-collapsed')
  sidebarElement.classList.remove('is-collapsed')
  sidebarElement.classList.add('sidebar-labels-hidden')
  setSidebarMotionPhase('expanding')
  scheduleSidebarFrame(() => scheduleSidebarFrame(() => {
    if (revision !== sidebarMotionRevision || sidebarTargetCollapsed) return
    sidebarElement.classList.remove('sidebar-labels-hidden')
    sidebarMotionTimer = setTimeout(() => {
      if (revision !== sidebarMotionRevision || sidebarTargetCollapsed) return
      setSidebarMotionPhase('expanded')
      sidebarMotionTimer = null
    }, sidebarMotionDuration(SIDEBAR_LABEL_ENTER_DURATION_MS))
  }))
}

function renderWorkspaceSidebar(value = state.value) {
  renderSidebarStructure(value)
  if (sidebarTargetCollapsed === null) {
    initializeSidebarMotion(value.sidebarCollapsed)
    syncSidebarResizeEnabled()
    return
  }
  if (value.sidebarCollapsed !== sidebarTargetCollapsed) transitionSidebar(value.sidebarCollapsed)
  syncSidebarResizeEnabled()
}

state.subscribe(renderWorkspaceSidebar)
renderWorkspaceSidebar()

export async function navigate(route, patch = {}, { force = false } = {}) {
  if (navigating) return false
  navigating = true
  try {
    if (!force && beforeNavigate && !await beforeNavigate()) return false
    cleanupView?.()
    cleanupView = null
    beforeNavigate = null
    state.update({ route, ...patch })
    if (route === 'library') {
      const controller = await renderLibrary({
        container: main,
        api,
        state,
        onSelect: id => navigate('detail', { selectedId: id })
      })
      cleanupView = controller?.cleanup
      return true
    }
    if (route === 'new-recording') {
      const controller = await renderNewRecording({
        container: main,
        api,
        onStarted: result => navigate('recording', { activeRecording: result })
      })
      cleanupView = controller?.cleanup
      return true
    }
    if (route === 'recording') {
      const controller = await renderRecording({
        container: main,
        api,
        activeRecording: state.value.activeRecording,
        onStopped: async result => {
          const preview = completionPreview(result)
          const recordingId = preview?.id || result.recordingId
          if (preview) state.update(value => ({ recordings: upsertRecording(value.recordings, preview) }))
          if (recordingId && !isCompleteRecording(result.recording)) {
            try {
              const recording = await api.getRecording(recordingId)
              state.update(value => ({ recordings: upsertRecording(value.recordings, recording) }))
            } catch {}
          }
          return recordingId
            ? navigate('detail', { selectedId: recordingId }, { force: true })
            : navigate('library', {}, { force: true })
        },
        onCancel: () => navigate('library', {}, { force: true })
      })
      cleanupView = controller.cleanup
      beforeNavigate = controller.beforeNavigate
      return true
    }
    if (route === 'detail') {
      const controller = await renderDetail({
        container: main,
        api,
        recordingId: state.value.selectedId,
        analysisPaneOpen: state.value.analysisPaneOpen,
        onAnalysisPaneChange: analysisPaneOpen => state.update({ analysisPaneOpen }),
        onRecordingUpdated: recording => state.update(value => ({ recordings: upsertRecording(value.recordings, recording) })),
        onBack: () => navigate('library'),
        onTrashed: async recording => { showUndoToast(recording); await navigate('library', {}, { force: true }) }
      })
      if (controller) {
        beforeNavigate = controller.beforeNavigate
        cleanupView = controller.cleanup
      }
      return true
    }
    if (route === 'trash') {
      await renderTrash({
        container: main,
        api,
        onBack: () => navigate('library'),
        onRestored: recording => navigate('detail', { selectedId: recording.id })
      })
      return true
    }
    return true
  } finally {
    navigating = false
  }
}

function showUndoToast(recording) {
  root.querySelector('[data-toast]')?.remove()
  const toast = document.createElement('div')
  toast.className = 'toast'
  toast.dataset.toast = ''
  toast.innerHTML = `<span>“${escapeHtml(recording.title)}”已移入回收站</span><button type="button" data-undo-trash>撤销</button>`
  root.append(toast)
  const timer = setTimeout(() => toast.remove(), 8000)
  toast.querySelector('[data-undo-trash]').addEventListener('click', async () => {
    clearTimeout(timer)
    const restored = await api.restoreRecording(recording.id)
    toast.remove()
    await navigate('detail', { selectedId: restored.id })
  })
}

function escapeHtml(value) { return String(value ?? '').replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]) }

navigate('library')
