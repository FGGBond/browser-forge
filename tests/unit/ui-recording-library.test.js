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

  it('renders title, time, duration, host, video status, search, and new-recording controls', () => {
    const source = readUi('views/library.js')
    expect(source).toContain('data-search')
    expect(source).toContain('data-new-recording')
    expect(source).toContain('formatDuration')
    expect(source).toContain('videoStatus')
    expect(source).toContain('startHost')
  })

  it('uses responsive list/detail screens rather than compressing the player', () => {
    const css = readUi('styles.css')
    expect(css).toContain('@media (max-width: 840px)')
    expect(css).toContain('.library-grid')
    expect(css).toContain('prefers-reduced-motion: reduce')
  })
})
