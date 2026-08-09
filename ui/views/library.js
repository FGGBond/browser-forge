import { mountVideoPlayer } from './video-player.js'

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
  let playerControllers = []
  let destroyed = false
  const destroyPlayers = () => {
    for (const controller of playerControllers) controller.destroy()
    playerControllers = []
  }
  const renderPlayers = recordings => {
    destroyPlayers()
    for (const recording of recordings) {
      if (!['complete', 'partial'].includes(recording.videoStatus)) continue
      const slot = list.querySelector(`[data-row-player="${CSS.escape(recording.id)}"]`)
      if (!slot) continue
      playerControllers.push(mountVideoPlayer({
        container: slot,
        src: `/api/recordings/${encodeURIComponent(recording.id)}/video`,
        poster: `/api/recordings/${encodeURIComponent(recording.id)}/poster`,
        durationMs: recording.durationMs,
        compact: true,
        title: recording.title
      }))
    }
  }
  const refresh = () => loadLibrary({ api, state, list, count, onSelect, onRendered: renderPlayers })

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
      destroyPlayers()
    }
  }
}

export async function loadLibrary({ api, state, list, count, onSelect, onRendered = () => {} }) {
  list.setAttribute('aria-busy', 'true')
  try {
    const recordings = await api.listRecordings({ state: state.value.filter, query: state.value.query })
    state.update({ recordings })
    count.textContent = `${recordings.length} 段录制`
    list.innerHTML = recordings.length ? recordings.map(recordingRow).join('') : emptyLibrary(state.value.query)
    list.querySelectorAll('[data-recording-id]').forEach(row => {
      row.addEventListener('click', event => {
        if (event.target.closest('button,input,video,[data-video-player]')) return
        onSelect(row.dataset.recordingId)
      })
      row.addEventListener('keydown', event => {
        if (event.target !== row || !['Enter', ' '].includes(event.key)) return
        event.preventDefault()
        onSelect(row.dataset.recordingId)
      })
    })
    list.querySelectorAll('[data-analyze]').forEach(button => button.addEventListener('click', () => onSelect(button.dataset.analyze)))
    onRendered(recordings)
  } catch (error) {
    count.textContent = '读取失败'
    list.innerHTML = `<div class="inline-error"><strong>无法读取录制仓库</strong><span>${escapeHtml(error.message)}</span><button class="button quiet" data-retry>重试</button></div>`
    list.querySelector('[data-retry]')?.addEventListener('click', () => loadLibrary({ api, state, list, count, onSelect, onRendered }))
  } finally {
    list.setAttribute('aria-busy', 'false')
  }
}

function recordingRow(recording) {
  const playable = ['complete', 'partial'].includes(recording.videoStatus)
  return `
    <article class="recording-row" data-recording-id="${escapeAttribute(recording.id)}" tabindex="0">
      <div class="repository-video">
        ${playable ? `<div data-row-player="${escapeAttribute(recording.id)}"></div>` : videoPlaceholder(recording.videoStatus)}
      </div>
      <div class="recording-row-content">
        <div class="recording-row-title">
          <h2>${escapeHtml(recording.title)}</h2>
          <time datetime="${escapeAttribute(recording.createdAt)}">${formatDate(recording.createdAt)}</time>
        </div>
        <div class="recording-row-actions">
          <button class="button primary" type="button" data-analyze="${escapeAttribute(recording.id)}">去分析</button>
        </div>
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
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}
function videoPlaceholder(status) {
  const failed = status === 'failed'
  return `<div class="repository-video-placeholder">${windowIcon()}<strong>${failed ? '视频录制失败' : '没有可播放视频'}</strong><span>${failed ? '录制过程未生成可播放视频。' : '这段录制暂时没有视频。'}</span></div>`
}
function emptyLibrary(query) { return `<div class="empty-list">${searchIcon()}<strong>${query ? '没有匹配的录制' : '还没有录制'}</strong><span>${query ? '试试录制名称、主站点或访问过的网站。' : '点击左上角“新录制”开始第一段浏览器操作。'}</span></div>` }
function skeletonRows(count) { return Array.from({ length: count }, () => '<div class="recording-row skeleton"><div class="repository-video"></div><div class="recording-row-content"><div><i></i><i></i></div><i></i></div></div>').join('') }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]) }
function escapeAttribute(value) { return escapeHtml(value) }
function searchIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="4.5"/><path d="m12 12 4 4"/></svg>' }
function windowIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M7 7h.01M10 7h.01"/></svg>' }
