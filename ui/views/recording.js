let inspectorSocket
let currentSummary

export async function renderNewRecording({ container, api, onBack, onStarted }) {
  container.innerHTML = `
    <section class="recording-setup narrow-view">
      <button class="back-button" type="button" data-back>${backIcon()}<span>返回录制库</span></button>
      <div class="setup-card">
        <div class="setup-icon">${recordIcon()}</div>
        <p class="eyebrow">New recording</p>
        <h1>录制一个清晰的浏览器流程</h1>
        <p class="setup-lead">只会录制 Browser Forge 打开的 Chrome 窗口。桌面、其他 App 和个人浏览器窗口不会进入视频。</p>
        <div class="privacy-note">${shieldIcon()}<span>操作事件会与视频时间轴自动对齐，之后可按事件提取对应画面。</span></div>
        <details class="advanced-settings">
          <summary>高级设置</summary>
          <label class="field-label" for="chrome-path">Chrome 路径</label>
          <input id="chrome-path" data-chrome-path class="text-input" placeholder="正在自动检测…" autocomplete="off">
          <p class="field-help">通常无需修改；仅在自动检测失败时手动填写。</p>
        </details>
        <div class="setup-actions">
          <button class="button primary large" type="button" data-start disabled>${recordDot()}<span data-start-label>正在检查权限…</span></button>
          <p class="form-status" data-status>正在检查 macOS 屏幕录制权限…</p>
          <div class="permission-actions" data-permission-actions hidden>
            <button class="button secondary" type="button" data-check-permission>再次检查权限</button>
            <button class="button secondary" type="button" data-open-settings>打开系统设置</button>
            <button class="button quiet" type="button" data-reveal-helper>在 Finder 中显示录制组件</button>
          </div>
        </div>
      </div>
    </section>`

  container.querySelector('[data-back]').addEventListener('click', onBack)
  const input = container.querySelector('[data-chrome-path]')
  const button = container.querySelector('[data-start]')
  const buttonLabel = container.querySelector('[data-start-label]')
  const status = container.querySelector('[data-status]')
  const permissionActions = container.querySelector('[data-permission-actions]')
  const checkPermissionButton = container.querySelector('[data-check-permission]')
  const openSettings = container.querySelector('[data-open-settings]')
  const revealHelper = container.querySelector('[data-reveal-helper]')
  let permission
  let permissionLoaded = false
  let chromeLoaded = false
  let busy = false

  const setStatus = (message, { error = false } = {}) => {
    status.textContent = message
    status.classList.toggle('error', error)
  }

  const updateButton = () => {
    const supported = permission?.supported !== false
    const granted = permission?.granted === true
    buttonLabel.textContent = granted ? '打开 Chrome 并开始录制' : '允许屏幕录制'
    button.disabled = busy || !permissionLoaded || !supported || (granted && (!chromeLoaded || !input.value.trim()))
  }

  const showPermissionRecovery = result => {
    permission = result
    permissionLoaded = true
    permissionActions.hidden = false
    if (result?.status === 'restart-required' || result?.restartRequired) {
      setStatus('macOS 已记录 Browser Forge Recorder 的授权，但需要重新启动 Browser Forge 后才能开始录制。', { error: true })
    } else if (result?.status === 'unsupported') {
      permissionActions.hidden = true
      setStatus('当前平台尚未提供窗口视频录制能力。', { error: true })
    } else {
      setStatus('macOS 未授予 Browser Forge Recorder 权限。请在“系统设置 → 隐私与安全性 → 屏幕与系统音频录制”中打开它的开关，然后返回这里再次检查。', { error: true })
    }
    updateButton()
  }

  const requestPermission = async ({ continueRecording = false } = {}) => {
    busy = true
    permissionActions.hidden = true
    setStatus('正在请求 macOS 屏幕录制权限…')
    updateButton()
    try {
      const result = await api.requestScreenRecordingPermission()
      permission = result
      permissionLoaded = true
      if (!result.granted) {
        showPermissionRecovery(result)
        return false
      }
      setStatus(continueRecording ? '权限已允许，正在启动隔离的 Chrome 窗口…' : '屏幕录制权限已就绪。')
      return true
    } catch (error) {
      showPermissionRecovery({ supported: true, status: 'denied', granted: false, restartRequired: false })
      setStatus(`权限请求失败：${error.message}`, { error: true })
      return false
    } finally {
      busy = false
      updateButton()
    }
  }

  const checkPermission = async () => {
    busy = true
    setStatus('正在检查 Browser Forge Recorder 权限…')
    updateButton()
    try {
      const result = await api.getScreenRecordingPermission()
      permission = result
      permissionLoaded = true
      if (!result.granted) {
        showPermissionRecovery(result)
        return false
      }
      permissionActions.hidden = true
      setStatus('Browser Forge Recorder 屏幕录制权限已就绪。')
      return true
    } catch (error) {
      setStatus(`权限检查失败：${error.message}`, { error: true })
      return false
    } finally {
      busy = false
      updateButton()
    }
  }

  input.addEventListener('input', updateButton)
  checkPermissionButton.addEventListener('click', checkPermission)
  openSettings.addEventListener('click', async () => {
    openSettings.disabled = true
    try {
      await api.openScreenRecordingSettings()
      setStatus('已打开系统设置。请打开 Browser Forge Recorder 的开关，然后返回这里点击“再次检查权限”。')
    } catch (error) {
      setStatus(`无法打开系统设置：${error.message}`, { error: true })
    } finally {
      openSettings.disabled = false
    }
  })
  revealHelper.addEventListener('click', async () => {
    revealHelper.disabled = true
    try {
      await api.revealScreenRecordingHelper()
      setStatus('已在 Finder 中显示 Browser Forge Recorder。可通过系统设置的“+”选择它，或将它拖入录屏授权列表。')
    } catch (error) {
      setStatus(`无法显示录制组件：${error.message}`, { error: true })
    } finally {
      revealHelper.disabled = false
    }
  })

  try {
    permission = await api.getScreenRecordingPermission()
    permissionLoaded = true
    if (permission.supported === false) {
      showPermissionRecovery(permission)
    } else if (permission.granted) {
      setStatus('屏幕录制权限已就绪，正在查找 Chrome…')
    } else {
      setStatus('开始前，macOS 会请求 Browser Forge Recorder 的屏幕录制权限；它只录制 Browser Forge 打开的 Chrome 窗口。')
    }
  } catch (error) {
    permissionLoaded = true
    permission = { supported: true, status: 'not-granted', granted: false, restartRequired: false }
    setStatus(`权限检查失败：${error.message}`, { error: true })
  }
  updateButton()

  try {
    const result = await api.getChromePath()
    input.value = result.path || ''
    chromeLoaded = true
    if (!input.value) {
      container.querySelector('details').open = true
      setStatus('未找到 Chrome，请展开高级设置填写路径。', { error: true })
    } else if (permission?.granted) {
      setStatus('Chrome 与屏幕录制权限已就绪。')
    }
  } catch (error) {
    chromeLoaded = true
    setStatus(`自动检测失败：${error.message}`, { error: true })
    container.querySelector('details').open = true
  }
  updateButton()

  button.addEventListener('click', async () => {
    busy = true
    button.classList.add('is-busy')
    permissionActions.hidden = true
    updateButton()
    try {
      if (!permission?.granted) {
        busy = false
        const granted = await requestPermission({ continueRecording: true })
        if (!granted) return
        busy = true
        updateButton()
      } else {
        setStatus('正在启动隔离的 Chrome 窗口…')
      }
      const chromePath = input.value.trim()
      const result = await api.startRecording({ chromePath })
      if (!result.ok) {
        if (result.code === 'SCREEN_RECORDING_PERMISSION_REQUIRED' || result.code === 'SCREEN_RECORDING_UNSUPPORTED') {
          showPermissionRecovery(result.permission || { supported: true, status: 'not-granted', granted: false, restartRequired: false })
          return
        }
        const error = new Error(result.error || '无法开始录制')
        error.code = result.code
        throw error
      }
      onStarted(result)
    } catch (error) {
      setStatus(error.message, { error: true })
    } finally {
      busy = false
      button.classList.remove('is-busy')
      updateButton()
    }
  })
}

