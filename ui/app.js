import { api } from './api.js'
import { createState } from './state.js'
import { renderLibrary } from './views/library.js'
import { renderNewRecording, renderRecording } from './views/recording.js'

const state = createState({
  route: 'library',
  filter: 'active',
  query: '',
  recordings: [],
  selectedId: null,
  activeRecording: null
})

const root = document.getElementById('app')
const isElectron = new URLSearchParams(location.search).get('shell') === 'electron'
document.body.classList.toggle('shell-electron', isElectron)
root.innerHTML = `
  <div class="app-shell">
    <aside class="app-sidebar">
      <div class="brand"><span class="brand-mark">${brandIcon()}</span><span><strong>Browser Forge</strong><small>Recording workspace</small></span></div>
      <nav class="primary-nav" aria-label="录制导航">
        <button type="button" data-nav="library">${libraryIcon()}<span>全部录制</span></button>
        <button type="button" data-nav="trash">${trashIcon()}<span>回收站</span></button>
      </nav>
      <button class="button primary sidebar-new" type="button" data-new-recording>${plusIcon()}<span>新建录制</span></button>
      <div class="sidebar-note"><i></i><span>录制物料只保存在这台设备</span></div>
    </aside>
    <main class="app-main" data-main></main>
  </div>`
const main = root.querySelector('[data-main]')
let cleanupView

root.querySelectorAll('[data-new-recording]').forEach(button => button.addEventListener('click', () => navigate('new-recording')))
root.querySelector('[data-nav="library"]').addEventListener('click', () => navigate('library'))
root.querySelector('[data-nav="trash"]').addEventListener('click', () => navigate('trash'))

export async function navigate(route, patch = {}) {
  cleanupView?.()
  cleanupView = null
  state.update({ route, ...patch })
  root.querySelectorAll('[data-nav]').forEach(button => button.classList.toggle('active', button.dataset.nav === route || (route === 'new-recording' && button.dataset.nav === 'library')))
  if (route === 'library') {
    await renderLibrary({
      container: main,
      api,
      state,
      onNew: () => navigate('new-recording'),
      onSelect: id => state.update({ selectedId: id }),
      onTrash: async id => {
        await api.trashRecording(id)
        await navigate('library')
      }
    })
    return
  }
  if (route === 'new-recording') {
    await renderNewRecording({
      container: main,
      api,
      onBack: () => navigate('library'),
      onStarted: result => navigate('recording', { activeRecording: result })
    })
    return
  }
  if (route === 'recording') {
    cleanupView = await renderRecording({
      container: main,
      api,
      activeRecording: state.value.activeRecording,
      onStopped: result => navigate('library', { selectedId: result.recordingId || null }),
      onCancel: () => navigate('library')
    })
    return
  }
  main.innerHTML = `<section class="narrow-view"><button class="back-button" data-back>返回</button><div class="empty-state"><h1>回收站将在这里显示</h1><p>录制被移入 App 内回收站后，可以恢复或永久删除。</p></div></section>`
  main.querySelector('[data-back]')?.addEventListener('click', () => navigate('library'))
}

navigate('library')

function brandIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="4"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01M8 14h8M12 11v6"/></svg>' }
function libraryIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3" width="14" height="14" rx="3"/><path d="M3 8h14M7 3v14"/></svg>' }
function trashIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 3h4l1 3H7l1-3ZM6 6l1 11h6l1-11"/></svg>' }
function plusIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg>' }
