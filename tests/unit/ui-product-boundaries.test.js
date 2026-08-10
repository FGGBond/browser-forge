import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

const readUi = path => readFileSync(join(process.cwd(), 'ui', path), 'utf8')

describe('recording workspace product boundaries', () => {
  it('removes redundant English eyebrow and repository status copy from visible renderer views', () => {
    const rendererSource = [
      ...readdirSync(join(process.cwd(), 'ui', 'views'))
      .filter(name => name.endsWith('.js'))
      .map(name => readUi(join('views', name))),
      readUi('styles.css')
    ]
      .join('\n')

    for (const copy of [
      'Recording workspace',
      'Recording repository',
      'Analysis session',
      'Agent guidance',
      'Chrome window',
      'Recycle bin',
      '视频可用',
      '视频部分可用',
      '分析说明待补充',
      '已有分析说明'
    ]) {
      expect(rendererSource.toLocaleLowerCase()).not.toContain(copy.toLocaleLowerCase())
    }
  })

  it('keeps internal artifact vocabulary out of visible renderer views', () => {
    const visibleViews = [
      'views/library.js',
      'views/recording.js',
      'views/detail.js',
      'views/trash.js',
      'views/prompt-editor.js'
    ].map(readUi).join('\n')
    for (const internalLabel of ['录制物料', '关键事件', '画面物料']) {
      expect(visibleViews).not.toContain(internalLabel)
    }
  })

  it('uses only the private muted player without native download or picture-in-picture affordances', () => {
    const views = ['views/library.js', 'views/detail.js', 'views/video-player.js'].map(readUi).join('\n')
    expect(views).not.toMatch(/<video\s+controls(?:\s|>)/i)
    expect(readUi('views/video-player.js')).toContain('disablepictureinpicture')
    expect(readUi('views/video-player.js')).toContain('nodownload')
    expect(readUi('views/video-player.js')).not.toContain('data-player-volume')
    expect(readUi('views/video-player.js')).not.toContain('data-player-download')
  })

  it('keeps new recording focused on two composer actions and exposes an explicit unconfigured Agent state', () => {
    const recording = readUi('views/recording.js')
    expect(readUi('views/sidebar.js')).toContain('data-new-recording')
    expect(readUi('views/library.js')).not.toContain('data-new-recording')
    expect(recording).toContain('data-send-goal')
    expect(recording).toContain('data-notice-stack')
    expect(recording).not.toContain('goal-context-note')
    expect(recording).not.toContain('permission-actions')
    expect(recording).not.toContain('advanced-settings')
    expect(readUi('views/prompt-editor.js')).toContain('尚未配置 Agent')
    expect(readUi('views/detail.js')).toContain('data-analysis-pane')
  })

  it('keeps the analysis guidance flow structured, local, and free of editor chrome', () => {
    const promptEditor = readUi('views/prompt-editor.js')
    const api = readUi('api.js')
    const index = readUi('index.html')

    for (const dependency of ['parseGuidanceMarkdown', 'serializeGuidanceMarkdown', 'mountGuidanceEditor', 'renderSafeMarkdown']) {
      expect(promptEditor).toContain(dependency)
    }
    for (const question of [
      '这次录制中，你完成了什么？',
      '希望把这段操作变成什么能力？',
      '怎样证明这个 skill 可以交付？'
    ]) {
      expect(promptEditor).toContain(question)
    }
    for (const copy of ['第 ${stepIndex + 1} / 3 个问题', '导出并复制给外部 Agent', '录制已导出，复制失败', '重试复制']) {
      expect(promptEditor).toContain(copy)
    }
    for (const hook of [
      'data-guidance-step',
      'data-guidance-progress',
      'data-guidance-composer',
      'data-guidance-next',
      'data-guidance-previous',
      'data-guidance-review',
      'data-edit-guidance',
      'data-save-error',
      'data-retry-save',
      'data-dismiss-save-error',
      'data-prompt-textarea',
      'data-retry-copy'
    ]) {
      expect(promptEditor).toContain(hook)
    }
    expect(promptEditor).toContain('role="status" aria-live="polite"')
    expect(promptEditor).toContain('createAgentHandoff')
    expect(promptEditor).not.toContain('getExternalAgentPrompt')
    expect(promptEditor).not.toContain('mountMarkdownEditor')
    expect(promptEditor).not.toContain('maxReachedStep')
    expect(promptEditor).not.toContain('data-guidance-step-jump')
    expect(promptEditor).not.toContain('tabindex="-1"')
    expect(api).toContain('createAgentHandoff')
    expect(index).toContain('/guidance.css')
    expect(index).not.toContain('easymde')
    expect(index).not.toContain('EasyMDE')
  })

  it('locks the local UI to same-origin resources with a strict CSP', () => {
    const index = readUi('index.html')
    const csp = index.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i)?.[1]

    expect(csp).toBeTruthy()
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("script-src 'self'")
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-(?:inline|eval)'/)
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("img-src 'self'")
    expect(csp).toContain("media-src 'self' blob:")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("frame-src 'none'")
    expect(csp).toContain("base-uri 'none'")

    const resourceUrls = [...index.matchAll(/(?:src|href)=["']([^"']+)["']/gi)].map(match => match[1])
    expect(resourceUrls.length).toBeGreaterThan(0)
    expect(resourceUrls.every(url => url.startsWith('/') && !url.startsWith('//'))).toBe(true)
    expect(index).not.toMatch(/<(?:script|link)[^>]+(?:https?:|data:|file:|\/\/)/i)
    expect(index).not.toMatch(/<script(?![^>]+\bsrc=)[^>]*>\s*[^<]/i)
  })

})
