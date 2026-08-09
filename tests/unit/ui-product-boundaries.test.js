import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const readUi = path => readFileSync(join(process.cwd(), 'ui', path), 'utf8')

describe('recording workspace product boundaries', () => {
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
    expect(readUi('views/detail.js')).toContain('Agent 尚未配置')
    expect(readUi('views/detail.js')).toContain('data-analysis-pane')
  })

  it('keeps the analysis guidance flow structured, local, and free of normal save-state copy', () => {
    const promptEditor = readUi('views/prompt-editor.js')

    for (const dependency of ['parseGuidanceMarkdown', 'serializeGuidanceMarkdown', 'mountMarkdownEditor', 'renderSafeMarkdown']) {
      expect(promptEditor).toContain(dependency)
    }
    for (const question of [
      '这次录制中，你完成了什么？',
      '希望把这段操作变成什么能力？',
      '怎样证明这个 skill 可以交付？'
    ]) {
      expect(promptEditor).toContain(question)
    }
    for (const hook of [
      'data-guidance-step',
      'data-guidance-progress',
      'data-guidance-next',
      'data-guidance-previous',
      'data-guidance-review',
      'data-edit-guidance',
      'data-save-error',
      'data-retry-save',
      'data-dismiss-save-error',
      'data-prompt-textarea'
    ]) {
      expect(promptEditor).toContain(hook)
    }
    expect(promptEditor).toContain('尚未配置 Agent')
    expect(promptEditor).toContain('browser-forge skill')
    expect(promptEditor).not.toContain('Agent guidance')
    expect(promptEditor).not.toContain('data-save-state')
    expect(promptEditor).not.toContain('说明尚未保存')
    expect(promptEditor).not.toContain('正在保存')
    expect(promptEditor).not.toContain('预览完整提示词')
    expect(promptEditor).not.toContain('GUIDED_PROMPT_TEMPLATE')
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
