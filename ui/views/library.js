import { bindPosterFallbacks } from './poster.js'

export async function renderLibrary({ container, api, state, onSelect }) {
  container.innerHTML = `
    <section class="library-view repository-view" aria-labelledby="library-title">
      <header class="view-header repository-header">
        <div>
          <h1 id="library-title">录制仓库</h1>
          <p class="view-subtitle">查看、搜索并分析保存在这台设备上的录制。</p>
        </div>
      </header>
      <div class="library-toolbar">
        <label class="search-field">
          ${searchIcon()}
          <span class="sr-only">搜索录制</span>
          <input data-search type="search" autocomplete="off" placeholder="搜索名称或网站" value="${escapeAttribute(state.value.query)}">
        </label>
        <span class="result-count" data-result-count>正在读取…</span>
      </div>
      <div class="recording-repository" data-recording-list aria-busy="true">${skeletonRows(3)}</div>
    </section>`

  const search = container.querySelector('[data-search]')
  const list = container.querySelector('[data-recording-list]')
  const count = container.querySelector('[data-result-count]')
  let searchTimer
  let destroyed = false
  const refresh = () => loadLibrary({ api, state, list, count, onSelect })

  search.addEventListener('input', () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      if (destroyed) return
      state.update({ query: search.value.trim() })
      refresh()
    }, 180)
  })
  await refresh()
  return {
    cleanup() {
      destroyed = true
      clearTimeout(searchTimer)
    }
  }
}

export async function loadLibrary({ api, state, list, count, onSelect }) {
  list.setAttribute('aria-busy', 'true')
  try {
    const filter = state.value.filter
    const query = state.value.query
    const recordings = await api.listRecordings({ state: filter, query })
    if (filter === 'active' && !query) state.update({ recordings })
    count.textContent = `${recordings.length} 段录制`
    list.innerHTML = recordings.length ? recordings.map(recordingRow).join('') : emptyLibrary(state.value.query)
    bindPosterFallbacks(list)
    list.querySelectorAll('[data-recording-id]').forEach(row => {
      row.addEventListener('click', event => {
        if (event.target.closest('button,input')) return
        onSelect(row.dataset.recordingId)
      })
      row.addEventListener('keydown', event => {
        if (event.target !== row || !['Enter', ' '].includes(event.key)) return
        event.preventDefault()
        onSelect(row.dataset.recordingId)
      })
    })
    list.querySelectorAll('[data-analyze]').forEach(button => button.addEventListener('click', () => onSelect(button.dataset.analyze)))
  } catch (error) {
    count.textContent = '读取失败'
    list.innerHTML = `<div class="inline-error" role="alert"><strong>无法读取录制仓库</strong><span>${escapeHtml(error.message)}</span><button class="button quiet" data-retry>重试</button></div>`
    list.querySelector('[data-retry]')?.addEventListener('click', () => loadLibrary({ api, state, list, count, onSelect }))
  } finally {
    list.setAttribute('aria-busy', 'false')
  }
}

function recordingRow(recording) {
  const rowId = `recording-${safeDomId(recording.id)}`
  const domains = [...new Set([recording.startHost, ...(recording.visitedHosts || [])].filter(Boolean))]
  const primaryHost = recording.startHost || domains[0] || '网站未知'
  const domainLabel = domains.length > 1 ? `${primaryHost} +${domains.length - 1}` : primaryHost
  return `
    <article class="recording-row" data-recording-id="${escapeAttribute(recording.id)}" tabindex="0" aria-labelledby="${rowId}">
      <div class="repository-preview">
        <div class="repository-preview-fallback" aria-hidden="true">${windowIcon()}</div>
        <img src="/api/recordings/${encodeURIComponent(recording.id)}/poster" alt="" data-poster>
        <span class="repository-duration">${formatDuration(recording.durationMs)}</span>
      </div>
      <div class="recording-row-content">
        <div class="recording-row-title">
          <h2 id="${rowId}">${escapeHtml(recording.title)}</h2>
          <time datetime="${escapeAttribute(recording.createdAt)}">${formatDate(recording.createdAt)}</time>
        </div>
        <ul class="recording-row-evidence" aria-label="录制证据">
          <li title="${escapeAttribute(domains.join('、') || primaryHost)}">${windowIcon()}<span>${escapeHtml(domainLabel)}</span></li>
          <li><span class="evidence-dot" data-video-status="${escapeAttribute(recording.videoStatus || 'missing')}"></span>${videoStatusLabel(recording.videoStatus)}</li>
        </ul>
      </div>
      <div class="recording-row-actions">
        <button class="button primary" type="button" data-analyze="${escapeAttribute(recording.id)}">去分析</button>
      </div>
    </article>`
}

function videoStatusLabel(status) {
  if (status === 'complete') return '完整'
  if (status === 'partial') return '部分'
  if (status === 'failed') return '失败'
  return '缺失'
}

export function formatDuration(durationMs = 0) {
  const seconds = Math.max(0, Math.round(Number(durationMs) / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function formatDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}
function emptyLibrary(query) { return `<div class="empty-list">${searchIcon()}<strong>${query ? '没有匹配的录制' : '还没有录制'}</strong><span>${query ? '试试录制名称、主站点或访问过的网站。' : '点击左上角“新录制”开始第一段浏览器操作。'}</span></div>` }
function skeletonRows(count) { return Array.from({ length: count }, () => '<div class="recording-row skeleton"><div class="repository-preview"></div><div class="recording-row-content"><div><i></i><i></i></div><i></i></div><i></i></div>').join('') }
function safeDomId(value) { return String(value ?? 'recording').replace(/[^a-zA-Z0-9_-]/g, '-') }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]) }
function escapeAttribute(value) { return escapeHtml(value) }
function searchIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="4.5"/><path d="m12 12 4 4"/></svg>' }
function windowIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M7 7h.01M10 7h.01"/></svg>' }
