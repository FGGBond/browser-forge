import { describe, it, expect } from 'vitest'
import { findChromePath, buildChromeArgs } from '../../src/main/chrome-launcher.js'

describe('buildChromeArgs', () => {
  it('includes remote-debugging-port', () => {
    const args = buildChromeArgs({ port: 9222, userDataDir: '/tmp/test' })
    expect(args).toContain('--remote-debugging-port=9222')
  })

  it('includes user-data-dir', () => {
    const args = buildChromeArgs({ port: 9222, userDataDir: '/tmp/test' })
    expect(args.some(a => a.startsWith('--user-data-dir='))).toBe(true)
  })

  it('opens the configured recording start URL in a new window', () => {
    const args = buildChromeArgs({
      port: 9222,
      userDataDir: '/tmp/test',
      startUrl: 'http://localhost:3456/recording-start.html'
    })

    expect(args).toContain('--new-window')
    expect(args.at(-1)).toBe('http://localhost:3456/recording-start.html')
    expect(args).not.toContain('about:blank')
  })
})

describe('findChromePath', () => {
  it('returns a string path', async () => {
    const path = await findChromePath()
    expect(typeof path).toBe('string')
  })
})
