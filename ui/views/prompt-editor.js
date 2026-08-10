import { parseGuidanceMarkdown, serializeGuidanceMarkdown } from '../guidance-format.js'
import { renderSafeMarkdown } from '../safe-markdown.js'
import { mountGuidanceEditor } from './guidance-editor.js'

const QUESTIONS = Object.freeze([
  {
    key: 'actions',
    title: '这次录制中，你完成了什么？',
    description: '按发生顺序写下关键操作、判断和你的意图。保留对生成 skill 有帮助的页面状态与限制。',
    placeholder: '例如，打开订单详情，输入订单号查询物流，并读取最新节点。'
  },
  {
    key: 'capability',
    title: '希望把这段操作变成什么能力？',
    description: '说明未来用户会提供什么，以及 browser-forge skill 应返回结果还是完成页面操作。',
    placeholder: '例如，接收订单号，返回承运商、最新物流节点和更新时间。'
  },
  {
    key: 'acceptance',
    title: '怎样证明这个 skill 可以交付？',
    description: '给出可以真实执行的验收任务、预期结果和不能破坏的约束。',
    placeholder: '例如，使用 JD123 查询，结果必须与订单详情页一致，并说明每项标准是否通过。'
  }
])

const signalComposerEngagement = () => window.signalComposerEngagement?.()