export async function renderRecording({ container, api, activeRecording, onStopped, onCancel }) {
  container.innerHTML = `
    <section class="live-recording">
      <header class="live-header">
        <div class="live-title"><span class="recording-indicator"><i></i>正在录制</span><h1>在 Chrome 中完成你的操作</h1><p>窗口关闭或点击停止后，视频与事件会自动整理到录制库。</p></div>
        <button class="button danger" type="button" data-stop>${stopIcon()}<span>停止录制</span></button>
      </header>
      <div class="live-metrics" data-metrics>${metricCards(emptySummary())}</div>
      <div class="inspector-layout">
        <aside class="browser-tabs-panel"><div class="panel-heading"><span>Browser Tabs</span><small data-tab-count>0</small></div><div data-tabs class="browser-tabs"><div class="panel-empty">等待 Chrome 页面…</div></div></aside>
        <main class="inspector-panel"><div class="panel-heading"><span>实时 Inspector</span><small>事件与画面</small></div><div data-inspector class="inspector-content"><div class="panel-empty tall">开始在 Chrome 中操作，关键事件会出现在这里。</div></div></main>
      </div>
      <p class="live-error" data-live-error hidden></p>
    </section>`
  const stop = container.querySelector('[data-stop]')
  let finished = false
  const finish = result => {
    if (finished) return
    finished = true
    disconnectInspector()
    onStopped(result)
  }
  stop.addEventListener('click', async () => {
    stop.disabled = true
    stop.classList.add('is-busy')
    try {
      const result = await api.stopRecording()
      if (!result.ok) throw new Error(result.error || '停止录制失败')
      finish(result)
    } catch (error) {
      stop.disabled = false
      stop.classList.remove('is-busy')
      const notice = container.querySelector('[data-live-error]')
      notice.hidden = false
      notice.textContent = error.message
    }
  })

  try {
    applySummary(container, await api.getSummary())
  } catch {}
  connectInspector(container, message => finish({ ok: true, ...message }))
  return {
    beforeNavigate: async () => false,
    cleanup: () => disconnectInspector()
  }
}

