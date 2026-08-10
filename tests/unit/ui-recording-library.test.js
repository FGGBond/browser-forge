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

  it('renders compact evidence rows with a real poster, truthful metadata, and one analysis action', () => {
    const source = readUi('views/library.js')
    expect(source).toContain('data-search')
    expect(source).not.toContain('data-new-recording')
    expect(source).toContain('recording-row')
    expect(source).not.toContain('mountVideoPlayer')
    expect(source).toContain('data-recording-id')
    expect(source).toContain('repository-preview')
    expect(source).toContain('/poster')
    expect(source).toContain('data-analyze')
    expect(source).toContain('去分析')
    expect(source).toContain('formatDuration(recording.durationMs)')
    expect(source).toContain('recording.startHost')
    expect(source).toContain('videoStatusLabel(recording.videoStatus)')
    expect(source).toContain('${escapeHtml(recording.title)}</h2>')
    expect(source).toContain('<time datetime="${escapeAttribute(recording.createdAt)}">${formatDate(recording.createdAt)}</time>')
    expect(source).toContain("!['Enter', ' '].includes(event.key)")
    expect(source).not.toContain('promptStatus')
    expect(source).not.toContain('recording-row-summary')
    expect(source).not.toContain('<dl class="recording-row-meta">')
  })

  it('uses the concise repository heading copy without an eyebrow', () => {
    const source = readUi('views/library.js')
    expect(source).toContain('<h1 id="library-title">录制仓库</h1>')
    expect(source).toContain('查看、搜索并分析保存在这台设备上的录制。')
    expect(source).not.toContain('class="eyebrow"')
  })

  it('uses compact responsive rows rather than full-width video cards', () => {
    const css = readUi('styles.css')
    expect(css).toContain('@media (max-width: 840px)')
    expect(css).toContain('.recording-row')
    expect(css).toMatch(/\.recording-row\s*\{[^}]*grid-template-columns:\s*136px\s+minmax\(0,1fr\)\s+auto/s)
    expect(css).toMatch(/\.repository-preview\s*\{[^}]*aspect-ratio:\s*16\/9/s)
    expect(css).not.toMatch(/\.repository-video\s*\{[^}]*border-bottom:/s)
    expect(css).not.toContain('.recording-row-summary')
    expect(css).toContain('prefers-reduced-motion: reduce')
  })
})
