import { formatBytes } from './detail.js'
import { formatDuration } from './library.js'

export async function renderTrash({ container, api, onBack, onRestored }) {
  container.innerHTML = `
    <section class="trash-view">
      <header class="view-header"><div><p class="eyebrow">Recycle bin</p><h1>回收站</h1><p class="view-subtitle">录制仍保存在 App 工作空间中。恢复后才能继续编辑说明或交给 Agent 分析。</p></div></header>
      <div class="trash-grid"><div class="trash-list" data-trash-list><div class="panel-empty">正在读取…</div></div><aside class="trash-detail" data-trash-detail><div class="detail-welcome"><h2>选择一段录制</h2><p>可恢复全部物料，或在明确确认后永久删除。</p></div></aside></div>
    </section>`
  const list = container.querySelector('[data-trash-list]')
  const detail = container.querySelector('[data-trash-detail]')
  try {
    const recordings = await api.listRecordings({ state: 'trashed', query: '' })
    list.innerHTML = recordings.length ? recordings.map(trashCard).join('') : '<div class="empty-list"><strong>回收站是空的</strong><span>移入回收站的录制会保留在这里，直到你永久删除。</span></div>'
    list.querySelectorAll('[data-trash-id]').forEach(button => button.addEventListener('click', async () => {
      const recording = await api.getRecording(button.dataset.trashId)
      renderTrashDetail({ container: detail, recording, api, onRestored, onDeleted: async () => renderTrash({ container, api, onBack, onRestored }) })
    }))
  } catch (error) {
    list.innerHTML = `<div class="inline-error"><strong>无法读取回收站</strong><span>${escapeHtml(error.message)}</span></div>`
  }
}

export function renderTrashDetail({ container, recording, api, onRestored, onDeleted }) {
  container.innerHTML = `
    <div class="trash-detail-content">
      <div class="trash-preview"><img src="/api/recordings/${encodeURIComponent(recording.id)}/poster" alt="" onerror="this.remove()"><span>${windowIcon()}</span></div>
      <p class="eyebrow">Trashed recording</p><h2>${escapeHtml(recording.title)}</h2>
      <p class="trash-meta">${escapeHtml(recording.startHost || '未知网站')} · ${formatDuration(recording.durationMs)} · ${formatBytes(recording.sizeBytes)}</p>
      <div class="trash-actions"><button class="button primary" type="button" data-restore>恢复录制</button><button class="button danger quiet" type="button" data-delete-permanently>永久删除</button></div>
      <p class="trash-hint">恢复会保留视频、提示词、时间轴和全部录制物料。</p>
    </div>`
  container.querySelector('[data-restore]').addEventListener('click', async event => {
    event.currentTarget.disabled = true
    try { const restored = await api.restoreRecording(recording.id); onRestored(restored) } catch (error) { event.currentTarget.disabled = false; showError(container, error.message) }
  })
  container.querySelector('[data-delete-permanently]').addEventListener('click', () => confirmDestructive({ recording, api, onDeleted }))
}

export function confirmDestructive({ recording, api, onDeleted }) {
  const dialog = document.createElement('dialog')
  dialog.className = 'delete-dialog'
  dialog.dataset.deleteDialog = ''
  dialog.innerHTML = `<form method="dialog"><div class="dialog-icon">${trashIcon()}</div><h2>永久删除“${escapeHtml(recording.title)}”？</h2><p>将删除 ${formatBytes(recording.sizeBytes)} 的视频、提示词和录制物料。此操作无法撤销。</p><div class="dialog-actions"><button class="button" value="cancel">取消</button><button class="button danger" type="button" data-confirm-delete>永久删除</button></div><p class="dialog-error" data-dialog-error></p></form>`
  document.body.append(dialog)
  dialog.addEventListener('close', () => dialog.remove())
  dialog.querySelector('[data-confirm-delete]').addEventListener('click', async event => {
    event.currentTarget.disabled = true
    try { await api.deleteRecording(recording.id); dialog.close(); onDeleted?.() } catch (error) { event.currentTarget.disabled = false; dialog.querySelector('[data-dialog-error]').textContent = error.message }
  })
  dialog.showModal()
  return dialog
}

function trashCard(recording) { return `<button class="trash-card" type="button" data-trash-id="${escapeAttribute(recording.id)}"><span class="trash-thumb"><img src="/api/recordings/${encodeURIComponent(recording.id)}/poster" alt="" onerror="this.remove()">${windowIcon()}</span><span><strong>${escapeHtml(recording.title)}</strong><small>${escapeHtml(recording.startHost || '未知网站')} · ${formatDuration(recording.durationMs)}</small></span>${chevronIcon()}</button>` }
function showError(container, message) { const error = document.createElement('p'); error.className = 'live-error'; error.textContent = message; container.append(error) }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]) }
function escapeAttribute(value) { return escapeHtml(value).replace(/'/g, '&#39;') }
function windowIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/></svg>' }
function trashIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 3h4l1 3H7l1-3ZM6 6l1 11h6l1-11"/></svg>' }
function chevronIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m8 5 5 5-5 5"/></svg>' }