export function applySummary(container, summary) {
  if (!container?.isConnected) return
  currentSummary = summary
  container.querySelector('[data-metrics]').innerHTML = metricCards(summary)
  const tabs = Array.isArray(summary.tabs) ? summary.tabs : []
  container.querySelector('[data-tab-count]').textContent = String(tabs.length)
  container.querySelector('[data-tabs]').innerHTML = tabs.length ? tabs.map((tab, index) => `
    <button class="browser-tab ${index === 0 ? 'active' : ''}" data-tab-index="${index}" type="button"><span class="favicon">${escapeHtml((tab.title || 'T').slice(0, 1).toUpperCase())}</span><span><strong>${escapeHtml(tab.title || 'Untitled')}</strong><small>${escapeHtml(hostname(tab.url))}</small></span><i>${tab.counts?.events || 0}</i></button>`).join('') : '<div class="panel-empty">等待 Chrome 页面…</div>'
  const renderTab = index => renderInspector(container, tabs[index])
  container.querySelectorAll('[data-tab-index]').forEach(button => button.addEventListener('click', () => {
    container.querySelectorAll('[data-tab-index]').forEach(item => item.classList.toggle('active', item === button))
    renderTab(Number(button.dataset.tabIndex))
  }))
  renderTab(0)
}

function renderInspector(container, tab) {
  const inspector = container.querySelector('[data-inspector]')
  if (!tab) {
    inspector.innerHTML = '<div class="panel-empty tall">开始在 Chrome 中操作，关键事件会出现在这里。</div>'
    return
  }
  const events = tab.recent?.events || []
  const artifacts = tab.recent?.artifacts || []
  inspector.innerHTML = `
    <section class="inspector-section"><div class="section-title"><h2>最近事件</h2><span>${events.length}</span></div><div class="event-stream">${events.length ? events.map(eventItem).join('') : '<p class="section-empty">还没有事件</p>'}</div></section>
    <section class="inspector-section"><div class="section-title"><h2>画面物料</h2><span>${artifacts.length}</span></div><div class="screenshot-grid">${artifacts.length ? artifacts.map(artifactCard).join('') : '<p class="section-empty">关键截图会显示在这里</p>'}</div></section>`
}

function eventItem(event) {
  return `<div class="event-item"><span class="event-icon">${event.type === 'click' ? '↖' : '↵'}</span><span><strong>${escapeHtml(event.type || 'event')}</strong><small>${escapeHtml(event.selector || event.key || '')}</small></span><time>${formatClock(event.timestamp)}</time></div>`
}

function artifactCard(artifact) {
  if (artifact.thumbnailUrl) return `<figure class="screenshot-card"><div class="screenshot-thumb"><img src="${escapeAttribute(artifact.thumbnailUrl)}" alt="${escapeAttribute(artifact.title || '浏览器截图')}"></div><figcaption><span>${escapeHtml(artifact.title || 'Screenshot')}</span><time>${formatClock(artifact.timestamp)}</time></figcaption></figure>`
  return `<div class="artifact-card"><strong>${escapeHtml(artifact.kind || 'Artifact')}</strong><span>${escapeHtml(artifact.title || '')}</span></div>`
}

function connectInspector(container, onCompleted) {
  disconnectInspector()
  try {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    inspectorSocket = new WebSocket(`${protocol}//${location.host}`)
    inspectorSocket.addEventListener('message', event => {
      try {
        const message = JSON.parse(event.data)
        if (message.type === 'recording-completed') onCompleted?.(message)
        else applySummary(container, message)
      } catch {}
    })
    inspectorSocket.addEventListener('error', () => {})
  } catch {}
}

function disconnectInspector() {
  inspectorSocket?.close?.()
  inspectorSocket = null
}

function metricCards(summary) {
  const totals = summary?.totals || {}
  return [
    ['事件', totals.events || 0],
    ['网络请求', totals.network || 0],
    ['Console', totals.console || 0],
    ['物料', totals.artifacts || 0]
  ].map(([label, value]) => `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`).join('')
}
function emptySummary() { return { totals: { events: 0, network: 0, console: 0, artifacts: 0 } } }
function hostname(url) { try { return new URL(url).hostname } catch { return '新标签页' } }
function formatClock(value) { const date = new Date(Number(value)); return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]) }
function escapeAttribute(value) { return escapeHtml(value).replace(/'/g, '&#39;') }
function backIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12.5 4.5-5 5 5 5"/></svg>' }
function recordIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M3 9h18"/></svg>' }
function shieldIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5 16 5v4.5c0 4-2.5 6.5-6 8-3.5-1.5-6-4-6-8V5l6-2.5Z"/><path d="m7.5 10 1.5 1.5 3.5-3.5"/></svg>' }
function recordDot() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="4" fill="currentColor" stroke="none"/></svg>' }
function stopIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6" y="6" width="8" height="8" rx="1"/></svg>' }
