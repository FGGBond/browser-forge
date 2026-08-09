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
  })

  it('stores shell collapse state separately from recording data', () => {
    const app = readUi('app.js')
    expect(app).toContain("sidebarCollapsed: readSidebarCollapsed()")
    expect(app).toContain('renderWorkspaceSidebar')
    expect(app).toContain('writeSidebarCollapsed')
    expect(app).toContain("navigate('detail', { selectedId: id })")
  })
})
