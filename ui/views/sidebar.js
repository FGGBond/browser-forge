const SIDEBAR_PREFERENCE_KEY = 'browser-forge.sidebar-collapsed'

export function readSidebarCollapsed(storage = globalThis.localStorage) {
  try {
    return storage?.getItem(SIDEBAR_PREFERENCE_KEY) === 'true'
  } catch {
    return false
  }
}

export function writeSidebarCollapsed(collapsed, storage = globalThis.localStorage) {
  try {
    storage?.setItem(SIDEBAR_PREFERENCE_KEY, collapsed ? 'true' : 'false')
  } catch {
    // UI preferences must never block navigation rendering.
  }
}

export function renderSidebar({
  container,
  recordings = [],
  route,
  selectedId,
  collapsed = false,
  analysisExpanded = false,
  locked = false,
  onNavigate,
  onNew,
  onToggle
}) {
  container.innerHTML = `
    <aside class="app-sidebar${collapsed ? ' is-collapsed' : ''}" aria-label="录制工作区导航">
      <nav class="primary-nav" aria-label="主导航">
        <button type="button" class="button sidebar-new${route === 'new-recording' ? ' active' : ''}" data-new-recording ${locked ? 'disabled' : ''} title="新录制">
          ${composeIcon()}<span class="sidebar-label">新录制</span>
        </button>
      </nav>
      <section class="sidebar-recording-section" aria-labelledby="sidebar-recordings-title">
        <div class="sidebar-section-heading sidebar-label" id="sidebar-recordings-title">录制仓库</div>
        <button type="button" data-nav="library" class="sidebar-recording sidebar-library-entry${route === 'library' ? ' active' : ''}" ${locked ? 'disabled' : ''} title="全部录制" aria-current="${route === 'library' ? 'page' : 'false'}">
          ${libraryIcon()}<span class="recording-nav-copy sidebar-label"><strong>全部录制</strong></span>
        </button>
        <div class="sidebar-recordings" data-sidebar-recordings>
          ${recordings.length ? recordings.map(recording => recordingItem(recording, selectedId, route, locked, analysisExpanded)).join('') : `<p class="sidebar-empty sidebar-label">完成录制后会显示在这里</p>`}
        </div>
      </section>
      <nav class="secondary-nav" aria-label="录制管理">
        <button type="button" data-nav="trash" class="${route === 'trash' ? 'active' : ''}" ${locked ? 'disabled' : ''} title="回收站">
          ${trashIcon()}<span class="sidebar-label">回收站</span>
        </button>
      </nav>
      <button class="sidebar-toggle" type="button" data-sidebar-toggle aria-label="${collapsed ? '显示侧边栏' : '收起侧边栏'}" title="${collapsed ? '显示侧边栏' : '收起侧边栏'}">
        ${collapseIcon(collapsed)}<span class="sidebar-label sr-only">${collapsed ? '显示侧边栏' : '收起侧边栏'}</span>
      </button>
    </aside>`

  container.querySelector('[data-new-recording]')?.addEventListener('click', onNew)
  container.querySelectorAll('[data-nav]').forEach(button => {
    button.addEventListener('click', () => onNavigate(button.dataset.nav))
  })
  container.querySelectorAll('[data-recording-nav]').forEach(button => {
    button.addEventListener('click', () => onNavigate('detail', button.dataset.recordingNav))
  })
  container.querySelector('[data-sidebar-toggle]')?.addEventListener('click', onToggle)

  return () => { container.replaceChildren() }
}

function recordingItem(recording, selectedId, route, locked, analysisExpanded = false) {
  const active = route === 'detail' && recording.id === selectedId
  const label = String(recording.title || '未命名录制')
  const bubble = analysisExpanded && active
    ? `<span class="sidebar-recording-chat" data-recording-chat="${escapeAttribute(recording.id)}" aria-hidden="true">${chatBubbleIcon()}</span>`
    : ''
  return `
    <button type="button" class="sidebar-recording${active ? ' active' : ''}${bubble ? ' has-chat' : ''}" data-recording-nav="${escapeAttribute(recording.id)}" aria-current="${active ? 'page' : 'false'}" ${locked ? 'disabled' : ''} title="${escapeAttribute(label)}">
      <span class="recording-folder" data-recording-folder="${active ? 'open' : 'closed'}" aria-hidden="true">${folderIcon(active)}</span>
      <span class="sidebar-label recording-nav-copy"><strong>${escapeHtml(label)}</strong></span>
      ${bubble}
    </button>`
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}

function escapeAttribute(value) { return escapeHtml(value) }
function chatBubbleIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h12v9H8l-3.2 2.6A.75.75 0 0 1 3.5 16V5.5Z"/></svg>' }
function folderIcon(open) { return open
  ? '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 7V5.5h5l1.5 2h6.5v2"/><path d="M3 9.5h14l-1.5 6H4.5l-1.5-6Z"/></svg>'
  : '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 5.5h5l1.5 2h6.5v8h-13v-10Z"/></svg>' }
function libraryIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3" width="14" height="14" rx="3"/><path d="M3 8h14M7 3v14"/></svg>' }
function trashIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 3h4l1 3H7l1-3ZM6 6l1 11h6l1-11"/></svg>' }
function composeIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M11.5 4.5 15 8l-7.4 7.4-3.9.4.4-3.9 7.4-7.4ZM13 6l1.5-1.5a1.4 1.4 0 0 1 2 2L15 8"/></svg>' }
function collapseIcon(collapsed) { return `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4h12v12H4zM9 4v12M${collapsed ? '12 7l3 3-3 3' : '15 7l-3 3 3 3'}"/></svg>` }
