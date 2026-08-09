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
    // UI preferences must never block the recording workspace.
  }
}

export function renderSidebar({
  container,
  recordings = [],
  route,
  selectedId,
  collapsed = false,
  locked = false,
  onNavigate,
  onNew,
  onToggle
}) {
  container.innerHTML = `
    <aside class="app-sidebar${collapsed ? ' is-collapsed' : ''}" aria-label="录制工作区导航">
      <div class="brand">
        <span class="brand-mark">${brandIcon()}</span>
        <span class="sidebar-label brand-copy"><strong>Browser Forge</strong><small>Recording workspace</small></span>
      </div>
      <button class="button primary sidebar-new${route === 'new-recording' ? ' active' : ''}" type="button" data-new-recording ${locked ? 'disabled' : ''} title="新录制">
        ${plusIcon()}<span class="sidebar-label">新录制</span>
      </button>
      <nav class="primary-nav" aria-label="录制导航">
        <button type="button" data-nav="library" class="${route === 'library' ? 'active' : ''}" ${locked ? 'disabled' : ''} title="录制仓库">
          ${libraryIcon()}<span class="sidebar-label">录制仓库</span>
        </button>
      </nav>
      <section class="sidebar-recording-section" aria-labelledby="sidebar-recordings-title">
        <div class="sidebar-section-heading sidebar-label" id="sidebar-recordings-title">最近录制</div>
        <div class="sidebar-recordings" data-sidebar-recordings>
          ${recordings.length ? recordings.map(recording => recordingItem(recording, selectedId, route, locked)).join('') : `<p class="sidebar-empty sidebar-label">完成录制后会显示在这里</p>`}
        </div>
      </section>
      <nav class="secondary-nav" aria-label="录制管理">
        <button type="button" data-nav="trash" class="${route === 'trash' ? 'active' : ''}" ${locked ? 'disabled' : ''} title="回收站">
          ${trashIcon()}<span class="sidebar-label">回收站</span>
        </button>
      </nav>
      <div class="sidebar-note"><i></i><span class="sidebar-label">录制仅保存在这台设备</span></div>
      <button class="sidebar-toggle" type="button" data-sidebar-toggle aria-label="${collapsed ? '展开侧边栏' : '收起侧边栏'}" title="${collapsed ? '展开侧边栏' : '收起侧边栏'}">
        ${collapseIcon(collapsed)}<span class="sidebar-label">收起侧边栏</span>
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

function recordingItem(recording, selectedId, route, locked) {
  const active = route === 'detail' && recording.id === selectedId
  const label = String(recording.title || '未命名录制')
  return `
    <button type="button" class="sidebar-recording${active ? ' active' : ''}" data-recording-nav="${escapeAttribute(recording.id)}" aria-current="${active ? 'page' : 'false'}" ${locked ? 'disabled' : ''} title="${escapeAttribute(label)}">
      <span class="recording-folder" data-recording-folder="${active ? 'open' : 'closed'}" aria-hidden="true">${folderIcon(active)}</span>
      <span class="sidebar-label recording-nav-copy"><strong>${escapeHtml(label)}</strong></span>
    </button>`
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}

function escapeAttribute(value) { return escapeHtml(value) }
function folderIcon(open) { return open
  ? '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 7V5.5h5l1.5 2h6.5v2"/><path d="M3 9.5h14l-1.5 6H4.5l-1.5-6Z"/></svg>'
  : '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 5.5h5l1.5 2h6.5v8h-13v-10Z"/></svg>' }
function brandIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="4"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01M8 14h8M12 11v6"/></svg>' }
function libraryIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3" width="14" height="14" rx="3"/><path d="M3 8h14M7 3v14"/></svg>' }
function trashIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 3h4l1 3H7l1-3ZM6 6l1 11h6l1-11"/></svg>' }
function plusIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg>' }
function collapseIcon(collapsed) { return `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4h12v12H4zM9 4v12M${collapsed ? '12 7l3 3-3 3' : '15 7l-3 3 3 3'}"/></svg>` }
