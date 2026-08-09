import { formatBytes } from './detail.js'
import { formatDuration } from './library.js'

export async function renderTrash({ container, api, onBack, onRestored }) {
  container.innerHTML = `
    <section class="trash-view" aria-labelledby="trash-title">
      <header class="view-header">
        <div>
          <p class="eyebrow">Recycle bin</p>
          <h1 id="trash-title">回收站</h1>
          <p class="view-subtitle">在这里恢复仍需保留的录制，或永久清理不再需要的内容。</p>
        </div>
      </header>
      <div class="trash-list" data-trash-list aria-busy="true"><div class="panel-empty">正在读取…</div></div>
    </section>`
  const list = container.querySelector('[data-trash-list]')
  try {
    const recordings = await api.listRecordings({ state: 'trashed', query: '' })
    list.innerHTML = recordings.length
      ? recordings.map(trashRow).join('')
      : '<div class="empty-list"><strong>回收站是空的</strong><span>移入回收站的录制会保留在这里，直到你永久删除。</span></div>'
    recordings.forEach(recording => bindTrashRow({
      row: list.querySelector(`[data-trash-row="${CSS.escape(recording.id)}"]`),
      recording,
      api,
      onRestored,
      onDeleted: () => renderTrash({ container, api, onBack, onRestored })
    }))
  } catch (error) {
    list.innerHTML = `<div class="inline-error" role="alert"><strong>无法读取回收站</strong><span>${escapeHtml(error.message)}</span></div>`
  } finally {
    list.setAttribute('aria-busy', 'false')
  }
}

export function renderTrashDetail({ container, recording, api, onRestored, onDeleted }) {
  container.innerHTML = trashRow(recording)
  bindTrashRow({ row: container.querySelector('[data-trash-row]'), recording, api, onRestored, onDeleted })
}

export function confirmDestructive({ recording, api, onDeleted, returnFocus }) {
  const dialog = document.createElement('dialog')
  const titleId = `delete-title-${safeDomId(recording.id)}`
  const descriptionId = `delete-description-${safeDomId(recording.id)}`
  dialog.className = 'delete-dialog'
  dialog.dataset.deleteDialog = ''
  dialog.setAttribute('aria-labelledby', titleId)
  dialog.setAttribute('aria-describedby', descriptionId)
  dialog.innerHTML = `
    <form method="dialog">
      <div class="dialog-icon">${trashIcon()}</div>
      <h2 id="${titleId}">永久删除“${escapeHtml(recording.title)}”？</h2>
      <p id="${descriptionId}">将永久删除 ${formatBytes(recording.sizeBytes)} 的视频、说明和时间轴。此操作无法撤销。</p>
      <div class="dialog-actions">
        <button class="button" value="cancel">取消</button>
        <button class="button danger" type="button" data-confirm-delete>永久删除</button>
      </div>
      <p class="dialog-error" data-dialog-error role="alert" aria-live="polite"></p>
    </form>`
  document.body.append(dialog)
  dialog.addEventListener('close', () => {
    dialog.remove()
    if (returnFocus?.isConnected) returnFocus.focus()
  })
  dialog.querySelector('[data-confirm-delete]').addEventListener('click', async event => {
    const button = event.currentTarget
    const errorNotice = dialog.querySelector('[data-dialog-error]')
    button.disabled = true
    errorNotice.textContent = ''
    try {
      await api.deleteRecording(recording.id)
      dialog.close()
      onDeleted?.()
    } catch (error) {
      button.disabled = false
      errorNotice.textContent = error.message
    }
  })
  dialog.showModal()
  return dialog
}

function bindTrashRow({ row, recording, api, onRestored, onDeleted }) {
  if (!row) return
  const restore = row.querySelector('[data-restore]')
  const remove = row.querySelector('[data-delete-permanently]')
  restore.addEventListener('click', async () => {
    restore.disabled = true
    clearRowError(row)
    try {
      const restored = await api.restoreRecording(recording.id)
      onRestored(restored)
    } catch (error) {
      restore.disabled = false
      showRowError(row, error.message)
    }
  })
  remove.addEventListener('click', () => confirmDestructive({ recording, api, onDeleted, returnFocus: remove }))
}

function trashRow(recording) {
  return `
    <article class="trash-row" data-trash-row="${escapeAttribute(recording.id)}">
      <div class="trash-poster">
        <img src="/api/recordings/${encodeURIComponent(recording.id)}/poster" alt="${escapeAttribute(recording.title)}的预览" onerror="this.hidden=true">
        <span>${windowIcon()}</span>
      </div>
      <div class="trash-row-content">
        <div class="trash-row-heading"><h2>${escapeHtml(recording.title)}</h2><p>${escapeHtml(recording.startHost || '未知网站')}</p></div>
        <dl class="trash-row-meta">
          <div><dt>录制时间</dt><dd><time datetime="${escapeAttribute(recording.createdAt)}">${formatDate(recording.createdAt)}</time></dd></div>
          <div><dt>时长</dt><dd>${formatDuration(recording.durationMs)}</dd></div>
          <div><dt>大小</dt><dd>${formatBytes(recording.sizeBytes)}</dd></div>
        </dl>
        <p class="trash-row-error" data-trash-error role="alert" aria-live="polite" hidden></p>
      </div>
      <div class="trash-actions">
        <button class="button primary" type="button" data-restore>恢复录制</button>
        <button class="button danger quiet" type="button" data-delete-permanently>永久删除</button>
      </div>
    </article>`
}

function clearRowError(row) {
  const notice = row.querySelector('[data-trash-error]')
  notice.hidden = true
  notice.textContent = ''
}
function showRowError(row, message) {
  const notice = row.querySelector('[data-trash-error]')
  notice.hidden = false
  notice.textContent = message
}
function formatDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}
function safeDomId(value) { return String(value ?? 'recording').replace(/[^a-zA-Z0-9_-]/g, '-') }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]) }
function escapeAttribute(value) { return escapeHtml(value).replace(/'/g, '&#39;') }
function windowIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M7 7h.01M10 7h.01"/></svg>' }
function trashIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 5.5h13M8 2.5h4l1 3H7l1-3ZM5.5 5.5l.8 11h7.4l.8-11M8.5 8.5v5M11.5 8.5v5"/></svg>' }
