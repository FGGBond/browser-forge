let inspectorSocket

export async function renderNewRecording({ container, api, onStarted }) {
  ensureRecordingStylesheet()
  container.innerHTML = `
    <section class="recording-lifecycle recording-prepare new-recording-view" aria-labelledby="new-recording-title">
      <div class="recording-stage">
        <header class="recording-stage-header">
          <span class="recording-stage-mark" aria-hidden="true">${forgeIcon()}</span>
          <div>
            <p class="recording-stage-kicker">新录制</p>
            <h1 id="new-recording-title">准备录制</h1>
            <p class="recording-stage-copy">描述这次操作的目标，随后在 Chrome 中完成流程。</p>
          </div>
        </header>

        <div class="recording-readiness" data-readiness role="status" aria-live="polite" aria-atomic="true">
          <span class="recording-readiness-icon" aria-hidden="true">${statusIcon()}</span>
          <div>
            <strong data-readiness-title>正在检查录制环境</strong>
            <p data-readiness-detail>正在检测 Chrome 和屏幕录制权限。</p>
          </div>
        </div>

        <div class="composer-notice-stack" data-notice-stack aria-live="polite"></div>

        <div class="goal-composer">
          <label class="goal-label" for="recording-goal">这次录制要完成什么？</label>
          <textarea id="recording-goal" data-goal-text class="goal-textarea" rows="3" placeholder="例如：查询订单并导出结果（可选）"></textarea>
          <input data-chrome-path type="hidden">
          <div class="goal-composer-toolbar">
            <span class="goal-helper">目标会和录制一起保存</span>
            <button class="record-start-action" type="button" data-start data-primary-action disabled>
              ${recordDot()}<span>开始录制</span>
            </button>
          </div>
        </div>
      </div>
    </section>`

  const input = container.querySelector('[data-chrome-path]')
  const goalInput = container.querySelector('[data-goal-text]')
  const startButton = container.querySelector('[data-start]')
  const noticeStack = container.querySelector('[data-notice-stack]')
  const readiness = container.querySelector('[data-readiness]')
  const readinessTitle = container.querySelector('[data-readiness-title]')
  const readinessDetail = container.querySelector('[data-readiness-detail]')
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
      if (action.primary) actionButton.dataset.primaryAction = ''
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

  const updateReadiness = () => {
    let tone = 'checking'
    let title = '正在检查录制环境'
    let detail = '正在检测 Chrome 和屏幕录制权限。'

    if (permissionLoaded && chromeLoaded) {
      if (!input.value.trim()) {
        tone = 'danger'
        title = '需要设置 Chrome'
        detail = '提供 Chrome 应用路径后才能开始录制。'
      } else if (permission?.supported === false || permission?.status === 'unsupported') {
        tone = 'danger'
        title = '当前设备不支持窗口视频录制'
        detail = '你可以关闭此提示，并使用左侧“全部录制”返回录制库。'
      } else if (permission?.granted) {
        tone = 'ready'
        title = 'Chrome 与屏幕录制权限已就绪'
        detail = '开始后请在打开的 Chrome 窗口中完成操作。'
      } else {
        tone = 'attention'
        title = '开始时需要屏幕录制权限'
        detail = 'Browser Forge 只会录制隔离的 Chrome 窗口；授权后会自动继续。'
      }
    }

    readiness.dataset.tone = tone
    readinessTitle.textContent = title
    readinessDetail.textContent = detail
  }

  const updateActions = () => {
    const supported = permission?.supported !== false
    const restartRequired = permission?.status === 'restart-required' || permission?.restartRequired
    const recoveringPermission = waitingForPermission || restartRequired
    startButton.disabled = busy || recoveringPermission || !permissionLoaded || !chromeLoaded || !input.value.trim() || !supported
    startButton.classList.toggle('is-busy', busy)
    startButton.setAttribute('aria-busy', String(busy))
    startButton.toggleAttribute('data-primary-action', supported && !recoveringPermission)
    updateReadiness()
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
        message: '屏幕录制权限已更新。重新启动 Browser Forge 后才能开始录制。',
        tone: 'danger',
        action: { label: '授权后重新启动 Browser Forge', primary: true, onClick: restartApp }
      })
      updateActions()
      return false
    }

    waitingForPermission = true
    try {
      await api.openScreenRecordingSettings()
      showNotice({ id: 'permission', message: '需要屏幕录制权限才能保存录制窗口的视频。已打开系统设置；授权后返回 Browser Forge，会自动重新检查并继续。如果暂时不录制，可使用左侧“全部录制”返回录制库。', tone: 'danger' })
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
  ensureRecordingStylesheet()
  container.innerHTML = `
    <section class="recording-lifecycle recording-active live-recording" data-recording-state="active" aria-labelledby="live-recording-title">
      <div class="recording-stage">
        <header class="recording-stage-header recording-active-header">
          <div>
            <p class="recording-stage-kicker"><span class="recording-indicator-dot" aria-hidden="true"></span>正在录制</p>
            <h1 id="live-recording-title">录制进行中</h1>
            <p class="recording-stage-copy" data-recording-copy>请在 Chrome 中完成操作，Browser Forge 会保留打开页面和录制视频。</p>
          </div>
          <div class="recording-active-controls">
            <time class="recording-elapsed" data-recording-elapsed datetime="PT0S" aria-label="录制时长">00:00</time>
            <button class="recording-primary-action recording-stop-action" type="button" data-stop data-primary-action>
              ${stopIcon()}<span>停止录制</span>
            </button>
          </div>
        </header>

        <div class="recording-active-status" role="status" aria-live="polite" aria-atomic="true">
          <span class="recording-readiness-icon" aria-hidden="true">${recordDot()}</span>
          <div>
            <strong data-recording-status-title>正在记录 Chrome 中的页面操作</strong>
            <p data-recording-status-detail>完成操作后停止录制；页面清单会保留最后一次已知状态。</p>
          </div>
        </div>

        <section class="open-pages-card recording-pages" aria-labelledby="open-pages-title">
          <div class="open-pages-heading">
            <h2 id="open-pages-title">打开的页面</h2>
            <span data-tab-count aria-live="polite" aria-atomic="true">0 个页面</span>
          </div>
          <div class="open-pages-list" data-open-pages><div class="panel-empty">等待 Chrome 页面…</div></div>
        </section>
        <p class="live-error" data-live-error role="alert" aria-live="assertive" hidden></p>
      </div>
    </section>`

  const section = container.querySelector('[data-recording-state]')
  const heading = container.querySelector('#live-recording-title')
  const copy = container.querySelector('[data-recording-copy]')
  const statusTitle = container.querySelector('[data-recording-status-title]')
  const statusDetail = container.querySelector('[data-recording-status-detail]')
  const stop = container.querySelector('[data-stop]')
  const stopLabel = stop.querySelector('span')
  const errorNotice = container.querySelector('[data-live-error]')
  const elapsed = container.querySelector('[data-recording-elapsed]')
  let finished = false
  let stopping = false
  let recordingStartedAt = epochMilliseconds(activeRecording?.startedAt) || Date.now()

  const updateElapsed = () => {
    if (stopping || finished) return
    const elapsedMs = Math.max(0, Date.now() - recordingStartedAt)
    const formattedElapsed = formatElapsedTime(elapsedMs)
    elapsed.textContent = formattedElapsed
    elapsed.dateTime = `PT${Math.floor(elapsedMs / 1000)}S`
    elapsed.setAttribute('aria-label', `录制时长 ${formattedElapsed}`)
  }
  const elapsedTimer = setInterval(updateElapsed, 1000)
  updateElapsed()

  const applyLiveSummary = summary => {
    if (stopping || finished) return
    recordingStartedAt = epochMilliseconds(summary?.startedAt) || recordingStartedAt
    updateElapsed()
    applySummary(container, summary)
  }

  const finish = result => {
    if (finished) return
    finished = true
    stopping = true
    clearInterval(elapsedTimer)
    disconnectInspector()
    onStopped(result)
  }

  const showActiveState = () => {
    section.dataset.recordingState = 'active'
    section.classList.remove('is-finalizing')
    heading.textContent = '录制进行中'
    copy.textContent = '请在 Chrome 中完成操作，Browser Forge 会保留打开页面和录制视频。'
    statusTitle.textContent = '正在记录 Chrome 中的页面操作'
    statusDetail.textContent = '完成操作后停止录制；页面清单会保留最后一次已知状态。'
    stop.disabled = false
    stop.classList.remove('is-busy')
    stop.removeAttribute('aria-busy')
    stopLabel.textContent = '停止录制'
    updateElapsed()
  }

  const showFinalizingState = () => {
    stopping = true
    section.dataset.recordingState = 'finalizing'
    section.classList.add('is-finalizing')
    heading.textContent = '正在准备回放'
    copy.textContent = '正在保存最后的页面信息和视频，完成后会自动打开录制详情。'
    statusTitle.textContent = '录制已停止，正在整理已捕获的内容'
    statusDetail.textContent = '请保持 Browser Forge 开启；现有页面清单不会再更新。'
    errorNotice.hidden = true
    errorNotice.textContent = ''
    stop.disabled = true
    stop.classList.add('is-busy')
    stop.setAttribute('aria-busy', 'true')
    stopLabel.textContent = '正在准备回放'
  }

  stop.addEventListener('click', async () => {
    if (stopping || finished) return
    showFinalizingState()
    try {
      const result = await api.stopRecording()
      if (!result.ok) throw new Error(result.error || '停止录制失败')
      finish(result)
    } catch (error) {
      if (finished) return
      stopping = false
      showActiveState()
      errorNotice.hidden = false
      errorNotice.textContent = error.message
    }
  })

  try {
    applyLiveSummary(await api.getSummary())
  } catch {}
  connectInspector(container, message => finish({ ok: true, ...message }), applyLiveSummary)
  return {
    beforeNavigate: async () => false,
    cleanup: () => {
      clearInterval(elapsedTimer)
      disconnectInspector()
    }
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

function connectInspector(container, onCompleted, onSummary) {
  disconnectInspector()
  try {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    inspectorSocket = new WebSocket(`${protocol}//${location.host}`)
    inspectorSocket.addEventListener('message', event => {
      try {
        const message = JSON.parse(event.data)
        if (message.type === 'recording-completed') onCompleted?.(message)
        else if (onSummary) onSummary(message)
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

function epochMilliseconds(value) {
  if (Number.isFinite(value)) return value
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function formatElapsedTime(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const clock = [minutes, seconds].map(value => String(value).padStart(2, '0')).join(':')
  return hours ? `${String(hours).padStart(2, '0')}:${clock}` : clock
}

function hostname(url) { try { return new URL(url).hostname } catch { return '新标签页' } }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]) }

function closeIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8m0-8-8 8"/></svg>' }
function checkIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5.5 10 3 3 6-6"/></svg>' }
function alertIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M10 6.5v4M10 13.5h.01"/></svg>' }
function statusIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M10 9v4M10 6.5h.01"/></svg>' }
function recordDot() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="4" fill="currentColor" stroke="none"/></svg>' }
function stopIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6" y="6" width="8" height="8" rx="1"/></svg>' }
function forgeIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4"/><rect x="8.5" y="8.5" width="7" height="3" rx="1.5"/><path d="M12 15v3"/><path d="M10 18h4"/></svg>' }

function ensureRecordingStylesheet() {
  const id = 'bf-new-recording-css'
  if (document.getElementById(id)) return
  const link = document.createElement('link')
  link.id = id
  link.rel = 'stylesheet'
  link.href = '/new-recording.css'
  document.head.append(link)
}
