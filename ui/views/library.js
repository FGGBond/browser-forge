const VIDEO_LABELS = {
  complete: ['视频可用', 'success'],
  partial: ['部分视频', 'warning'],
  failed: ['视频失败', 'danger'],
  unavailable: ['无视频', 'neutral']
}

export async function renderLibrary({ container, api, state, onSelect, onNew, onTrash }) {
  container.innerHTML = `
    <section class="library-view" aria-labelledby="library-title">
      <header class="view-header">
        <div>
          <p class="eyebrow">Recording library</p>
          <h1 id="library-title">浏览器录制</h1>
          <p class="view-subtitle">回看操作、补充目标，并把录制交给 Agent 生成可复用 skill。</p>
        </div>
        <button class="button primary" type="button" data-new-recording>${plusIcon()}<span>新建录制</span></button>
      </header>
      <div class="library-toolbar">
        <label class="search-field">
          ${searchIcon()}
          <span class="sr-only">搜索录制</span>
          <input data-search type="search" autocomplete="off" placeholder="搜索名称或网站" value="${escapeAttribute(state.value.query)}">
        </label>
        <span class="result-count" data-result-count>正在读取…</span>
      </div>
      <div class="library-grid">
        <div class="recording-list" data-recording-list aria-busy="true">
          ${skeletonCards(3)}
        </div>
        <aside class="detail-welcome" aria-label="录制详情提示">
          <div class="welcome-art">${windowIcon()}</div>
          <h2>选择一段录制</h2>
          <p>在这里播放窗口视频、定位关键事件，并撰写给 Agent 的任务说明。</p>
          <button class="button quiet" type="button" data-new-recording-secondary>开始第一次录制</button>
        </aside>
      </div>
    </section>`

  const search = container.querySelector('[data-search]')
  const list = container.querySelector('[data-recording-list]')
  const count = container.querySelector('[data-result-count]')
  container.querySelectorAll('[data-new-recording], [data-new-recording-secondary]').forEach(button => button.addEventListener('click', onNew))

  let searchTimer
  search.addEventListener('input', () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      state.update({ query: search.value.trim() })
      loadLibrary({ api, state, list, count, onSelect, onTrash })
    }, 180)
  })
  await loadLibrary({ api, state, list, count, onSelect, onTrash })
}

export async function loadLibrary({ api, state, list, count, onSelect, onTrash }) {
  list.setAttribute('aria-busy', 'true')
  try {
    const recordings = await api.listRecordings({ state: state.value.filter, query: state.value.query })
    state.update({ recordings })
    count.textContent = `${recordings.length} 段录制`
    list.innerHTML = recordings.length
      ? recordings.map(recording => recordingCard(recording, onTrash)).join('')
      : emptyLibrary(state.value.query)
    list.querySelectorAll('[data-recording-id]').forEach(card => {
      card.addEventListener('click', event => {
        if (event.target.closest('[data-card-action]')) return
        onSelect(card.dataset.recordingId)
      })
      card.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect(card.dataset.recordingId)
        }
      })
    })
    list.querySelectorAll('[data-card-trash]').forEach(button => button.addEventListener('click', () => onTrash?.(button.dataset.cardTrash)))
  } catch (error) {
    count.textContent = '读取失败'
    list.innerHTML = `<div class="inline-error"><strong>无法读取录制库</strong><span>${escapeHtml(error.message)}</span><button class="button quiet" data-retry>重试</button></div>`
    list.querySelector('[data-retry]')?.addEventListener('click', () => loadLibrary({ api, state, list, count, onSelect, onTrash }))
  } finally {
    list.setAttribute('aria-busy', 'false')
  }
}

function recordingCard(recording) {
  const [videoText, tone] = VIDEO_LABELS[recording.videoStatus] || VIDEO_LABELS.unavailable
  return `
    <article class="recording-card" data-recording-id="${escapeAttribute(recording.id)}" tabindex="0">
      <div class="recording-poster ${recording.videoStatus !== 'complete' ? 'is-placeholder' : ''}">
        ${recording.videoStatus === 'complete'
          ? `<img loading="lazy" src="/api/recordings/${encodeURIComponent(recording.id)}/poster" alt="" onerror="this.closest('.recording-poster').classList.add('is-placeholder');this.remove()">`
          : ''}
        <span class="poster-placeholder">${windowIcon()}</span>
        <span class="duration-badge">${formatDuration(recording.durationMs)}</span>
      </div>
      <div class="recording-card-body">
        <div class="recording-title-row">
          <h2>${escapeHtml(recording.title)}</h2>
          <button class="icon-button subtle" type="button" data-card-action data-card-trash="${escapeAttribute(recording.id)}" aria-label="移入回收站">${trashIcon()}</button>
        </div>
        <p class="recording-meta"><span>${escapeHtml(recording.startHost || '未知网站')}</span><span aria-hidden="true">·</span><time datetime="${escapeAttribute(recording.createdAt)}">${formatDate(recording.createdAt)}</time></p>
        <div class="recording-status-row"><span class="status-pill ${tone}"><i></i>${videoText}</span><span class="prompt-state">${recording.promptStatus === 'draft' ? '已写说明' : '待写说明'}</span></div>
      </div>
    </article>`
}

export function formatDuration(durationMs = 0) {
  const seconds = Math.max(0, Math.round(Number(durationMs) / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function formatDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}

function emptyLibrary(query) {
  return `<div class="empty-list">${searchIcon()}<strong>${query ? '没有匹配的录制' : '还没有录制'}</strong><span>${query ? '试试更短的网站或名称关键词。' : '点击“新建录制”，Browser Forge 会自动管理全部物料。'}</span></div>`
}

function skeletonCards(count) {
  return Array.from({ length: count }, () => '<div class="recording-card skeleton"><div class="recording-poster"></div><div class="recording-card-body"><i></i><i></i><i></i></div></div>').join('')
}

function escapeHtml(value) { return String(value ?? '').replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]) }
function escapeAttribute(value) { return escapeHtml(value).replace(/'/g, '&#39;') }
function plusIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg>' }
function searchIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="4.5"/><path d="m12 12 4 4"/></svg>' }
function windowIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M7 7h.01M10 7h.01"/></svg>' }
function trashIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 3h4l1 3H7l1-3ZM6 6l1 11h6l1-11M9 9v5M11 9v5"/></svg>' }