export async function renderPromptEditor({ container, recordingId, api }) {
  const prompt = await api.getPrompt(recordingId)
  const parsed = parseGuidanceMarkdown(prompt.text)
  const fields = Object.fromEntries(QUESTIONS.map(({ key }) => [key, parsed[key] ?? '']))

  container.innerHTML = `
    <section class="guidance-editor" aria-label="Skill 要求指导">
      <div class="guidance-save-error-slot" data-save-error-slot></div>
      <div class="guidance-flow" data-guidance-flow>
        <div class="guidance-chat-scroll" data-guidance-chat-scroll>
          <ol class="guidance-chat-list" data-guidance-chat-list></ol>
          <div class="guidance-current-question" data-guidance-current-question role="group" aria-live="polite">
            <h3 data-guidance-question-title id="guidance-active-title"></h3>
            <p data-guidance-question-description id="guidance-active-description"></p>
          </div>
        </div>
        <div class="guidance-chat-dock" data-guidance-chat-dock>
          <div class="guidance-dock" data-guidance-dock>
            <div class="guidance-composer" data-guidance-composer data-guidance-step="1">
              <div class="guidance-progress" data-guidance-progress role="status" aria-live="polite" aria-atomic="true">
                <span class="guidance-progress-dot" aria-hidden="true"></span>
                <span data-guidance-progress-text>第 1 / 3 个问题</span>
              </div>
              <div class="guidance-handoff-card" data-handoff-card hidden></div>
              <div class="guidance-editor-root" data-guidance-editor-root></div>
              <textarea class="prompt-textarea" data-prompt-textarea spellcheck="true" hidden></textarea>
              <div class="guidance-composer-footer">
                <button class="guidance-send" type="button" data-guidance-send data-guidance-next aria-label="发送答案" disabled>
                  ${sendIcon()}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>`

  const flow = container.querySelector('[data-guidance-flow]')
  const chatList = flow.querySelector('[data-guidance-chat-list]')
  const chatScroll = flow.querySelector('[data-guidance-chat-scroll]')
  const dock = flow.querySelector('[data-guidance-dock]')
  const currentQuestion = flow.querySelector('[data-guidance-current-question]')
  const handoffCard = flow.querySelector('[data-handoff-card]')
  const progressText = flow.querySelector('[data-guidance-progress-text]')
  const questionTitle = flow.querySelector('[data-guidance-question-title]')
  const questionDescription = flow.querySelector('[data-guidance-question-description]')
  const composer = flow.querySelector('[data-guidance-composer]')
  const sendButton = flow.querySelector('[data-guidance-send]')
  const errorSlot = container.querySelector('[data-save-error-slot]')

  let stepIndex = 0
  const submitted = [false, false, false]
  let done = false
  let editingSubmittedKey = null
  let activeEditor = null
  let timer = null
  let savePromise = null
  let editRevision = 0
  let dirty = false
  let requiresMigration = parsed.legacy
  let transitionPending = false
  let savedText = prompt.text || ''
  let promptUpdatedAt = prompt.updatedAt || null
  let destroyed = false
  let handoffResult = null
  let handoffStatus = emptyHandoffStatus()
  let focusSequence = 0

  const referenceIndex = () => stepIndex

  const invalidateHandoff = () => {
    handoffResult = null
    handoffStatus = emptyHandoffStatus()
  }

  const syncActiveEditor = () => {
    if (!activeEditor) return
    const question = QUESTIONS[referenceIndex()]
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

  const chatIsNearBottom = () => {
    const remaining = chatScroll.scrollHeight - chatScroll.clientHeight - chatScroll.scrollTop
    return remaining < 48
  }

  const scrollChatToEnd = () => {
    if (!chatScroll.isConnected) return
    if (chatIsNearBottom()) chatScroll.scrollTop = chatScroll.scrollHeight
  }

  const focusComposer = ({ force = false } = {}) => {
    const sequence = ++focusSequence
    const focus = () => {
      if (destroyed || done || sequence !== focusSequence || !activeEditor) return
      if (!container.isConnected || container.getClientRects().length === 0) return
      const active = document.activeElement
      if (!force && active && active !== document.body && !active.matches?.('[data-toggle-analysis]')) return
      activeEditor.focus()
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focus)
    else queueMicrotask(focus)
  }

  const renderSaveError = visible => {
    if (destroyed) return
    errorSlot.innerHTML = visible
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
      promptUpdatedAt = new Date().toISOString()
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
    refreshSendState()
    clearTimeout(timer)
    timer = setTimeout(saveNow, 500)
  }

  const renderChatList = () => {
    const items = []
    QUESTIONS.forEach((question, index) => {
      if (!submitted[index]) return
      const questionLabel = `<p class="guidance-chat-question">${escapeHtml(question.title)}<small>${escapeHtml(question.description)}</small></p>`
      if (editingSubmittedKey === question.key) {
        // 编辑态:气泡原地变成宽编辑卡,挂载点由 mountChatEditor 填充
        items.push(`
          <li class="guidance-chat-item editing" data-chat-item="${question.key}" data-chat-editing="${question.key}">
            ${questionLabel}
            <div class="guidance-chat-edit">
              <div class="guidance-chat-edit-root" data-chat-edit-root></div>
              <div class="guidance-chat-edit-actions">
                <button class="button quiet" type="button" data-chat-edit-cancel="${question.key}">取消</button>
                <button class="button primary" type="button" data-chat-edit-send="${question.key}">发送</button>
              </div>
            </div>
          </li>`)
        return
      }
      items.push(`
        <li class="guidance-chat-item" data-chat-item="${question.key}">
          ${questionLabel}
          <div class="guidance-chat-answer">
            <div class="guidance-chat-bubble">
              <div class="guidance-chat-text">${renderSafeMarkdown(fields[question.key])}</div>
            </div>
            <div class="guidance-chat-meta">
              <time datetime="${escapeAttribute(promptUpdatedAt || '')}">${escapeHtml(formatChatTime(promptUpdatedAt))}</time>
              <button class="icon-button guidance-copy" type="button" data-copy-answer="${question.key}" aria-label="复制: ${escapeAttribute(question.title)}" title="复制回答">${copyIcon()}</button>
              <button class="icon-button guidance-edit" type="button" data-edit-answer="${question.key}" data-edit-guidance="${question.key}" aria-label="编辑: ${escapeAttribute(question.title)}" title="编辑回答">${pencilIcon()}</button>
            </div>
          </div>
        </li>`)
    })
    const html = items.join('')
    if (chatList.innerHTML !== html) chatList.innerHTML = html
    scrollChatToEnd()
  }

  // 「检查并完成」点击时只标记最后一题;只有三题全部答完才真正进入完成态
  const allSubmitted = () => submitted.every(Boolean)

  const completeFlow = () => {
    done = true
    stepIndex = QUESTIONS.length - 1
    editingSubmittedKey = null
    destroyActiveEditor()
    renderChatList()
    updateProgress()
    refreshSendState()
    applyCompletionLayout()
    // 不要在无内容变化时清掉已完成的 handoff;真正内容变化会经由 syncActiveEditor/scheduleSave 清掉
  }

  // 完成态:handoff 卡吸附在 composer 顶部并完全遮罩它;composer 禁用交互
  const composerEditorRoot = composer.querySelector('[data-guidance-editor-root]')
  const composerFooter = composer.querySelector('.guidance-composer-footer')

  // 完成态锁定 composer;铅笔编辑进行中也视为可交互
  const syncComposerInteractivity = () => {
    const locked = done && editingSubmittedKey === null
    composer.classList.toggle('guidance-composer-done', locked)
    composer.setAttribute('aria-disabled', locked ? 'true' : 'false')
    if (currentQuestion) currentQuestion.hidden = done
    if (composerEditorRoot) composerEditorRoot.hidden = locked
    if (composerFooter) composerFooter.hidden = locked
  }

  const applyCompletionLayout = () => {
    syncComposerInteractivity()
    const surface = composer.querySelector('[data-guidance-editor-surface]')
    if (surface) surface.contentEditable = done ? 'false' : 'true'
    renderHandoffCard()
  }

  const refreshSendState = () => {
    if (!activeEditor || done) {
      sendButton.disabled = true
      return
    }
    sendButton.disabled = transitionPending
  }

  const updateProgress = () => {
    const current = referenceIndex()
    const progress = flow.querySelector('[data-guidance-progress]')
    if (progress) progress.hidden = done
    progressText.textContent = done ? '已完成 3 / 3 个问题' : `第 ${current + 1} / 3 个问题`
    // 完成态碎片:从完成态进入铅笔编辑时先解除 composer 遮罩、隐藏吸附 handoff 卡
    if (composer.classList.contains('guidance-composer-done') && !done) applyCompletionLayout()
    const editing = editingSubmittedKey !== null
    const isLast = current === QUESTIONS.length - 1 && !editing
    const sendLabel = editing ? '保存修改' : isLast ? '检查并完成' : '发送答案'
    sendButton.setAttribute('aria-label', sendLabel)
    sendButton.dataset.mode = editing ? 'edit' : isLast ? 'complete' : 'send'
  }

  const mountQuestionEditor = () => {
    const question = QUESTIONS[referenceIndex()]
    composer.setAttribute('data-guidance-step', String(referenceIndex() + 1))
    questionTitle.textContent = question.title
    questionTitle.id = `guidance-active-title-${question.key}`
    questionDescription.textContent = question.description
    questionDescription.id = `guidance-active-description-${question.key}`
    const root = composer.querySelector('[data-guidance-editor-root]')
    const textarea = composer.querySelector('[data-prompt-textarea]')
    destroyActiveEditor()
    root.innerHTML = ''
    textarea.value = ''
    activeEditor = mountGuidanceEditor({
      root,
      textarea,
      initialMarkdown: fields[question.key],
      placeholder: question.placeholder,
      labelledBy: questionTitle.id,
      describedBy: questionDescription.id,
      onChange: value => {
        // 通知 app.js:用户在 composer 输入,阻止左侧栏被 auto revert 唤起
        signalComposerEngagement()
        scheduleSave(question.key, value)
      },
      onSubmit: () => { void handleSend() }
    })
    updateProgress()
    refreshSendState()
  }

  // 铅笔编辑:在 chat 项原位挂载编辑器(pre-filled 原文)
  // 句柄随 DOM 重建自动销毁(表面 remove 后 editor.destroy 由 close 管理),发送前从存活 DOM 读取内容
  const mountChatEditor = () => {
    const root = chatList.querySelector('[data-chat-edit-root]')
    if (!root) return null
    const question = QUESTIONS.find(item => item.key === editingSubmittedKey)
    return mountGuidanceEditor({
      root,
      initialMarkdown: fields[question.key],
      placeholder: question.placeholder,
      onChange: value => scheduleSave(question.key, value),
      onSubmit: () => { void handleChatEditSend() }
    })
  }

  const focusChatEditor = root => {
    if (!root) return
    const sequence = ++focusSequence
    const focus = () => {
      if (destroyed || sequence !== focusSequence) return
      const surface = root.querySelector('[data-guidance-editor-surface], textarea')
      if (surface?.isConnected) surface.focus()
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focus)
    else queueMicrotask(focus)
  }

  const startEdit = key => {
    if (transitionPending) return
    // 通知 app.js:用户主动进入编辑,阻止左侧栏被 auto revert 唤起
    signalComposerEngagement()
    // 从完成态进入铅笔编辑:解除 done;同步 composer 题目且重置输入,避免最后一题答案"遗留在" composer
    if (done) {
      done = false
      const keyIndex = QUESTIONS.findIndex(question => question.key === key)
      if (keyIndex >= 0) stepIndex = keyIndex
      // 重置 composer 输入,否则它会展示最后一题的答案
      const root = composer.querySelector('[data-guidance-editor-root]')
      if (root) root.innerHTML = ''
    }
    editingSubmittedKey = key
    renderChatList()
    const editor = mountChatEditor()
    const root = chatList.querySelector('[data-chat-edit-root]')
    if (editor) focusChatEditor(root)
    updateProgress()
    syncComposerInteractivity()
  }

  const cancelEdit = key => {
    if (transitionPending || editingSubmittedKey !== key) return
    // scheduleSave 已随输入把草稿写进 fields;放弃时恢复成本次编辑开始时的值,避免把未确认的改动落库
    const savedFields = parseGuidanceMarkdown(savedText)
    const restored = savedFields[key] ?? ''
    if (fields[key] !== restored) {
      fields[key] = restored
      editRevision += 1
      dirty = true
      invalidateHandoff()
      clearTimeout(timer)
      timer = setTimeout(saveNow, 500)
    }
    editingSubmittedKey = null
    renderChatList()
    updateProgress()
    refreshSendState()
    if (!done && !activeEditor && !destroyed) mountQuestionEditor()
    focusComposer()
    syncComposerInteractivity()
}

  const handleChatEditSend = async () => {
    if (transitionPending || editingSubmittedKey === null) return
    const key = editingSubmittedKey
    const editorRoot = chatList.querySelector('[data-chat-edit-root]')
    if (!editorRoot) return
    const surface = editorRoot.querySelector('[data-guidance-editor-surface]')
    const textarea = editorRoot.querySelector('textarea[data-prompt-textarea]')
    // 从存活 DOM 读当前内容(onChange 已同步到 fields 的更常见,但 IME/边界场景兜底)
    const domValue = surface
      ? lastSubmittedMarkdown(editorRoot)
      : textarea?.value ?? null
    if (domValue !== null && domValue !== fields[key]) {
      fields[key] = domValue
      editRevision += 1
      dirty = true
      invalidateHandoff()
    }
    transitionPending = true
    refreshSendState()
    try {
      // saveNow→syncActiveEditor 只同步 composer,不会回读气泡;直接把最新 fields 落库
      clearTimeout(timer)
      timer = null
      if (!await saveNow()) return
      if (destroyed) return
      editingSubmittedKey = null
      const nextIndex = submitted.findIndex(flag => !flag)
      if (nextIndex === -1 && allSubmitted()) {
        completeFlow()
        return
      }
      if (nextIndex !== -1) stepIndex = nextIndex
      renderChatList()
      if (!activeEditor) mountQuestionEditor()
      updateProgress()
      refreshSendState()
      focusComposer()
    } finally {
      transitionPending = false
      refreshSendState()
      if (done) refreshHandoffButtons()
    }
    syncComposerInteractivity()
}

  const copyAnswer = async button => {
    const key = button.dataset.copyAnswer
    const text = fields[key]
    if (typeof text !== 'string' || !text) return
    try {
      await copyText(text)
      button.classList.add('copied')
      setTimeout(() => button.classList.remove('copied'), 1200)
    } catch {
      // 复制失败保持静默,避免与保存错误争夺提示面
    }
  }

  const renderHandoffCard = () => {
    if (!done) {
      handoffCard.hidden = true
      handoffCard.innerHTML = ''
      return
    }
    handoffCard.hidden = false
    const displayedMessage = handoffStatus.dismissed ? '' : handoffStatus.message
    const dismissable = Boolean(displayedMessage && handoffStatus.tone === 'error')
    handoffCard.innerHTML = `
      <div class="guidance-handoff-copy">
        <strong>三个问题都已完成</strong>
        <p>导出录制并复制给外部 Agent 的提示词，你的 Agent 会读取导出的录制并产出 skill。</p>
      </div>
      <div class="guidance-handoff-status" data-handoff-status role="${handoffStatus.tone === 'error' && displayedMessage ? 'alert' : 'status'}" ${displayedMessage ? '' : 'hidden'}>
        <span data-handoff-message>${displayedMessage}</span>
        <button class="icon-button" type="button" data-dismiss-handoff-error aria-label="关闭导出或复制错误" ${dismissable ? '' : 'hidden'}>${closeIcon()}</button>
      </div>
      <div class="guidance-handoff-actions">
        <button class="button quiet" type="button" data-retry-copy ${handoffStatus.retry ? '' : 'hidden'} ${transitionPending ? 'disabled' : ''}>重试复制</button>
        <button class="button primary" type="button" data-agent-handoff ${transitionPending ? 'disabled' : ''}>${copyIcon()}<span data-handoff-label>${handoffStatus.label || '导出并复制给外部 Agent'}</span></button>
      </div>`
  }

  const renderHandoffCardStatus = () => {
    if (!done) return
    renderHandoffCard()
  }

  const setHandoffStatus = ({ message = '', tone = '', retry = false, label = '' } = {}) => {
    handoffStatus = { message, tone, retry, label, dismissed: false }
    renderHandoffCardStatus()
  }

  const dismissHandoffError = () => {
    if (handoffStatus.tone !== 'error') return
    handoffStatus = { ...handoffStatus, dismissed: true }
    renderHandoffCardStatus()
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
    refreshHandoffButtons()
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
      refreshHandoffButtons()
    }
  }

  const retryCopy = async () => {
    if (transitionPending || !handoffResult) return
    transitionPending = true
    refreshHandoffButtons()
    try {
      await copyHandoffText()
    } finally {
      transitionPending = false
      refreshHandoffButtons()
    }
  }

  const refreshHandoffButtons = () => {
    handoffCard.querySelectorAll('button').forEach(button => {
      button.disabled = transitionPending
    })
    refreshSendState()
  }

  const retrySave = async button => {
    button.disabled = true
    if (savePromise) await savePromise
    await saveNow()
    if (button.isConnected) button.disabled = false
  }

  const handleSend = async () => {
    if (transitionPending || done) return
    syncActiveEditor()
    const index = referenceIndex()
    const question = QUESTIONS[index]
    transitionPending = true
    refreshSendState()
    try {
      if (!await saveNow()) return
      if (destroyed) return
      submitted[index] = true
      const nextIndex = submitted.findIndex(flag => !flag)
      if (nextIndex === -1) {
        completeFlow()
        return
      }
      stepIndex = nextIndex
      renderChatList()
      mountQuestionEditor()
      focusComposer()
    } finally {
      transitionPending = false
      refreshSendState()
      // 若本次 send 已完成三问(completeFlow 渲染 handoff 时 transitionPending 仍为 true),将 handoff 按钮解锁
      if (done) refreshHandoffButtons()
    }
  }

  const renderView = ({ forceFocus = false } = {}) => {
    renderChatList()
    if (!done) {
      if (!activeEditor) mountQuestionEditor()
      else updateProgress(), refreshSendState()
    } else {
      applyCompletionLayout()
    }
    focusComposer({ force: forceFocus })
  }

  const handleClick = event => {
    const button = event.target.closest('button')
    if (!button || !container.contains(button)) return

    if (button.matches('[data-guidance-send], [data-guidance-next]')) {
      // send button carries both attrs; one click = submit current answer (and advance).
      void handleSend()
      return
    }
    if (button.matches('[data-chat-edit-cancel]')) {
      cancelEdit(button.dataset.chatEditCancel)
      return
    }
    if (button.matches('[data-chat-edit-send]')) {
      void handleChatEditSend()
      return
    }
    if (button.matches('[data-edit-answer], [data-edit-guidance]')) {
      startEdit(button.dataset.editAnswer || button.dataset.editGuidance)
      return
    }
    if (button.matches('[data-copy-answer]')) {
      void copyAnswer(button)
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

  // 初始:根据已有答案恢复进度
  QUESTIONS.forEach((question, index) => {
    if (fields[question.key].trim()) submitted[index] = true
  })
  const initialPending = submitted.findIndex(flag => !flag)
  if (initialPending === -1) {
    stepIndex = QUESTIONS.length - 1
  } else {
    stepIndex = initialPending
  }
  if (initialPending === -1 && submitted.every(Boolean)) done = true
  renderView()
  renderHandoffCard()

  // 初始恢复完成态时按完成态约束 composer
  if (done) applyCompletionLayout()

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

// 提取 contenteditable 表面的 markdown(granular text 节点拼回,避免读 destroyed editor 句柄)
function lastSubmittedMarkdown(root) {
  const surface = root.querySelector('[data-guidance-editor-surface]')
  if (!surface) return ''
  return [...surface.children].map(block => {
    const list = block.matches?.('ol, ul') ? block : block.querySelector?.('ol, ul')
    if (list) {
      const ordered = list.tagName.toLowerCase() === 'ol'
      return [...list.children].map((li, index) => `${ordered ? `${index + 1}.` : '-'} ${li.textContent.trim()}`).join('\n')
    }
    return block.textContent.replace(/\u00a0/g, ' ').trim()
  }).filter(Boolean).join('\n\n')
}

function emptyHandoffStatus() {
  return { message: '', tone: '', retry: false, label: '', dismissed: false }
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

function pencilIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg>' }
function closeIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8m0-8-8 8"/></svg>' }
function copyIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="9" height="9" rx="2"/><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/></svg>' }
function sendIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15V5m0 0-4 4m4-4 4 4"/></svg>' }

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character])
}

function escapeAttribute(value) {
  return escapeHtml(value)
}

function formatChatTime(iso) {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)
}
