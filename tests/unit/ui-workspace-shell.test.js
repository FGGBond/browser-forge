import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const uiRoot = join(process.cwd(), 'ui')
const readUi = name => readFileSync(join(uiRoot, name), 'utf8')

describe('recording workspace shell', () => {
  it('defines semantic light and dark appearance tokens', () => {
    const css = readUi('styles.css')
    expect(css).toContain('color-scheme: light dark')
    expect(css).toContain('@media (prefers-color-scheme: dark)')
    expect(css).toMatch(/\.search-field \{[^}]*background: var\(--surface\)/s)
    expect(css).toMatch(/\.detail-title-input:hover[^}]*background:var\(--surface\)/s)
    for (const token of [
      '--bg:', '--sidebar-bg:', '--surface:', '--surface-solid:', '--surface-muted:',
      '--line:', '--line-strong:', '--text:', '--muted:', '--subtle:', '--overlay:',
      '--focus-ring:', '--success:', '--warning:', '--danger:'
    ]) {
      expect(css.split(token).length - 1).toBeGreaterThanOrEqual(2)
    }
  })

  it('renders recordings as primary sidebar work objects', () => {
    const source = readUi('views/sidebar.js')
    expect(source).toContain('export function renderSidebar')
    expect(source).toContain('新录制')
    expect(source).toContain('录制仓库')
    expect(source).toContain('data-sidebar-recordings')
    expect(source).toContain('回收站')
    expect(source).toContain('data-sidebar-toggle')
    expect(source).toContain('browser-forge.sidebar-collapsed')
    expect(source).toContain('data-recording-nav')
    expect(source).toContain('data-recording-folder')
    expect(source).toContain("active ? 'open' : 'closed'")
    expect(source).toContain("aria-current=\"${active ? 'page' : 'false'}\"")
    expect(source).not.toContain('Browser Forge')
    expect(source).toContain('全部录制')
    expect(source).not.toContain('最近录制')
    expect(source).not.toContain('<small>')
    expect(source).not.toContain('site.slice(0, 1)')
    expect(source).not.toContain('<small>${escapeHtml(site)}</small>')
  })

  it('collapses nonessential sidebar content into a clean mobile toolbar', () => {
    const css = readUi('styles.css')
    expect(css).toMatch(/@media \(max-width: 840px\)[\s\S]*?\.sidebar-recording-section \{ display: none;/)
    expect(css).toContain('.primary-nav span, .secondary-nav span, .sidebar-new span, .sidebar-toggle { display: none; }')
    const shellRule = css.match(/\.app-shell \{[^}]*\}/s)?.[0] || ''
    expect(shellRule).not.toMatch(/transition:[^;}]*grid-template-columns/)
    expect(css).not.toMatch(/\.analysis-workspace[^}]*transition:[^;}]*grid-template-columns/s)
  })

  it('defines an interruptible compositor-only sidebar motion contract', () => {
    const app = readUi('app.js')
    const css = readUi('styles.css')

    expect(app).toContain('data-sidebar-motion')
    expect(app).toContain('requestAnimationFrame')
    expect(app).toContain('sidebar-labels-hidden')
    expect(app).not.toContain('cleanupSidebar?.()')
    expect(css).toMatch(/\.sidebar-label \{[^}]*opacity:1[^}]*transform:/s)
    expect(css).toMatch(/\.sidebar-labels-hidden \.sidebar-label \{[^}]*opacity:0[^}]*translateX\(-6px\)/s)
    expect(css).not.toMatch(/\.app-sidebar\.is-collapsed \.sidebar-label \{[^}]*display\s*:\s*none/s)
    expect(css).toContain('--sidebar-label-enter-duration: 170ms')
    expect(css).toContain('--sidebar-label-exit-duration: 110ms')
    expect(css).not.toMatch(/transition[^;}]*\b(?:width|padding|grid-template-columns)\b/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.sidebar-label[^}]*transform:none\s*!important/)
  })

  it('stores shell collapse state separately from recording data', () => {
    const app = readUi('app.js')
    expect(app).toContain("sidebarCollapsed: readSidebarCollapsed()")
    expect(app).toContain('renderWorkspaceSidebar')
    expect(app).toContain('writeSidebarCollapsed')
    expect(app).toContain("navigate('detail', { selectedId: id })")
    expect(app).toContain('analysisPaneOpen')
    expect(app).not.toContain('analysisModalOpen')
    expect(app).not.toContain('sidebarHost.inert')
    const detail = readUi('views/detail.js')
    expect(detail).toContain('data-analysis-pane')
    expect(detail).toContain('aria-controls="recording-analysis-guidance"')
    expect(detail).toContain('id="recording-analysis-guidance"')
    expect(detail).not.toContain('data-analysis-backdrop')
    expect(detail).not.toContain('setBackgroundInert')
  })
})
