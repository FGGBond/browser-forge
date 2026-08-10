import { parseGuidanceMarkdown, serializeGuidanceMarkdown } from '../guidance-format.js'
import { renderSafeMarkdown } from '../safe-markdown.js'
import { mountGuidanceEditor } from './guidance-editor.js'

const QUESTIONS = Object.freeze([
  {
    key: 'actions',
    title: '这次录制中，你完成了什么？',
    description: '按发生顺序写下关键操作、判断和你的意图。保留对生成 skill 有帮助的页面状态与限制。',
    placeholder: '例如：打开订单详情，输入订单号查询物流，并读取最新节点。'
  },
  {
    key: 'capability',
    title: '希望把这段操作变成什么能力？',
    description: '说明未来用户会提供什么，以及 browser-forge skill 应返回结果还是完成页面操作。',
    placeholder: '例如：接收订单号，返回承运商、最新物流节点和更新时间。'
  },
  {
    key: 'acceptance',
    title: '怎样证明这个 skill 可以交付？',
    description: '给出可以真实执行的验收任务、预期结果和不能破坏的约束。',
    placeholder: '例如：使用 JD123 查询，结果必须与订单详情页一致，并说明每项标准是否通过。'
  }
])

export async function renderPromptEditor({ container, recordingId, api }) {
  const prompt = await api.getPrompt(recordingId)
  const parsed = parseGuidanceMarkdown(prompt.text)
  const fields = Object.fromEntries(QUESTIONS.map(({ key }) => [key, parsed[key] ?? '']))

  container.innerHTML = `
    <section class="guidance-editor" aria-label="Skill 要求指导">
      <div class="guidance-save-error-slot" data-save-error-slot></div>
      <div class="guidance-flow" data-guidance-flow></div>
    </section>`

  const flow = container.querySelector('[data-guidance-flow]')
  const errorSlot = container.querySelector('[data-save-error-slot]')
  let stepIndex = 0
  let reviewOpen = false
  let activeEditor = null
  let timer = null
  let savePromise = null
  let editRevision = 0
  let dirty = false
  let requiresMigration = parsed.legacy
  let transitionPending = false
  let savedText = prompt.text || ''
  let destroyed = false
  let saveErrorVisible = false
  let handoffResult = null
  let handoffStatus = emptyHandoffStatus()
  let focusSequence = 0

  const invalidateHandoff = () => {
    handoffResult = null
    handoffStatus = emptyHandoffStatus()
  }

  const syncActiveEditor = () => {
    if (!activeEditor || reviewOpen) return
    const question = QUESTIONS[stepIndex]
    const value = activeEditor.getMarkdown()
    if (fields[question.key] === value) return
    fields[question.key] = value
    editRevision += 1
    dirty = true
    invalidateHandoff()
  }

  const destroyActiveEditor = () => {
    activeEditor?.destroy()
    activeEditor = null
  }

  const focusComposer = ({ force = false } = {}) => {
    const sequence = ++focusSequence
    const focus = () => {
      if (destroyed || reviewOpen || sequence !== focusSequence || !activeEditor) return
      if (!container.isConnected || container.getClientRects().length === 0) return
      const active = document.activeElement
      if (!force && active && active !== document.body && !active.matches?.('[data-toggle-analysis]')) return
      activeEditor.focus()
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focus)
    else queueMicrotask(focus)
  }

  const renderSaveError = visible => {
    saveErrorVisible = Boolean(visible)
    if (destroyed) return
    errorSlot.innerHTML = saveErrorVisible
      ? `<div class="guidance-save-error" data-save-error role="alert">
          <span>保存失败，内容仍保留在编辑器中。</span>
          <button class="button quiet" type="button" data-retry-save>重试保存</button>
          <button class="icon-button" type="button" data-dismiss-save-error aria-label="关闭保存错误">${closeIcon()}</button>
        </div>`
      : ''
  }

  const saveLoop = async () => {
    while (dirty || requiresMigration) {
      syncActiveEditor()
      const revision = editRevision
      const text = serializeGuidanceMarkdown(fields)
      try {
        await api.savePrompt(recordingId, text)
      } catch {
        renderSaveError(true)
        if (!destroyed && editRevision !== revision && timer === null) timer = setTimeout(saveNow, 500)
        return false
      }

      savedText = text
      requiresMigration = false
      syncActiveEditor()
      if (revision === editRevision && serializeGuidanceMarkdown(fields) === text) dirty = false
    }
    renderSaveError(false)
    return true
  }

  const saveNow = async () => {
    clearTimeout(timer)
    timer = null
    syncActiveEditor()
    if (!dirty && !requiresMigration) return true
    if (!savePromise) {
      savePromise = saveLoop().finally(() => {
        savePromise = null
      })
    }
    return savePromise
  }

  const scheduleSave = (key, value) => {
    fields[key] = value
    editRevision += 1
    dirty = true
    invalidateHandoff()
    clearTimeout(timer)
    timer = setTimeout(saveNow, 500)
  }

  const renderProgress = () => `
    <div class="guidance-progress" data-guidance-progress role="status" aria-live="polite" aria-atomic="true">
      <span class="guidance-progress-dot" aria-hidden="true"></span>
      <span>第 ${stepIndex + 1} / 3 个问题</span>
    </div>`

  const renderStep = ({ forceFocus = false } = {}) => {
    const question = QUESTIONS[stepIndex]
    const titleId = `guidance-question-${stepIndex + 1}`
    const descriptionId = `guidance-description-${stepIndex + 1}`
    flow.innerHTML = `
      ${renderProgress()}
      <section class="guidance-step" data-guidance-step="${stepIndex + 1}">
        <header class="guidance-question">
          <h3 id="${titleId}">${question.title}</h3>
          <p id="${descriptionId}">${question.description}</p>
        </header>
        <div class="guidance-composer" data-guidance-composer>
          <div class="guidance-editor-root" data-guidance-editor-root></div>
          <textarea class="prompt-textarea" data-prompt-textarea spellcheck="true" hidden></textarea>
          <div class="guidance-actions">
            ${stepIndex > 0 ? `<button class="button quiet" type="button" data-guidance-previous ${transitionPending ? 'disabled' : ''}>上一步</button>` : '<span aria-hidden="true"></span>'}
            <button class="button primary" type="button" data-guidance-next ${transitionPending ? 'disabled' : ''}>${stepIndex === QUESTIONS.length - 1 ? '检查并完成' : '下一步'}</button>
          </div>
        </div>
      </section>`

    const root = flow.querySelector('[data-guidance-editor-root]')
    const textarea = flow.querySelector('[data-prompt-textarea]')
    activeEditor = mountGuidanceEditor({
      root,
      textarea,
      initialMarkdown: fields[question.key],
      placeholder: question.placeholder,
      labelledBy: titleId,
      describedBy: descriptionId,
      onChange: value => scheduleSave(question.key, value)
    })
    focusComposer({ force: forceFocus })
  }

  const renderReview = () => {
    flow.innerHTML = `
      <section class="guidance-review" data-guidance-review>
        <header class="guidance-review-heading">
          <h3>检查你的 skill 要求</h3>
          <p>使用 browser-forge skill 分析录制并生成可独立运行的 skill 与 CLI 工具。</p>
        </header>
        <div class="guidance-review-list">
          ${QUESTIONS.map(question => renderReviewCard(question, fields[question.key], transitionPending)).join('')}
        </div>
      </section>
      <div class="guidance-review-footer">
        <div class="guidance-handoff-status" data-handoff-status role="status" aria-live="polite" hidden>
          <span data-handoff-message></span>
          <button class="icon-button" type="button" data-dismiss-handoff-error aria-label="关闭导出或复制错误" hidden>${closeIcon()}</button>
        </div>
        <div class="guidance-actions guidance-review-actions">
          <button class="button quiet" type="button" data-guidance-previous ${transitionPending ? 'disabled' : ''}>返回修改</button>
          <button class="button quiet" type="button" data-retry-copy hidden ${transitionPending ? 'disabled' : ''}>重试复制</button>
          <button class="button primary" type="button" data-agent-handoff ${transitionPending ? 'disabled' : ''}>${copyIcon()}<span data-handoff-label>导出并复制给外部 Agent</span></button>
        </div>
      </div>`
    renderHandoffStatus()
  }

  const renderView = ({ forceFocus = false } = {}) => {
    destroyActiveEditor()
    if (reviewOpen) renderReview()
    else renderStep({ forceFocus })
  }

  const updateTransitionButtons = () => {
    flow.querySelectorAll('[data-guidance-next], [data-guidance-previous], [data-edit-guidance], [data-agent-handoff], [data-retry-copy]').forEach(button => {
      button.disabled = transitionPending
    })
  }

  const runFlushedTransition = async transition => {
    if (transitionPending) return false
    transitionPending = true
    updateTransitionButtons()
    try {
      if (!await saveNow()) return false
      if (destroyed) return false
      transition()
      return true
    } finally {
      transitionPending = false
      updateTransitionButtons()
    }
  }

  const showStep = index => {
    if (!Number.isInteger(index) || index < 0 || index >= QUESTIONS.length) return
    syncActiveEditor()
    stepIndex = index
    reviewOpen = false
    renderView({ forceFocus: true })
  }

  function renderHandoffStatus() {
    if (destroyed || !reviewOpen) return
    const status = flow.querySelector('[data-handoff-status]')
    const message = flow.querySelector('[data-handoff-message]')
    const dismissButton = flow.querySelector('[data-dismiss-handoff-error]')
    const retryButton = flow.querySelector('[data-retry-copy]')
    const handoffLabel = flow.querySelector('[data-handoff-label]')
    const displayedMessage = handoffStatus.dismissed ? '' : handoffStatus.message
    const displaysError = Boolean(displayedMessage && handoffStatus.tone === 'error')

    if (status) {
      status.hidden = !displayedMessage
      status.dataset.tone = displayedMessage ? handoffStatus.tone : ''
      status.setAttribute('role', displaysError ? 'alert' : 'status')
      if (displaysError) status.removeAttribute('aria-live')
      else status.setAttribute('aria-live', 'polite')
    }
    if (message) message.textContent = displayedMessage
    if (dismissButton) dismissButton.hidden = !displaysError
    if (retryButton) retryButton.hidden = !handoffStatus.retry
    if (handoffLabel) handoffLabel.textContent = handoffStatus.label || '导出并复制给外部 Agent'
  }

  const setHandoffStatus = ({ message = '', tone = '', retry = false, label = '' } = {}) => {
    handoffStatus = { message, tone, retry, label, dismissed: false }
    renderHandoffStatus()
  }

  const dismissHandoffError = () => {
    if (handoffStatus.tone !== 'error') return
    handoffStatus = { ...handoffStatus, dismissed: true }
    renderHandoffStatus()
  }

  const copyHandoffText = async () => {
    if (!handoffResult) return false
    setHandoffStatus({ message: '正在复制提示词…', label: '正在复制…' })
    try {
      await copyText(handoffResult.text)
      setHandoffStatus({
        message: `已导出并复制：${handoffResult.path}`,
        tone: 'success',
        label: '已导出并复制'
      })
      return true
    } catch {
      setHandoffStatus({
        message: `录制已导出到 ${handoffResult.path}，复制失败`,
        tone: 'error',
        retry: true,
        label: '录制已导出'
      })
      return false
    }
  }

  const createAgentHandoff = async () => {
    if (transitionPending) return
    if (handoffResult) return retryCopy()
    transitionPending = true
    updateTransitionButtons()
    setHandoffStatus({ message: '正在导出录制…', label: '正在导出…' })
    try {
      if (!await saveNow()) {
        setHandoffStatus()
        return
      }
      const result = await api.createAgentHandoff(recordingId)
      if (!result) {
        setHandoffStatus()
        return
      }
      handoffResult = result
      await copyHandoffText()
    } catch (error) {
      setHandoffStatus({ message: `导出失败：${error.message}`, tone: 'error' })
    } finally {
      transitionPending = false
      updateTransitionButtons()
    }
  }

  const retryCopy = async () => {
    if (transitionPending || !handoffResult) return
    transitionPending = true
    updateTransitionButtons()
    try {
      await copyHandoffText()
    } finally {
      transitionPending = false
      updateTransitionButtons()
    }
  }

  const retrySave = async button => {
    button.disabled = true
    if (savePromise) await savePromise
    await saveNow()
    if (button.isConnected) button.disabled = false
  }

  const handleClick = event => {
    const button = event.target.closest('button')
    if (!button || !container.contains(button)) return

    if (button.matches('[data-guidance-next]')) {
      void runFlushedTransition(() => {
        if (stepIndex === QUESTIONS.length - 1) {
          reviewOpen = true
          renderView()
        } else {
          showStep(stepIndex + 1)
        }
      })
      return
    }
    if (button.matches('[data-guidance-previous]')) {
      void runFlushedTransition(() => showStep(reviewOpen ? QUESTIONS.length - 1 : stepIndex - 1))
      return
    }
    if (button.matches('[data-edit-guidance]')) {
      const index = QUESTIONS.findIndex(question => question.key === button.dataset.editGuidance)
      void runFlushedTransition(() => showStep(index))
      return
    }
    if (button.matches('[data-retry-save]')) {
      void retrySave(button)
      return
    }
    if (button.matches('[data-dismiss-save-error]')) {
      renderSaveError(false)
      return
    }
    if (button.matches('[data-agent-handoff]')) {
      void createAgentHandoff()
      return
    }
    if (button.matches('[data-retry-copy]')) {
      void retryCopy()
      return
    }
    if (button.matches('[data-dismiss-handoff-error]')) dismissHandoffError()
  }

  container.addEventListener('click', handleClick)
  renderView()

  return {
    flush: saveNow,
    beforeNavigate: saveNow,
    refresh: focusComposer,
    destroy() {
      destroyed = true
      focusSequence += 1
      clearTimeout(timer)
      container.removeEventListener('click', handleClick)
      destroyActiveEditor()
    },
    get dirty() { return dirty || requiresMigration },
    get savedText() { return savedText }
  }
}

function emptyHandoffStatus() {
  return { message: '', tone: '', retry: false, label: '', dismissed: false }
}

function renderReviewCard(question, value, disabled = false) {
  const preview = value.trim()
    ? renderSafeMarkdown(value)
    : '<p class="guidance-review-empty">待补充</p>'
  return `<article class="guidance-review-card">
    <div class="guidance-review-card-heading"><h4>${question.title}</h4><button class="button quiet" type="button" data-edit-guidance="${question.key}" ${disabled ? 'disabled' : ''}>返回修改</button></div>
    <div class="guidance-markdown-preview">${preview}</div>
  </article>`
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text)
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('浏览器拒绝访问剪贴板')
}

function copyIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="9" height="9" rx="2"/><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/></svg>' }
function closeIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8m0-8-8 8"/></svg>' }
