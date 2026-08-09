import { renderPromptEditor } from './prompt-editor.js'
import { mountVideoPlayer } from './video-player.js'

export async function renderDetail({
  container,
  api,
  recordingId,
  onBack,
  onTrashed,
  analysisPaneOpen = false,
  onAnalysisPaneChange = () => {}
}) {
  container.innerHTML = `<section class="detail-loading"><div class="loading-ring"></div><span>正在读取录制…</span></section>`
  try {
    const recording = await api.getRecording(recordingId)
    container.innerHTML = detailMarkup(recording, analysisPaneOpen)
    const playable = ['complete', 'partial'].includes(recording.videoStatus)
    const playerController = playable ? mountVideoPlayer({
      container: container.querySelector('[data-video-player-slot]'),
      src: `/api/recordings/${encodeURIComponent(recording.id)}/video`,
      poster: `/api/recordings/${encodeURIComponent(recording.id)}/poster`,
      durationMs: recording.durationMs,
      title: recording.title
    }) : null
    const titleInput = container.querySelector('[data-title-input]')
    const workspace = container.querySelector('[data-analysis-workspace]')
    const pane = container.querySelector('[data-analysis-pane]')
    const backdrop = container.querySelector('[data-analysis-backdrop]')
    const togglePane = container.querySelector('[data-toggle-analysis]')
    const closePane = container.querySelector('[data-close-analysis]')
    let savedTitle = recording.title
    let renaming = false

    const isPaneOpen = () => workspace.classList.contains('analysis-pane-open')
    const setPaneOpen = (open, { restoreFocus = true } = {}) => {
      const next = Boolean(open)
      workspace.classList.toggle('analysis-pane-open', next)
      pane.setAttribute('aria-hidden', String(!next))
      pane.inert = !next
      backdrop.setAttribute('aria-hidden', String(!next))
      togglePane.setAttribute('aria-expanded', String(next))
      togglePane.querySelector('span').textContent = next ? '收起分析' : '去分析'
      onAnalysisPaneChange(next)
      if (next) closePane.focus({ preventScroll: true })
      else if (restoreFocus) togglePane.focus({ preventScroll: true })
    }
    const onDocumentKeyDown = event => {
      if (event.key !== 'Escape' || !isPaneOpen()) return
      event.preventDefault()
      setPaneOpen(false)
    }

    container.querySelector('[data-back]').addEventListener('click', onBack)
    togglePane.addEventListener('click', () => setPaneOpen(!isPaneOpen()))
    closePane.addEventListener('click', () => setPaneOpen(false))
    backdrop.addEventListener('click', () => setPaneOpen(false))

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
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); titleInput.value = savedTitle; titleInput.blur() }
    })

    const promptController = await renderPromptEditor({ container: container.querySelector('[data-prompt-slot]'), recordingId: recording.id, api })
    document.addEventListener('keydown', onDocumentKeyDown)

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

    return {
      recording,
      beforeNavigate: promptController.beforeNavigate,
      cleanup: () => { document.removeEventListener('keydown', onDocumentKeyDown); playerController?.destroy(); promptController.destroy() }
    }
  } catch (error) {
    container.innerHTML = `<section class="narrow-view"><button class="back-button" data-back>返回录制仓库</button><div class="inline-error"><strong>无法打开录制</strong><span>${escapeHtml(error.message)}</span></div></section>`
    container.querySelector('[data-back]').addEventListener('click', onBack)
    return null
  }
}

function detailMarkup(recording, analysisPaneOpen) {
  const playable = ['complete', 'partial'].includes(recording.videoStatus)
  const visitedHosts = [...new Set([recording.startHost, ...(recording.visitedHosts || [])].filter(Boolean))]
  return `
    <section class="analysis-workspace${analysisPaneOpen ? ' analysis-pane-open' : ''}" data-analysis-workspace>
      <main class="analysis-main">
        <header class="detail-header">
          <div class="detail-heading">
            <button class="back-button" type="button" data-back>${backIcon()}<span>录制仓库</span></button>
            <input class="detail-title-input" data-title-input value="${escapeAttribute(recording.title)}" maxlength="120" aria-label="录制名称">
            <p><span>${escapeHtml(visitedHosts.join(' · ') || '未知网站')}</span><span>·</span><time>${formatDate(recording.createdAt)}</time></p>
          </div>
          <div class="detail-actions">
            <button class="button" type="button" data-toggle-analysis aria-expanded="${analysisPaneOpen}">${analysisIcon()}<span>${analysisPaneOpen ? '收起分析' : '去分析'}</span></button>
            <button class="button" type="button" data-export>${exportIcon()}<span>导出</span></button>
            <button class="button danger quiet" type="button" data-trash>${trashIcon()}<span>移入回收站</span></button>
          </div>
        </header>
        <div class="notice-stack" data-notices></div>
        <section class="analysis-video-card">
          ${playable ? '<div data-video-player-slot></div>' : videoUnavailable(recording.videoStatus)}
        </section>
      </main>
      <button class="analysis-backdrop" type="button" data-analysis-backdrop aria-label="关闭分析栏" aria-hidden="${!analysisPaneOpen}" tabindex="-1"></button>
      <aside class="analysis-pane" data-analysis-pane aria-hidden="${!analysisPaneOpen}" ${analysisPaneOpen ? '' : 'inert'} aria-label="分析会话">
        <header class="analysis-session-header"><div><p class="eyebrow">Analysis session</p><h2>分析会话</h2></div><button class="icon-button" type="button" data-close-analysis aria-label="关闭分析栏">${closeIcon()}</button></header>
        <section class="agent-unconfigured"><span>${sparkIcon()}</span><div><strong>Agent 尚未配置</strong><p>你仍可对照视频编辑说明，并把完整提示词复制到外部 Agent。</p></div></section>
        <section class="analysis-prompt" data-prompt-slot></section>
      </aside>
    </section>`
}

function formatDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '时间未知' : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date) }
export function formatBytes(value) { const bytes = Number(value); if (!Number.isFinite(bytes) || bytes < 0) return '计算中'; if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`; return `${(bytes / 1024 ** 3).toFixed(1)} GB` }
function videoUnavailable(status) { return `<div class="video-unavailable">${videoOffIcon()}<strong>${status === 'failed' ? '视频录制失败' : '没有可播放视频'}</strong><span>可以保留这段录制，稍后补充分析说明或重新录制。</span></div>` }
function showNotice(container, message, tone) { const stack = container.querySelector('[data-notices]'); const notice = document.createElement('div'); notice.className = `notice ${tone}`; notice.textContent = message; stack.append(notice); setTimeout(() => notice.remove(), 5000) }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]) }
function escapeAttribute(value) { return escapeHtml(value) }
function backIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12.5 4.5-5 5 5 5"/></svg>' }
function exportIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v9m0-9L6.5 6.5M10 3l3.5 3.5M4 11v5h12v-5"/></svg>' }
function trashIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 3h4l1 3H7l1-3ZM6 6l1 11h6l1-11"/></svg>' }
function analysisIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4h12v12H4zM12 4v12M7 8h2M7 11h2"/></svg>' }
function closeIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8"/></svg>' }
function sparkIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m10 2 1.4 4.6L16 8l-4.6 1.4L10 14l-1.4-4.6L4 8l4.6-1.4L10 2Z"/></svg>' }
function videoOffIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="14" height="12" rx="2"/><path d="m17 10 4-2v8l-4-2M4 4l16 16"/></svg>' }
