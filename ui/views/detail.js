import { renderPromptEditor } from './prompt-editor.js'
import { formatDuration } from './library.js'

export async function renderDetail({ container, api, recordingId, onBack, onTrashed }) {
  container.innerHTML = `<section class="detail-loading"><div class="loading-ring"></div><span>正在读取录制…</span></section>`
  try {
    const [recording, timeline] = await Promise.all([api.getRecording(recordingId), api.getTimeline(recordingId)])
    container.innerHTML = detailMarkup(recording, timeline)
    const video = container.querySelector('video')
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
      if (event.key === 'Enter') { event.preventDefault(); commitTitle() }
      if (event.key === 'Escape') { event.preventDefault(); titleInput.value = savedTitle; titleInput.blur() }
    })

    if (video) {
      const updateEventAvailability = () => updateTimelineAvailability(container, video)
      video.addEventListener('loadedmetadata', updateEventAvailability)
      video.addEventListener('durationchange', updateEventAvailability)
      video.addEventListener('keydown', event => {
        if (!Number.isFinite(video.duration)) return
        if (event.key === 'ArrowLeft') { event.preventDefault(); video.currentTime = Math.max(0, video.currentTime - 5) }
        if (event.key === 'ArrowRight') { event.preventDefault(); video.currentTime = Math.min(video.duration, video.currentTime + 5) }
      })
      container.querySelectorAll('[data-event-offset]').forEach(button => button.addEventListener('click', () => {
        const event = timeline[Number(button.dataset.eventIndex)]
        if (seekToEvent(video, event)) video.focus()
      }))
      updateEventAvailability()
    }

    const promptController = await renderPromptEditor({ container: container.querySelector('[data-prompt-slot]'), recordingId: recording.id, api })

    container.querySelector('[data-export]').addEventListener('click', async event => {
      const button = event.currentTarget
      button.disabled = true
      button.classList.add('is-busy')
      try {
        if (!await promptController.flush()) return
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
        if (!await promptController.flush()) { button.disabled = false; return }
        const trashed = await api.trashRecording(recording.id)
        onTrashed(trashed)
      } catch (error) {
        button.disabled = false
        showNotice(container, error.message, 'error')
      }
    })
    return { recording, beforeNavigate: promptController.beforeNavigate, cleanup: () => promptController.destroy() }
  } catch (error) {
    container.innerHTML = `<section class="narrow-view"><button class="back-button" data-back>返回录制库</button><div class="inline-error"><strong>无法打开录制</strong><span>${escapeHtml(error.message)}</span></div></section>`
    container.querySelector('[data-back]').addEventListener('click', onBack)
    return null
  }
}

export function seekToEvent(video, event) {
  const offset = Number(event?.videoOffsetMs)
  if (!Number.isFinite(offset) || offset < 0 || !Number.isFinite(video.duration) || offset > video.duration * 1000) return false
  video.currentTime = offset / 1000
  return true
}

function updateTimelineAvailability(container, video) {
  container.querySelectorAll('[data-event-offset]').forEach(button => {
    const offset = Number(button.dataset.eventOffset)
    const valid = Number.isFinite(offset) && offset >= 0 && Number.isFinite(video.duration) && offset <= video.duration * 1000
    button.disabled = !valid
    button.title = valid ? `跳转到 ${formatOffset(offset)}` : '此事件没有可用的视频画面'
  })
}

