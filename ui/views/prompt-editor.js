export const GUIDED_PROMPT_TEMPLATE = `我在这段录制中完成了：

[描述你刚才进行了哪些操作，以及为什么这样操作]

我希望生成的 Browser Forge skill 实现：

[描述未来希望 Agent 自动完成的目标]

调用这个 skill 时，用户会提供：

[输入参数，例如订单号、商品链接、查询日期]

skill 应返回或产生：

[输出结果或页面变更]

成功标准：

[什么结果代表操作成功]

限制和注意事项：

[登录状态、操作风险、不可执行的步骤等]`

export async function renderPromptEditor({ container, recordingId, api }) {
  const prompt = await api.getPrompt(recordingId)
  const initialText = prompt.text || GUIDED_PROMPT_TEMPLATE
  container.innerHTML = `
    <div class="prompt-editor-header"><div><p class="eyebrow">Agent guidance</p><h2>告诉 Agent 你想实现什么</h2></div><span class="save-state idle" data-save-state>${prompt.status === 'draft' ? '已保存' : '说明尚未保存'}</span></div>
    <p class="prompt-help">对照视频复述关键动作，并说明未来希望 skill 自动完成的目标、输入和成功标准。</p>
    <textarea class="prompt-textarea" data-prompt-textarea spellcheck="true" aria-label="Agent 分析说明">${escapeHtml(initialText)}</textarea>
    <div class="prompt-actions"><button class="button" type="button" data-preview-agent-prompt>预览完整提示词</button><button class="button primary" type="button" data-copy-agent-prompt>${copyIcon()}<span>复制给外部 Agent</span></button></div>
    <section class="agent-prompt-preview" data-preview-panel hidden><div class="preview-heading"><strong>完整外部 Agent 提示词</strong><button class="icon-button" type="button" data-close-preview aria-label="关闭预览">${closeIcon()}</button></div><p>录制绝对路径只会在复制时加入，不会写入 prompt.md。</p><pre data-agent-prompt-preview></pre></section>`

  const textarea = container.querySelector('[data-prompt-textarea]')
  const status = container.querySelector('[data-save-state]')
  const previewPanel = container.querySelector('[data-preview-panel]')
  const preview = container.querySelector('[data-agent-prompt-preview]')
  let savedText = prompt.text || ''
  let dirty = false
  let timer = null
  let savePromise = null
  let editRevision = 0
  let destroyed = false

  const setStatus = (state, message) => {
    status.className = `save-state ${state}`
    status.textContent = message
  }

  const saveNow = async () => {
    clearTimeout(timer)
    timer = null
    if (savePromise) return savePromise
    if (!dirty) return true
    savePromise = (async () => {
      while (dirty) {
        const revision = editRevision
        const text = textarea.value
        setStatus('saving', '正在保存…')
        try {
          await api.savePrompt(recordingId, text)
        } catch (error) {
          if (!destroyed) setStatus('error', `保存失败 · ${error.message}`)
          return false
        }
        savedText = text.trim()
        if (revision === editRevision && textarea.value === text) {
          dirty = false
          if (!destroyed) setStatus('saved', '已保存')
        } else {
          dirty = true
        }
      }
      return true
    })()
    try {
      return await savePromise
    } finally {
      savePromise = null
    }
  }

  const scheduleSave = () => {
    editRevision += 1
    dirty = true
    clearTimeout(timer)
    setStatus('dirty', '未保存')
    timer = setTimeout(saveNow, 500)
  }
  textarea.addEventListener('input', scheduleSave)

  const loadCompletePrompt = async () => {
    if (!await saveNow()) return null
    const result = await api.getExternalAgentPrompt(recordingId)
    preview.textContent = result.text
    previewPanel.hidden = false
    return result.text
  }
  container.querySelector('[data-preview-agent-prompt]').addEventListener('click', async event => {
    event.currentTarget.disabled = true
    try { await loadCompletePrompt() } finally { event.currentTarget.disabled = false }
  })
  container.querySelector('[data-copy-agent-prompt]').addEventListener('click', async event => {
    const button = event.currentTarget
    button.disabled = true
    try {
      const text = await loadCompletePrompt()
      if (!text) return
      await copyText(text)
      button.querySelector('span').textContent = '已复制'
      setTimeout(() => { if (button.isConnected) button.querySelector('span').textContent = '复制给外部 Agent' }, 1800)
    } catch (error) {
      setStatus('error', `复制失败 · ${error.message}`)
    } finally {
      button.disabled = false
    }
  })
  container.querySelector('[data-close-preview]').addEventListener('click', () => { previewPanel.hidden = true })

  return {
    flush: saveNow,
    beforeNavigate: saveNow,
    destroy() {
      destroyed = true
      clearTimeout(timer)
    },
    get dirty() { return dirty },
    get savedText() { return savedText }
  }
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

function escapeHtml(value) { return String(value ?? '').replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]) }
function copyIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="9" height="9" rx="2"/><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/></svg>' }
function closeIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8m0-8-8 8"/></svg>' }
