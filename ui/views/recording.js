let inspectorSocket

export async function renderNewRecording({ container, api, onBack, onStarted }) {
  container.innerHTML = `
    <section class="recording-setup new-recording-view">
      <button class="back-button" type="button" data-back>${backIcon()}<span>返回录制仓库</span></button>
      <div class="new-recording-hero">
        <span class="new-recording-mark">${recordIcon()}</span>
        <p class="eyebrow">New recording</p>
        <h1>有什么想要完成的浏览器操作？</h1>
        <p class="setup-lead">先写下目标，录制完成后它会成为分析说明草稿。也可以留空，直接开始录制。</p>
      </div>
      <div class="goal-composer">
        <label class="sr-only" for="recording-goal">录制目标</label>
        <textarea id="recording-goal" data-goal-text class="goal-textarea" rows="5" placeholder="例如：登录后台，查询指定订单并导出发票。录制完成后，希望 Agent 生成一个可复用的查询与导出 skill。"></textarea>
        <div class="goal-context-note">${shieldIcon()}<span>只会录制 Browser Forge 打开的 Chrome 窗口；桌面、其他 App 和个人浏览器窗口不会进入视频。</span></div>
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
            <button class="button secondary" type="button" data-reset-permission>重置并打开授权设置</button>
            <button class="button secondary" type="button" data-open-settings>打开系统设置</button>
            <button class="button primary" type="button" data-restart-app hidden>授权后重新启动 Browser Forge</button>
          </div>
        </div>
      </div>
    </section>`

  container.querySelector('[data-back]').addEventListener('click', onBack)
  const input = container.querySelector('[data-chrome-path]')
  const goalInput = container.querySelector('[data-goal-text]')
  const button = container.querySelector('[data-start]')
  const buttonLabel = container.querySelector('[data-start-label]')
  const status = container.querySelector('[data-status]')
  const permissionActions = container.querySelector('[data-permission-actions]')
  const checkPermissionButton = container.querySelector('[data-check-permission]')
  const openSettings = container.querySelector('[data-open-settings]')
  const resetPermission = container.querySelector('[data-reset-permission]')
  const restartApp = container.querySelector('[data-restart-app]')
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
    buttonLabel.textContent = granted ? '开始录制' : '允许屏幕录制'
    button.disabled = busy || !permissionLoaded || !supported || (granted && (!chromeLoaded || !input.value.trim()))
  }

  const showPermissionRecovery = result => {
    permission = result
    permissionLoaded = true
    permissionActions.hidden = false
    const restartRequired = result?.status === 'restart-required' || result?.restartRequired
    const manualAuthorizationRequired = ['manual-authorization-required', 'denied'].includes(result?.status)
    restartApp.hidden = !(restartRequired || manualAuthorizationRequired)
    resetPermission.hidden = restartRequired
    if (restartRequired) {
      setStatus('macOS 已记录 Browser Forge 的授权。请重新启动 Browser Forge，重启后会再次检查权限。', { error: true })
    } else if (result?.status === 'unsupported') {
      permissionActions.hidden = true
      setStatus('当前平台尚未提供窗口视频录制能力。', { error: true })
    } else if (manualAuthorizationRequired) {
      setStatus('macOS 无法从 App 内弹出屏幕录制授权对话框。请点击“重置并打开授权设置”，关闭再打开 Browser Forge 的开关，完成 Touch ID/密码确认后重新启动 Browser Forge。', { error: true })
    } else {
      setStatus('macOS 尚未授予当前 Browser Forge 屏幕录制权限。可以先点击“允许屏幕录制”；如果系统没有弹窗，请使用“重置并打开授权设置”。', { error: true })
    }
    updateButton()
  }

  const requestPermission = async ({ continueRecording = false } = {}) => {
    busy = true
    permissionActions.hidden = true
    setStatus('正在请求 Browser Forge 的 macOS 屏幕录制权限…')
    updateButton()
    try {
      const result = await api.requestScreenRecordingPermission()
      permission = result
      permissionLoaded = true
      if (!result.granted) {
        showPermissionRecovery(result)
        return false
      }
      setStatus(continueRecording ? '权限已允许，正在启动隔离的 Chrome 窗口…' : 'Browser Forge 屏幕录制权限已就绪。')
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
    setStatus('正在检查 Browser Forge 屏幕录制权限…')
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
      setStatus('Browser Forge 屏幕录制权限已就绪。')
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
  resetPermission.addEventListener('click', async () => {
    busy = true
    permissionActions.hidden = true
    setStatus('正在清除旧版本 Browser Forge 的屏幕录制授权…')
    updateButton()
    try {
      await api.resetScreenRecordingPermission()
      setStatus('旧授权已清除，正在打开 Browser Forge 所在位置和系统授权设置…')
      await api.revealBrowserForgeApp()
      await api.openScreenRecordingSettings()
      permission = { supported: true, status: 'manual-authorization-required', granted: false, restartRequired: false }
      permissionLoaded = true
      permissionActions.hidden = false
      resetPermission.hidden = false
      restartApp.hidden = false
      setStatus('已重置旧授权。请在系统设置中找到 Browser Forge；如果列表中没有它，请把 Finder 中已选中的 Browser Forge 拖入设置页。如果开关仍显示开启，请关闭再打开 Browser Forge 的开关。完成 Touch ID/密码确认后，返回并点击“授权后重新启动 Browser Forge”。', { error: true })
    } catch (error) {
      showPermissionRecovery({ supported: true, status: 'manual-authorization-required', granted: false, restartRequired: false })
      setStatus(`无法重置或打开屏幕录制授权设置：${error.message}`, { error: true })
    } finally {
      busy = false
      updateButton()
    }
  })

  openSettings.addEventListener('click', async () => {
    openSettings.disabled = true
    try {
      await api.openScreenRecordingSettings()
      restartApp.hidden = false
      setStatus('已打开系统设置。请找到 Browser Forge；如果开关仍显示开启，请关闭再打开，并完成 Touch ID/密码确认。然后返回并点击“授权后重新启动 Browser Forge”。')
    } catch (error) {
      setStatus(`无法打开系统设置：${error.message}`, { error: true })
    } finally {
      openSettings.disabled = false
    }
  })
  restartApp.addEventListener('click', async () => {
    restartApp.disabled = true
    setStatus('正在重新启动 Browser Forge…')
    try {
      await api.restartBrowserForge()
    } catch (error) {
      restartApp.disabled = false
      setStatus(`无法重新启动 Browser Forge：${error.message}`, { error: true })
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
      showPermissionRecovery(permission)
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
      const goalText = goalInput.value.trim()
      const result = await api.startRecording({ chromePath, goalText })
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
    <section class="live-recording" aria-labelledby="live-recording-title">
      <header class="live-header">
        <div class="live-title">
          <span class="recording-indicator"><i></i>正在录制</span>
          <h1 id="live-recording-title">在 Chrome 中完成你的操作</h1>
          <p>Browser Forge 正在记录已打开的隔离窗口。完成后停止录制即可。</p>
        </div>
        <button class="button danger large live-stop" type="button" data-stop>${stopIcon()}<span>停止录制</span></button>
      </header>
      <div class="recording-status-card" role="status">
        <span class="recording-status-icon">${recordDot()}</span>
        <div><strong>录制已开始</strong><p>保持 Browser Forge 与录制窗口开启；停止后会自动整理视频和页面信息。</p></div>
      </div>
      <section class="open-pages-card" aria-labelledby="open-pages-title">
        <div class="open-pages-heading">
          <div><p class="eyebrow">Chrome window</p><h2 id="open-pages-title">已打开页面</h2></div>
          <span data-tab-count aria-live="polite" aria-atomic="true">0 个页面</span>
        </div>
        <div class="open-pages-list" data-open-pages><div class="panel-empty">等待 Chrome 页面…</div></div>
      </section>
      <p class="live-error" data-live-error role="alert" aria-live="polite" hidden></p>
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
  const tabs = Array.isArray(summary?.tabs) ? summary.tabs : []
  const count = container.querySelector('[data-tab-count]')
  const pages = container.querySelector('[data-open-pages]')
  if (!count || !pages) return
  const signature = JSON.stringify(tabs.map(tab => [tab.targetId || '', tab.title || '', tab.url || '']))
  if (pages.dataset.summarySignature === signature) return
  pages.dataset.summarySignature = signature
  count.textContent = `${tabs.length} 个页面`
  pages.innerHTML = tabs.length
    ? tabs.map(openPageSummary).join('')
    : '<div class="panel-empty">等待 Chrome 页面…</div>'
}

function openPageSummary(tab) {
  const title = tab.title || '未命名页面'
  return `
    <article class="open-page-summary">
      <span class="favicon">${escapeHtml(title.slice(0, 1).toUpperCase())}</span>
      <div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(hostname(tab.url))}</small></div>
    </article>`
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

function hostname(url) { try { return new URL(url).hostname } catch { return '新标签页' } }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]) }
function backIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12.5 4.5-5 5 5 5"/></svg>' }
function recordIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M3 9h18"/></svg>' }
function shieldIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5 16 5v4.5c0 4-2.5 6.5-6 8-3.5-1.5-6-4-6-8V5l6-2.5Z"/><path d="m7.5 10 1.5 1.5 3.5-3.5"/></svg>' }
function recordDot() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="4" fill="currentColor" stroke="none"/></svg>' }
function stopIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6" y="6" width="8" height="8" rx="1"/></svg>' }
