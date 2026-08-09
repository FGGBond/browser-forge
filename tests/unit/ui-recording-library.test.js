import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const uiRoot = join(process.cwd(), 'ui')
const readUi = name => readFileSync(join(uiRoot, name), 'utf8')

describe('managed recording library UI foundation', () => {
  it('loads build-free modules and opens on the recording library', () => {
    for (const file of ['styles.css', 'app.js', 'api.js', 'state.js', 'views/library.js', 'views/recording.js', 'views/sidebar.js']) {
      expect(existsSync(join(uiRoot, file))).toBe(true)
    }
    expect(readUi('index.html')).toContain('<link rel="stylesheet" href="/styles.css">')
    expect(readUi('index.html')).toContain('<script type="module" src="/app.js"></script>')
    expect(readUi('app.js')).toContain("navigate('library')")
    expect(readUi('views/sidebar.js')).toContain('录制仓库')
  })

  it('keeps repository cards video-first with only title, creation time, and analysis action metadata', () => {
    const source = readUi('views/library.js')
    expect(source).toContain('data-search')
    expect(source).not.toContain('data-new-recording')
    expect(source).toContain('recording-row')
    expect(source).toContain('mountVideoPlayer')
    expect(source).toContain('data-recording-id')
    expect(source).toContain('data-row-player')
    expect(source).toContain('data-analyze')
    expect(source).toContain('去分析')
    expect(source).toContain('formatDuration')
    expect(source).toContain('videoStatus')
    expect(source).toContain('<h2>${escapeHtml(recording.title)}</h2>')
    expect(source).toContain('<time datetime="${escapeAttribute(recording.createdAt)}">${formatDate(recording.createdAt)}</time>')
    expect(source).toContain("!['Enter', ' '].includes(event.key)")
    expect(source).not.toContain('formatDuration(recording.durationMs)')
    expect(source).not.toContain('startHost')
    expect(source).not.toContain('visitedHosts')
    expect(source).not.toContain('promptStatus')
    expect(source).not.toContain('recording-row-summary')
    expect(source).not.toContain('status-pill')
    expect(source).not.toContain('<dl class="recording-row-meta">')
  })

  it('uses the concise repository heading copy without an eyebrow', () => {
    const source = readUi('views/library.js')
    expect(source).toContain('<h1 id="library-title">录制仓库</h1>')
    expect(source).toContain('查看、搜索并分析保存在这台设备上的录制。')
    expect(source).not.toContain('class="eyebrow"')
  })

  it('uses responsive repository rows without the old card/detail split', () => {
    const css = readUi('styles.css')
    expect(css).toContain('@media (max-width: 840px)')
    expect(css).toContain('.recording-row')
    expect(css).toMatch(/\.recording-row\s*\{[^}]*grid-template-columns:\s*1fr/s)
    expect(css).toMatch(/\.repository-video\s*\{[^}]*border-bottom:/s)
    expect(css).not.toMatch(/\.recording-row-meta div\s*\{[^}]*background:/s)
    expect(css).not.toContain('.recording-row-summary')
    expect(css).not.toContain('.status-pill')
    expect(css).toContain('prefers-reduced-motion: reduce')
  })
})
