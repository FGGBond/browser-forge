import { mountVideoPlayer } from './video-player.js'

export async function renderDetail({
  container,
  api,
  recordingId,
  onBack,
  onTrashed,
  onRecordingUpdated = () => {},
  beforeObjectAction = async () => true
}) {
  container.innerHTML = `<section class="detail-loading"><div class="loading-ring"></div><span>正在读取录制…</span></section>`
  try {
    const recording = await api.getRecording(recordingId)
    container.innerHTML = detailMarkup(recording)
    const playable = ['complete', 'partial'].includes(recording.videoStatus)
    const playerController = playable ? mountVideoPlayer({
      container: container.querySelector('[data-video-player-slot]'),
      src: `/api/recordings/${encodeURIComponent(recording.id)}/video`,
      poster: `/api/recordings/${encodeURIComponent(recording.id)}/poster`,
      durationMs: recording.durationMs,
      title: recording.title
    }) : null
    const titleInput = container.querySelector('[data-title-input]')
    let savedTitle = recording.title
    let renaming = false

    container.querySelector('[data-back]').addEventListener('click', onBack)

    const commitTitle = async () => {
      const next = titleInput.value.trim()
      if (renaming || !next || next === savedTitle) {
        titleInput.value = savedTitle
        return
      }
      renaming = true
      titleInput.disabled = true
      try {
        const updated = await api.renameRecording(recording.id, next)
        savedTitle = updated.title
        titleInput.value = savedTitle
        onRecordingUpdated(updated)
      } catch (error) {
        titleInput.value = savedTitle
        showNotice(container, error.message, 'error')
      } finally {
        titleInput.disabled = false
        renaming = false
      }
    }
    titleInput.addEventListener('blur', commitTitle)
    titleInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); void commitTitle() }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); titleInput.value = savedTitle; titleInput.blur() }
    })

    container.querySelector('[data-export]').addEventListener('click', async event => {
      const button = event.currentTarget
      button.disabled = true
      button.classList.add('is-busy')
      try {
        if (!await beforeObjectAction()) return
        const result = await api.exportRecording(recording.id)
        showNotice(container, `已导出到 ${result.path}`, 'success')
      } catch (error) {
        if (error.code !== 'EXPORT_CANCELED') showNotice(container, error.message, 'error')
      } finally {
        button.disabled = false
        button.classList.remove('is-busy')
      }
    })
    container.querySelector('[data-trash]').addEventListener('click', async event => {
      const button = event.currentTarget
      button.disabled = true
      try {
        if (!await beforeObjectAction()) return
        const trashed = await api.trashRecording(recording.id)
        onTrashed(trashed)
      } catch (error) {
        button.disabled = false
        showNotice(container, error.message, 'error')
      }
    })

    return {
      recording,
      beforeNavigate: async () => true,
      cleanup: () => playerController?.destroy()
    }
  } catch (error) {
    container.innerHTML = `<section class="narrow-view"><button class="back-button" data-back>返回录制仓库</button><div class="inline-error"><strong>无法打开录制</strong><span>${escapeHtml(error.message)}</span></div></section>`
    container.querySelector('[data-back]').addEventListener('click', onBack)
    return null
  }
}

function detailMarkup(recording) {
  const playable = ['complete', 'partial'].includes(recording.videoStatus)
  const visitedHosts = [...new Set([recording.startHost, ...(recording.visitedHosts || [])].filter(Boolean))]
  const primaryHost = visitedHosts[0] || '未知网站'
  const domainSummary = visitedHosts.length ? visitedHosts.join(' · ') : primaryHost
  return `
    <section class="analysis-workspace" data-analysis-workspace>
      <main class="analysis-main">
        <header class="detail-header detail-titlebar" data-detail-titlebar>
          <button class="back-button detail-back" type="button" data-back aria-label="返回录制仓库" title="返回录制仓库">${backIcon()}</button>
          <input class="detail-title-input" data-title-input value="${escapeAttribute(recording.title)}" maxlength="120" aria-label="录制名称">
          <div class="detail-titlebar-meta" aria-label="录制来源和时间"><span>${escapeHtml(primaryHost)}</span><span aria-hidden="true">·</span><time>${formatDate(recording.createdAt)}</time></div>
        </header>
        <div class="notice-stack" data-notices aria-live="polite"></div>
        <div class="analysis-evidence-stage">
          <section class="analysis-video-card" aria-label="录制视频证据">
            ${playable ? '<div data-video-player-slot></div>' : videoUnavailable(recording.videoStatus)}
          </section>
          <dl class="evidence-strip" data-evidence-strip aria-label="录制证据摘要">
            <div><dt>时长</dt><dd>${formatDuration(recording.durationMs)}</dd></div>
            <div class="evidence-domains"><dt>域名</dt><dd title="${escapeAttribute(domainSummary)}">${escapeHtml(domainSummary)}</dd></div>
            <div><dt>视频</dt><dd>${videoStatusLabel(recording.videoStatus)}</dd></div>
            <div><dt>录制时间</dt><dd>${formatDate(recording.createdAt)}</dd></div>
          </dl>
          <div class="object-action-dock" data-object-actions aria-label="录制操作">
            <button class="button" type="button" data-export aria-label="导出录制">${exportIcon()}<span>导出</span></button>
            <button class="button danger quiet" type="button" data-trash aria-label="移入回收站">${trashIcon()}<span>移入回收站</span></button>
          </div>
        </div>
      </main>
    </section>`
}

function formatDuration(value) { const seconds = Math.max(0, Math.floor(Number(value || 0) / 1000)); const minutes = Math.floor(seconds / 60); const rest = seconds % 60; return `${minutes}:${String(rest).padStart(2, '0')}` }
function formatDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '时间未知' : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date) }
export function formatBytes(value) { const bytes = Number(value); if (!Number.isFinite(bytes) || bytes < 0) return '计算中'; if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`; return `${(bytes / 1024 ** 3).toFixed(1)} GB` }
function videoStatusLabel(status) { if (status === 'complete') return '视频可用'; if (status === 'partial') return '视频部分可用'; if (status === 'failed') return '视频录制失败'; return '没有可播放视频' }
function videoUnavailable(status) { return `<div class="video-unavailable">${videoOffIcon()}<strong>${status === 'failed' ? '视频录制失败' : '没有可播放视频'}</strong><span>可以保留这段录制，稍后补充分析说明或重新录制。</span></div>` }
function showNotice(container, message, tone) { const stack = container.querySelector('[data-notices]'); const notice = document.createElement('div'); notice.className = `notice ${tone}`; notice.textContent = message; stack.append(notice); setTimeout(() => notice.remove(), 5000) }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]) }
function escapeAttribute(value) { return escapeHtml(value) }
function backIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12.5 4.5-5 5 5 5"/></svg>' }
function exportIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v9m0-9L6.5 6.5M10 3l3.5 3.5M4 11v5h12v-5"/></svg>' }
function trashIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 3h4l1 3H7l1-3ZM6 6l1 11h6l1-11"/></svg>' }
function videoOffIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="14" height="12" rx="2"/><path d="m17 10 4-2v8l-4-2M4 4l16 16"/></svg>' }
