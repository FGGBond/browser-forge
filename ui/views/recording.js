let inspectorSocket

export async function renderNewRecording({ container, api, onStarted }) {
  container.innerHTML = `
    <section class="recording-setup new-recording-view" aria-labelledby="new-recording-title">
      <div class="new-recording-hero">
        <h1 id="new-recording-title">有什么想要完成的浏览器操作？</h1>
      </div>
      <div class="new-recording-stage">
        <div class="composer-notice-stack" data-notice-stack aria-live="polite"></div>
        <div class="goal-composer">
          <label class="sr-only" for="recording-goal">录制目标</label>
          <textarea id="recording-goal" data-goal-text class="goal-textarea" rows="5" placeholder="描述你想完成的浏览器操作…"></textarea>
          <input data-chrome-path type="hidden">
          <div class="goal-composer-toolbar">
            <button class="record-start-action" type="button" data-start disabled>
              ${recordIcon()}<span>开始录制</span>
            </button>
            <button class="send-goal-action" type="button" data-send-goal aria-label="发送目标" title="发送目标" disabled>
              ${sendIcon()}
            </button>
          </div>
        </div>
      </div>
    </section>`

  const input = container.querySelector('[data-chrome-path]')
  const goalInput = container.querySelector('[data-goal-text]')
  const startButton = container.querySelector('[data-start]')
  const sendButton = container.querySelector('[data-send-goal]')
  const noticeStack = container.querySelector('[data-notice-stack]')
  const noticeTimers = new Map()
  let permission
  let permissionLoaded = false
  let chromeLoaded = false
  let busy = false
  let waitingForPermission = false
  let resumeAfterPermission = false
  let destroyed = false

  const dismissNotice = id => {
    clearTimeout(noticeTimers.get(id))
    noticeTimers.delete(id)
    noticeStack.querySelector(`[data-notice-id="${CSS.escape(id)}"]`)?.remove()
    noticeStack.classList.toggle('has-notices', noticeStack.children.length > 0)
  }

  const showNotice = ({ id = 'status', message, tone = 'neutral', action, input: noticeInput, timeout = 0 }) => {
    dismissNotice(id)
    const notice = document.createElement('div')
    notice.className = `composer-notice ${tone}`
    notice.dataset.noticeId = id
    notice.setAttribute('role', tone === 'danger' ? 'alert' : 'status')

    const icon = document.createElement('span')
    icon.className = 'composer-notice-icon'
    icon.innerHTML = tone === 'success' ? checkIcon() : tone === 'danger' ? alertIcon() : statusIcon()
    const body = document.createElement('div')
    body.className = 'composer-notice-body'
    const copy = document.createElement('p')
    copy.textContent = message
    body.append(copy)

    if (noticeInput) {
      const field = document.createElement('input')
      field.className = 'composer-notice-input'
      field.value = noticeInput.value || ''
      field.placeholder = noticeInput.placeholder || ''
      field.setAttribute('aria-label', noticeInput.label || 'Chrome 路径')
      field.addEventListener('input', () => noticeInput.onInput?.(field.value))
      body.append(field)
    }

    if (action) {
      const actionButton = document.createElement('button')
      actionButton.className = 'composer-notice-action'
      actionButton.type = 'button'
      actionButton.textContent = action.label
      actionButton.addEventListener('click', action.onClick)
      body.append(actionButton)
    }

    const close = document.createElement('button')
    close.className = 'composer-notice-close'
    close.type = 'button'
    close.setAttribute('aria-label', '关闭提示')
    close.innerHTML = closeIcon()
    close.addEventListener('click', () => dismissNotice(id))
    notice.append(icon, body, close)
    noticeStack.append(notice)
    while (noticeStack.children.length > 3) noticeStack.firstElementChild?.remove()
    noticeStack.classList.add('has-notices')

    if (timeout > 0) noticeTimers.set(id, setTimeout(() => dismissNotice(id), timeout))
    return notice
  }

  const updateActions = () => {
    const supported = permission?.supported !== false
    startButton.disabled = busy || !permissionLoaded || !chromeLoaded || !input.value.trim() || !supported
    startButton.classList.toggle('is-busy', busy)
    sendButton.disabled = busy || !goalInput.value.trim()
  }

  const setBusy = value => {
    busy = value
    updateActions()
  }

  const restartApp = async () => {
    setBusy(true)
    showNotice({ id: 'permission', message: '正在重新启动 Browser Forge…' })
    try {
      await api.restartBrowserForge()
    } catch (error) {
      showNotice({ id: 'permission', message: `无法重新启动 Browser Forge：${error.message}`, tone: 'danger' })
      setBusy(false)
    }
  }

  const showPermissionRecovery = async result => {
    permission = result
    permissionLoaded = true
    const restartRequired = result?.status === 'restart-required' || result?.restartRequired
    if (result?.supported === false || result?.status === 'unsupported') {
      resumeAfterPermission = false
      waitingForPermission = false
      showNotice({ id: 'permission', message: '当前设备不支持窗口视频录制。', tone: 'danger' })
      updateActions()
      return false
    }
    if (restartRequired) {
      waitingForPermission = false
      showNotice({
        id: 'permission',
        message: '屏幕录制权限已更新，请重新启动 Browser Forge。',
        tone: 'danger',
        action: { label: '授权后重新启动 Browser Forge', onClick: restartApp }
      })
      updateActions()
      return false
    }

    waitingForPermission = true
    try {
      await api.openScreenRecordingSettings()
      showNotice({ id: 'permission', message: '屏幕录制权限尚未开启，Browser Forge 会在你返回后自动继续。', tone: 'danger' })
    } catch (error) {
      showNotice({ id: 'permission', message: `无法打开屏幕录制设置：${error.message}`, tone: 'danger' })
    }
    updateActions()
    return false
  }

  const startRecordingSession = async () => {
    if (destroyed || busy) return false
    setBusy(true)
    showNotice({ id: 'progress', message: '正在打开录制窗口…' })
    try {
      const result = await api.startRecording({
        chromePath: input.value.trim(),
        goalText: goalInput.value.trim()
      })
      if (!result.ok) {
        if (result.code === 'SCREEN_RECORDING_PERMISSION_REQUIRED' || result.code === 'SCREEN_RECORDING_UNSUPPORTED') {
          dismissNotice('progress')
          await showPermissionRecovery(result.permission || { supported: true, status: 'not-granted', granted: false, restartRequired: false })
          return false
        }
        throw new Error(result.error || '无法开始录制')
      }
      dismissNotice('progress')
      resumeAfterPermission = false
      onStarted(result)
      return true
    } catch (error) {
      dismissNotice('progress')
      showNotice({ id: 'recording-error', message: error.message, tone: 'danger' })
      return false
    } finally {
      setBusy(false)
    }
  }

  const requestPermission = async () => {
    setBusy(true)
    showNotice({ id: 'permission', message: '正在请求屏幕录制权限…' })
    try {
      const result = await api.requestScreenRecordingPermission()
      permission = result
      permissionLoaded = true
      if (!result.granted) return await showPermissionRecovery(result)
      waitingForPermission = false
      dismissNotice('permission')
      return true
    } catch (error) {
      return await showPermissionRecovery({ supported: true, status: 'denied', granted: false, restartRequired: false, error: error.message })
    } finally {
      setBusy(false)
    }
  }

  const beginRecording = async () => {
    if (busy || destroyed) return
    resumeAfterPermission = true
    if (!permission?.granted) {
      const granted = await requestPermission()
      if (!granted) return
    }
    await startRecordingSession()
  }

  const checkPermissionOnFocus = async () => {
    if (!waitingForPermission || busy || destroyed) return
    setBusy(true)
    try {
      const result = await api.getScreenRecordingPermission()
      permission = result
      permissionLoaded = true
      if (!result.granted) {
        if (result?.status === 'restart-required' || result?.restartRequired) await showPermissionRecovery(result)
        return
      }
      waitingForPermission = false
      dismissNotice('permission')
    } catch (error) {
      showNotice({ id: 'permission', message: `权限检查失败：${error.message}`, tone: 'danger' })
      return
    } finally {
      setBusy(false)
    }
    if (resumeAfterPermission) await startRecordingSession()
  }

  goalInput.addEventListener('input', updateActions)
  sendButton.addEventListener('click', () => {
    const goal = goalInput.value.trim()
    if (!goal) return
    showNotice({ id: 'goal', message: '目标已记下，会随录制一起保存。', tone: 'success', timeout: 2400 })
  })
  startButton.addEventListener('click', beginRecording)
  window.addEventListener('focus', checkPermissionOnFocus)

  try {
    permission = await api.getScreenRecordingPermission()
    permissionLoaded = true
    if (permission.supported === false) await showPermissionRecovery(permission)
  } catch (error) {
    permissionLoaded = true
    permission = { supported: true, status: 'not-granted', granted: false, restartRequired: false }
    showNotice({ id: 'permission-check', message: `权限检查失败：${error.message}`, tone: 'danger' })
  }
  updateActions()

  try {
    const result = await api.getChromePath()
    input.value = result.path || ''
    chromeLoaded = true
    if (!input.value) {
      showNotice({
        id: 'chrome',
        message: '未找到 Chrome。',
        tone: 'danger',
        input: {
          value: '',
          placeholder: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          label: 'Chrome 路径',
          onInput: value => { input.value = value; updateActions() }
        }
      })
    }
  } catch (error) {
    chromeLoaded = true
    showNotice({ id: 'chrome', message: `无法检测 Chrome：${error.message}`, tone: 'danger' })
  }
  updateActions()

  return {
    cleanup() {
      destroyed = true
      window.removeEventListener('focus', checkPermissionOnFocus)
      for (const timer of noticeTimers.values()) clearTimeout(timer)
      noticeTimers.clear()
    }
  }
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
function recordIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M3 9h18"/></svg>' }
function sendIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15V5m0 0L6.5 8.5M10 5l3.5 3.5"/></svg>' }
function closeIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8m0-8-8 8"/></svg>' }
function checkIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5.5 10 3 3 6-6"/></svg>' }
function alertIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M10 6.5v4M10 13.5h.01"/></svg>' }
function statusIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M10 9v4M10 6.5h.01"/></svg>' }
function recordDot() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="4" fill="currentColor" stroke="none"/></svg>' }
function stopIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6" y="6" width="8" height="8" rx="1"/></svg>' }
