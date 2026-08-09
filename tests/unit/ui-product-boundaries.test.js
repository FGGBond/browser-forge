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
})