function detailMarkup(recording, timeline) {
  const playable = ['complete', 'partial'].includes(recording.videoStatus)
  return `
    <section class="recording-detail">
      <header class="detail-header">
        <div class="detail-heading">
          <button class="back-button" type="button" data-back>${backIcon()}<span>所有录制</span></button>
          <input class="detail-title-input" data-title-input value="${escapeAttribute(recording.title)}" maxlength="120" aria-label="录制名称">
          <p><span>${escapeHtml(recording.startHost || '未知网站')}</span><span>·</span><time>${formatDate(recording.createdAt)}</time><span>·</span><span>${formatDuration(recording.durationMs)}</span></p>
        </div>
        <div class="detail-actions">
          <button class="button" type="button" data-export>${exportIcon()}<span>导出</span></button>
          <button class="button danger quiet" type="button" data-trash>${trashIcon()}<span>移入回收站</span></button>
        </div>
      </header>
      <div class="notice-stack" data-notices></div>
      <div class="detail-grid">
        <main class="detail-primary">
          <section class="video-card">
            ${playable ? `<video controls preload="metadata" tabindex="0" src="/api/recordings/${encodeURIComponent(recording.id)}/video" poster="/api/recordings/${encodeURIComponent(recording.id)}/poster"></video>` : videoUnavailable(recording.videoStatus)}
            <div class="video-caption"><span>${playable ? 'Chrome 窗口视频' : '视频不可用'}</span><small>${recording.videoStatus === 'partial' ? '视频为部分录制，时间轴超出部分不可跳转' : '使用 ← / → 前后跳转 5 秒'}</small></div>
          </section>
          <section class="timeline-card">
            <div class="section-heading"><div><p class="eyebrow">Event timeline</p><h2>关键事件</h2></div><span>${timeline.length}</span></div>
            <div class="timeline-list">${timeline.length ? timeline.map(timelineItem).join('') : '<div class="section-empty">这段录制没有关键事件。</div>'}</div>
          </section>
        </main>
        <aside class="detail-secondary">
          <section class="material-summary">
            <p class="eyebrow">Materials</p><h2>录制物料</h2>
            <dl><div><dt>视频</dt><dd>${videoStatusLabel(recording.videoStatus)}</dd></div><div><dt>网站</dt><dd>${escapeHtml(recording.startHost || '未知')}</dd></div><div><dt>时长</dt><dd>${formatDuration(recording.durationMs)}</dd></div><div><dt>大小</dt><dd>${formatBytes(recording.sizeBytes)}</dd></div></dl>
          </section>
          <section class="prompt-panel" data-prompt-slot>
            <p class="eyebrow">Agent guidance</p><h2>告诉 Agent 你想实现什么</h2><p>对照视频说明你的操作和目标，Browser Forge 会生成完整分析提示词。</p><div class="prompt-placeholder"></div>
          </section>
        </aside>
      </div>
    </section>`
}

function timelineItem(event, index) {
  const offset = Number(event.videoOffsetMs)
  const offsetValue = Number.isFinite(offset) && offset >= 0 ? String(offset) : 'invalid'
  return `<button class="timeline-event" type="button" data-event-index="${index}" data-event-offset="${offsetValue}" ${offsetValue === 'invalid' ? 'disabled' : ''}><span class="timeline-symbol">${eventIcon(event.type)}</span><span class="timeline-copy"><strong>${escapeHtml(event.label || event.selector || event.type || '事件')}</strong><small>${escapeHtml(eventDetail(event))}</small></span><time>${offsetValue === 'invalid' ? '无画面' : formatOffset(offset)}</time>${playIcon()}</button>`
}
function eventDetail(event) { return event.type === 'navigation' ? event.url || '页面导航' : event.key || event.selector || event.type || '' }
function eventIcon(type) { return type === 'click' ? '↖' : type === 'keydown' ? '↵' : type === 'navigation' ? '↗' : '•' }
function formatOffset(ms) { const seconds = Math.max(0, Number(ms) || 0) / 1000; return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` }
function formatDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '时间未知' : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date) }
export function formatBytes(value) { const bytes = Number(value); if (!Number.isFinite(bytes) || bytes < 0) return '计算中'; if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`; return `${(bytes / 1024 ** 3).toFixed(1)} GB` }
function videoStatusLabel(status) { return ({ complete: '完整', partial: '部分可用', failed: '录制失败', unavailable: '未生成' })[status] || status }
function videoUnavailable(status) { return `<div class="video-unavailable">${videoOffIcon()}<strong>${status === 'failed' ? '视频录制失败' : '没有视频'}</strong><span>HAR、事件、DOM 和其他录制物料仍然可用。</span></div>` }
function showNotice(container, message, tone) { const stack = container.querySelector('[data-notices]'); const notice = document.createElement('div'); notice.className = `notice ${tone}`; notice.textContent = message; stack.append(notice); setTimeout(() => notice.remove(), 5000) }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]) }
function escapeAttribute(value) { return escapeHtml(value).replace(/'/g, '&#39;') }
function backIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12.5 4.5-5 5 5 5"/></svg>' }
function exportIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v9m0-9L6.5 6.5M10 3l3.5 3.5M4 11v5h12v-5"/></svg>' }
function trashIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 3h4l1 3H7l1-3ZM6 6l1 11h6l1-11"/></svg>' }
function playIcon() { return '<svg class="timeline-play" viewBox="0 0 20 20" aria-hidden="true"><path d="m8 6 6 4-6 4V6Z"/></svg>' }
function videoOffIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="14" height="12" rx="2"/><path d="m17 10 4-2v8l-4-2M4 4l16 16"/></svg>' }
