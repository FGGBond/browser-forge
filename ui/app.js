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
  analysisPaneOpen: false,
  analysisExpanded: false
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
  </div>
  <button class="sidebar-reveal" type="button" data-sidebar-reveal aria-label="显示侧边栏" title="显示侧边栏" hidden>
    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4h12v12H4zM9 4v12M12 7l3 3-3 3"/></svg>
  </button>`
const shell = root.querySelector('[data-app-shell]')
const sidebarHost = root.querySelector('[data-sidebar-host]')
const main = root.querySelector('[data-main]')
const sidebarReveal = root.querySelector('[data-sidebar-reveal]')
sidebarReveal.addEventListener('click', () => {
  autoCollapseFlag = AUTO_COLLAPSE_CLEAR
  autoCollapsePrefs.clear()
  clearAutoCollapseRevertTimer()
  writeSidebarCollapsed(false)
  if (sidebarHoverPeek) dismissSidebarHoverPeek()
  state.update({ sidebarCollapsed: false })
})
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
const SIDEBAR_EXPANDED_MIN_WIDTH = 180
const SIDEBAR_COLLAPSED_WIDTH = 68
const AUTO_COLLAPSE_CLEAR = 'clear'
let autoCollapseRevertTimer = null

// 用户在分析面板中输入内容时调用此钩子,阻止 auto-collapse revert timer 把左侧栏自动唤起
// 挂到 window 上避开 ES module 循环依赖 (detail.js → prompt-editor.js → app.js)
function signalComposerEngagement() {
  if (autoCollapseFlag === AUTO_COLLAPSE_CLEAR) return
  clearAutoCollapseRevertTimer()
  autoCollapsePrefs.clear()
  autoCollapseFlag = AUTO_COLLAPSE_CLEAR
  // 防止 nudge 闪烁
  if (autoCollapseNudgeTimer !== null) {
    clearTimeout(autoCollapseNudgeTimer)
    autoCollapseNudgeTimer = null
  }
  shell.classList?.remove('sidebar-nudging')
  const active = sidebarElement?.querySelector('[data-recording-nav].active')
  active?.classList?.remove('nudging')
}
globalThis.signalComposerEngagement = signalComposerEngagement
let autoCollapseNudgeTimer = null
let sidebarElement = null
let sidebarStructureKey = ''
let detachSidebarResize = null
let sidebarResizeSuppressedHover = false
let sidebarTargetCollapsed = null
let sidebarMotionRevision = 0
let sidebarMotionTimer = null
let sidebarMotionFrames = []
let autoCollapseFlag = null


const autoCollapsePrefs = {
  key: 'session',
  read() {
    try { return globalThis.sessionStorage?.getItem('browser-forge.sidebar-auto-collapse') || null }
    catch { return null }
  },
  write(value) {
    try { globalThis.sessionStorage?.setItem('browser-forge.sidebar-auto-collapse', value) } catch {}
  },
  clear() {
    try { globalThis.sessionStorage?.removeItem('browser-forge.sidebar-auto-collapse') } catch {}
  }
}

function readClampedSidebarWidth() {
  try {
    const raw = Number(globalThis.localStorage?.getItem('browser-forge.sidebar-width'))
    if (Number.isFinite(raw) && raw >= 128) return Math.round(raw)
  } catch {}
  return null
}

// 运行时展开宽度:优先取用户拖过的保存值;尚未拖过则用当前轨道初始宽(240px)
function sidebarExpandedWidth() {
  const runtime = Math.round(sidebarElement?.getBoundingClientRect?.().width || 0)
  return readClampedSidebarWidth() ?? (runtime > 100 ? runtime : 240)
}

function clearAutoCollapseRevertTimer() {
  if (autoCollapseRevertTimer !== null) clearTimeout(autoCollapseRevertTimer)
  autoCollapseRevertTimer = null
}

function suppressSidebarTransitionsWhile(callback) {
  shell.classList.add('sidebar-resizing')
  try { callback?.() }
  finally {
    requestAnimationFrame?.(() => requestAnimationFrame?.(() => shell.classList.remove('sidebar-resizing')))
      ?? setTimeout(() => shell.classList.remove('sidebar-resizing'), 50)
  }
}

function nudgeAutoCollapsedEntry() {
  const entry = sidebarElement?.querySelector('[data-recording-nav].active')
  if (!entry || autoCollapseFlag === AUTO_COLLAPSE_CLEAR) return
  if (autoCollapseNudgeTimer !== null) clearTimeout(autoCollapseNudgeTimer)
  shell.classList.add('sidebar-nudging')
  entry.classList.add('nudging')
  autoCollapseNudgeTimer = setTimeout(() => {
    autoCollapseNudgeTimer = null
    entry.classList.remove('nudging')
    shell.classList.remove('sidebar-nudging')
  }, 900)
}

function revertAutoCollapseIfRequestOrigin() {
  if (!autoCollapseFlag || autoCollapseFlag === AUTO_COLLAPSE_CLEAR) return
  const routeMatches = autoCollapseFlag === state.value.selectedId || (state.value.route === 'detail' && autoCollapseFlag === 'detail')
  if (!routeMatches || !state.value.sidebarCollapsed) return
  const revision = sidebarMotionRevision
  clearAutoCollapseRevertTimer()
  autoCollapseRevertTimer = setTimeout(() => {
    autoCollapseRevertTimer = null
    if (revision !== sidebarMotionRevision || !state.value.sidebarCollapsed) return
    const savedWidth = readClampedSidebarWidth()
    suppressSidebarTransitionsWhile(() => {
      shell.style.setProperty('--sidebar-w', `${sidebarExpandedWidth()}px`)
      transitionSidebar(false)
      state.update({ sidebarCollapsed: false })
    })
  }, autoCollapsePrefs.read() === 'pending-review' ? 900 : 420)
}

function scheduleAutoCollapsedPeek() {
  if (!state.value.sidebarCollapsed || !autoCollapseFlag || autoCollapseFlag === AUTO_COLLAPSE_CLEAR) return
  nudgeAutoCollapsedEntry()
}

const sidebarActions = {
  onNew: () => navigate('new-recording'),
  onNavigate: (route, id) => id ? navigate('detail', { selectedId: id }) : navigate(route),
  onToggle: () => {
    autoCollapseFlag = AUTO_COLLAPSE_CLEAR
    autoCollapsePrefs.clear()
    const sidebarCollapsed = !state.value.sidebarCollapsed
    writeSidebarCollapsed(sidebarCollapsed)
    state.update({ sidebarCollapsed })
  }
}

function sidebarKey(value) {
  return JSON.stringify([
    value.route,
    value.selectedId,
    value.analysisExpanded,
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
    analysisExpanded: Boolean(value.analysisExpanded),
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
  sidebarReveal.hidden = !state.value.sidebarCollapsed
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

function applySidebarFullCollapse(collapsed) {
  shell.classList.toggle('sidebar-hidden', collapsed)
  sidebarHost.classList.toggle('is-hidden', collapsed)
  if (collapsed) dismissSidebarHoverPeek()
}

// 隐藏态:指针进入窗口左缘细热区时,以悬浮层临时展开侧边栏(覆盖,不改变中间区)
let sidebarHoverPeek = false
let sidebarHoverDetach = null

function dismissSidebarHoverPeek() {
  if (!sidebarHoverPeek) return
  sidebarHoverPeek = false
  sidebarHost.classList.remove('sidebar-hover-peek')
  shell.removeAttribute('data-sidebar-peek')
  // 悬浮期间用户未主动展开 → 还原回收起态;若用户已在浮层里点了「显示侧边栏」就保持展开
  if (isSidebarCollapsedByUser()) state.update({ sidebarCollapsed: true })
  if (sidebarHoverDetach) { sidebarHoverDetach(); sidebarHoverDetach = null }
}

function isSidebarCollapsedByUser() {
  try { return globalThis.localStorage?.getItem('browser-forge.sidebar-collapsed') === 'true' } catch { return true }
}

function mountSidebarHoverReveal() {
  const HOT_ZONE_WIDTH = 56
  const HIDE_DELAY_MS = 260
  let hideTimer = null

  const canPeek = () => shell.classList.contains('sidebar-hidden')

  const cancelHide = () => {
    if (hideTimer !== null) clearTimeout(hideTimer)
    hideTimer = null
  }

  const scheduleHide = () => {
    cancelHide()
    hideTimer = setTimeout(() => {
      hideTimer = null
      dismissSidebarHoverPeek()
    }, HIDE_DELAY_MS)
  }

  let lastHotX = null
  const handleWindowPointerMove = event => {
    if (!sidebarHoverPeek) {
      const x = event.clientX
      const entering = lastHotX === null || lastHotX > HOT_ZONE_WIDTH || x < lastHotX
      lastHotX = x
      if (!canPeek() || x > HOT_ZONE_WIDTH || !entering) return
      sidebarHoverPeek = true
      // 自动收起结束时会将 --sidebar-w inline 归零;悬浮为纯视觉层,不触发状态/大 grid 重排
      const restored = sidebarExpandedWidth()
      shell.style.setProperty('--sidebar-w', `${restored}px`)
      sidebarHost.classList.remove('is-hidden')
      sidebarElement?.classList.remove('sidebar-labels-hidden')
      sidebarHost.classList.add('sidebar-hover-peek')
      shell.setAttribute('data-sidebar-peek', 'open')
    }
  }

  // 指针从热区向悬浮栏过渡时,按位置判定替代 enter/leave 事件(隐藏宿主不派发 pointer 事件)
  const trackPointerIntoPeek = event => {
    if (!sidebarHoverPeek) return
    if (event.clientX <= sidebarHost.getBoundingClientRect().right + 2) cancelHide()
    else scheduleHide()
  }

  window.addEventListener('pointermove', handleWindowPointerMove, { passive: true })
  window.addEventListener('pointermove', trackPointerIntoPeek, { passive: true })

  sidebarHoverDetach = () => {
    cancelHide()
    window.removeEventListener('pointermove', handleWindowPointerMove)
    window.removeEventListener('pointermove', trackPointerIntoPeek)
  }
}

mountSidebarHoverReveal()

// 悬浮层内的收起/展开按钮:收起=记下偏好并收起浮层;展开=取消 pending 恢复并真正固定展开
sidebarHost.addEventListener('click', event => {
  if (!sidebarHoverPeek) return
  const toggle = event.target?.closest?.('[data-sidebar-toggle]')
  if (!toggle) return
  event.stopImmediatePropagation()
  event.preventDefault()
  autoCollapseFlag = AUTO_COLLAPSE_CLEAR
  autoCollapsePrefs.clear()
  clearAutoCollapseRevertTimer()
  if (toggle.getAttribute('aria-label')?.includes('显示') || toggle.title?.includes('显示')) {
    writeSidebarCollapsed(false)
    dismissSidebarHoverPeek()
    state.update({ sidebarCollapsed: false })
    return
  }
  writeSidebarCollapsed(true)
  dismissSidebarHoverPeek()
}, true)

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
  applySidebarFullCollapse(collapsed)
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
    applySidebarFullCollapse(true)
    sidebarMotionTimer = setTimeout(() => {
      if (revision !== sidebarMotionRevision || !sidebarTargetCollapsed) return
      setSidebarMotionPhase('collapsed')
      sidebarMotionTimer = null
      if (autoCollapseFlag && autoCollapseFlag !== AUTO_COLLAPSE_CLEAR) applyAutoCollapsedPeek()
    }, sidebarMotionDuration(SIDEBAR_LABEL_EXIT_DURATION_MS))
    return
  }

  applySidebarFullCollapse(false)
  shell.classList.remove('sidebar-collapsed')
  sidebarHost.classList.remove('is-hidden')
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

function applyAutoCollapsedPeek() {
  const flagElement = sidebarElement?.querySelector('.primary-nav [data-recording-nav].active, .sidebar-recordings [data-recording-nav].active, [data-recording-nav].active')
  const entry = flagElement ?? null
  if (!entry) return
  entry.classList.add('nudging')
  shell.classList.add('sidebar-nudging')
  if (autoCollapseNudgeTimer !== null) clearTimeout(autoCollapseNudgeTimer)
  const release = () => {
    autoCollapseNudgeTimer = null
    entry.classList.remove('nudging')
    shell.classList.remove('sidebar-nudging')
  }
  autoCollapseNudgeTimer = setTimeout(() => {
    release()
    revertAutoCollapseIfRequestOrigin()
  }, 900)
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
        onAnalysisPaneChange: analysisPaneOpen => state.update(
          analysisPaneOpen ? { analysisPaneOpen } : { analysisPaneOpen, analysisExpanded: false }
        ),
        onToggleSidebar: collapsed => {
          if (collapsed && !state.value.sidebarCollapsed) {
            autoCollapseFlag = state.value.selectedId || 'detail'
            autoCollapsePrefs.write('pending-review')
            state.update({ sidebarCollapsed: true, analysisExpanded: true })
            return
          }
          if (collapsed) {
            autoCollapseFlag = AUTO_COLLAPSE_CLEAR
            autoCollapsePrefs.clear()
            writeSidebarCollapsed(true)
            state.update({ sidebarCollapsed: true, analysisExpanded: true })
            return
          }
          autoCollapseFlag = AUTO_COLLAPSE_CLEAR
          autoCollapsePrefs.clear()
          writeSidebarCollapsed(false)
          state.update({ sidebarCollapsed: false, analysisExpanded: true })
        },
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
