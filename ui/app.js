import { api } from './api.js'
import { createState } from './state.js'
import { renderLibrary } from './views/library.js'
import { renderNewRecording, renderRecording } from './views/recording.js'
import { renderDetail } from './views/detail.js'
import { renderTrash } from './views/trash.js'
import { readSidebarCollapsed, renderSidebar, writeSidebarCollapsed } from './views/sidebar.js'

const state = createState({
  route: 'library',
  filter: 'active',
  query: '',
  recordings: [],
  selectedId: null,
  activeRecording: null,
  sidebarCollapsed: readSidebarCollapsed(),
  analysisPaneOpen: false
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
let cleanupSidebar
let cleanupView
let beforeNavigate
let navigating = false

function renderWorkspaceSidebar(value = state.value) {
  cleanupSidebar?.()
  const analysisModalOpen = value.route === 'detail' && value.analysisPaneOpen
  sidebarHost.inert = analysisModalOpen
  if (analysisModalOpen) sidebarHost.setAttribute('aria-hidden', 'true')
  else sidebarHost.removeAttribute('aria-hidden')
  shell.classList.toggle('sidebar-collapsed', value.sidebarCollapsed)
  cleanupSidebar = renderSidebar({
    container: sidebarHost,
    recordings: value.recordings,
    route: value.route,
    selectedId: value.selectedId,
    collapsed: value.sidebarCollapsed,
    locked: value.route === 'recording',
    onNew: () => navigate('new-recording'),
    onNavigate: (route, id) => id ? navigate('detail', { selectedId: id }) : navigate(route),
    onToggle: () => {
      const sidebarCollapsed = !state.value.sidebarCollapsed
      writeSidebarCollapsed(sidebarCollapsed)
      state.update({ sidebarCollapsed })
    }
  })
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
