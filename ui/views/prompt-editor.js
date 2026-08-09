import { parseGuidanceMarkdown, serializeGuidanceMarkdown } from '../guidance-format.js'
import { renderSafeMarkdown } from '../safe-markdown.js'
import { mountMarkdownEditor } from './markdown-editor.js'

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
      <div class="guidance-agent-status">
        <span class="guidance-agent-mark" aria-hidden="true">${sparkIcon()}</span>
        <div><strong>尚未配置 Agent</strong><p>先整理要求，再复制给外部 Agent，并让它使用 <span>browser-forge skill</span>。</p></div>
      </div>
      <div class="guidance-save-error-slot" data-save-error-slot></div>
      <div class="guidance-flow" data-guidance-flow></div>
    </section>`

  const flow = container.querySelector('[data-guidance-flow]')
  const errorSlot = container.querySelector('[data-save-error-slot]')
  let stepIndex = 0
  let maxReachedStep = 0
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
  let copyResetTimer = null

  const syncActiveEditor = () => {
    if (!activeEditor) return
    const question = QUESTIONS[stepIndex]
    const value = activeEditor.getValue()
    if (fields[question.key] === value) return
    fields[question.key] = value
    editRevision += 1
    dirty = true
  }

  const destroyActiveEditor = () => {
    activeEditor?.destroy()
    activeEditor = null
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
        if (!destroyed && editRevision !== revision && timer === null) {
          timer = setTimeout(saveNow, 500)
        }
        return false
      }

      savedText = text
      requiresMigration = false
      syncActiveEditor()
      if (revision === editRevision && serializeGuidanceMarkdown(fields) === text) {
        dirty = false
      }
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
    clearTimeout(timer)
    timer = setTimeout(saveNow, 500)
  }

  const renderProgress = () => `
    <div class="guidance-progress" data-guidance-progress>
      <ol aria-label="Skill 要求进度">
        ${QUESTIONS.map((question, index) => {
          const state = index === stepIndex
            ? 'current'
            : index < maxReachedStep
              ? 'complete'
              : index <= maxReachedStep
                ? 'reached'
                : ''
          return `<li class="${state}"><button type="button" data-guidance-step-jump="${index}" aria-label="${index + 1}. ${question.title}" ${index === stepIndex ? 'aria-current="step"' : ''} ${transitionPending || index > maxReachedStep ? 'disabled' : ''}><span>${index + 1}</span><small>${shortLabel(question.key)}</small></button></li>`
        }).join('')}
      </ol>
      <strong>${stepIndex + 1}/3</strong>
    </div>`

  const renderStep = () => {
    const question = QUESTIONS[stepIndex]
    flow.innerHTML = `
      ${renderProgress()}
      <section class="guidance-step" data-guidance-step="${stepIndex + 1}">
        <header class="guidance-question">
          <h3 data-guidance-step-title tabindex="-1">${question.title}</h3>
          <p>${question.description}</p>
        </header>
        <textarea class="prompt-textarea" data-prompt-textarea spellcheck="true" aria-label="${question.title}" placeholder="${question.placeholder}"></textarea>
      </section>
      <div class="guidance-actions">
        ${stepIndex > 0 ? `<button class="button quiet" type="button" data-guidance-previous ${transitionPending ? 'disabled' : ''}>上一步</button>` : '<span></span>'}
        <button class="button primary" type="button" data-guidance-next ${transitionPending ? 'disabled' : ''}>${stepIndex === QUESTIONS.length - 1 ? '检查并完成' : '下一步'}</button>
      </div>`

    const textarea = flow.querySelector('[data-prompt-textarea]')
    activeEditor = mountMarkdownEditor({
      textarea,
      initialValue: fields[question.key],
      placeholder: question.placeholder,
      onChange: value => scheduleSave(question.key, value)
    })
  }

  const renderReview = () => {
    flow.innerHTML = `
      <section class="guidance-review" data-guidance-review>
        <header class="guidance-review-heading">
          <h3 data-guidance-review-title tabindex="-1">检查你的 skill 要求</h3>
          <p>使用 browser-forge skill 分析录制并生成可独立运行的 skill 与 CLI 工具。</p>
        </header>
        <div class="guidance-review-list">
          ${QUESTIONS.map(question => renderReviewCard(question, fields[question.key], transitionPending)).join('')}
        </div>
      </section>
      <div class="guidance-actions guidance-review-actions">
        <button class="button quiet" type="button" data-guidance-previous ${transitionPending ? 'disabled' : ''}>返回修改</button>
        <button class="button primary" type="button" data-copy-agent-prompt ${transitionPending ? 'disabled' : ''}>${copyIcon()}<span data-copy-label>复制给外部 Agent</span></button>
      </div>`
  }

  const focusRenderedTitle = () => {
    const selector = reviewOpen ? '[data-guidance-review-title]' : '[data-guidance-step-title]'
    flow.querySelector(selector)?.focus({ preventScroll: true })
  }

  const renderView = ({ focusTitle = false } = {}) => {
    destroyActiveEditor()
    if (reviewOpen) renderReview()
    else renderStep()
    if (focusTitle) focusRenderedTitle()
  }

  const updateTransitionButtons = () => {
    flow.querySelectorAll('[data-guidance-next], [data-guidance-previous], [data-guidance-step-jump], [data-edit-guidance], [data-copy-agent-prompt]').forEach(button => {
      button.disabled = transitionPending || (
        button.matches('[data-guidance-step-jump]') && Number(button.dataset.guidanceStepJump) > maxReachedStep
      )
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
    if (!Number.isInteger(index) || index < 0 || index > maxReachedStep) return
    syncActiveEditor()
    stepIndex = index
    reviewOpen = false
    renderView({ focusTitle: true })
  }

  const copyExternalPrompt = async button => {
    if (transitionPending) return
    transitionPending = true
    updateTransitionButtons()
    try {
      if (!await saveNow()) return
      const result = await api.getExternalAgentPrompt(recordingId)
      await copyText(result.text)
      const label = button.querySelector('[data-copy-label]')
      label.textContent = '已复制'
      clearTimeout(copyResetTimer)
      copyResetTimer = setTimeout(() => {
        if (label.isConnected) label.textContent = '复制给外部 Agent'
      }, 1800)
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
          renderView({ focusTitle: true })
        } else {
          maxReachedStep = Math.max(maxReachedStep, stepIndex + 1)
          showStep(stepIndex + 1)
        }
      })
      return
    }
    if (button.matches('[data-guidance-previous]')) {
      void runFlushedTransition(() => showStep(reviewOpen ? QUESTIONS.length - 1 : stepIndex - 1))
      return
    }
    if (button.matches('[data-guidance-step-jump]')) {
      const index = Number(button.dataset.guidanceStepJump)
      void runFlushedTransition(() => showStep(index))
      return
    }
    if (button.matches('[data-edit-guidance]')) {
      const index = QUESTIONS.findIndex(question => question.key === button.dataset.editGuidance)
      void runFlushedTransition(() => showStep(index))
      return
    }
    if (button.matches('[data-retry-save]')) {
      retrySave(button)
      return
    }
    if (button.matches('[data-dismiss-save-error]')) {
      renderSaveError(false)
      return
    }
    if (button.matches('[data-copy-agent-prompt]')) copyExternalPrompt(button)
  }

  container.addEventListener('click', handleClick)
  renderView()

  return {
    flush: saveNow,
    beforeNavigate: saveNow,
    refresh() { activeEditor?.refresh?.() },
    destroy() {
      destroyed = true
      clearTimeout(timer)
      clearTimeout(copyResetTimer)
      container.removeEventListener('click', handleClick)
      destroyActiveEditor()
    },
    get dirty() { return dirty || requiresMigration },
    get savedText() { return savedText }
  }
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

function shortLabel(key) {
  return { actions: '操作', capability: '能力', acceptance: '验收' }[key]
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

function sparkIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m10 2 1.4 4.6L16 8l-4.6 1.4L10 14l-1.4-4.6L4 8l4.6-1.4L10 2Z"/></svg>' }
function copyIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="9" height="9" rx="2"/><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/></svg>' }
function closeIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8m0-8-8 8"/></svg>' }
