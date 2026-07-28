import { describe, it, expect } from 'vitest'
import { findChromePath, buildChromeArgs, findAvailablePort, waitForChromeDebugEndpoint } from '../../src/main/chrome-launcher.js'

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


describe('findAvailablePort', () => {
  it('returns a connectable local port number', async () => {
    const port = await findAvailablePort()
    expect(Number.isInteger(port)).toBe(true)
    expect(port).toBeGreaterThan(0)
  })
})

describe('waitForChromeDebugEndpoint', () => {
  it('waits until Chrome exposes the debugger websocket URL', async () => {
    let attempts = 0
    const version = await waitForChromeDebugEndpoint({
      port: 9333,
      chromeProcess: { exitCode: null, killed: false, once: () => {} },
      timeoutMs: 1000,
      intervalMs: 1,
      sleep: async () => {},
      fetchImpl: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('connect ECONNREFUSED 127.0.0.1:9333')
        return {
          ok: true,
          json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/test' })
        }
      }
    })

    expect(version.webSocketDebuggerUrl).toContain('9333')
    expect(attempts).toBe(2)
  })

  it('fails early when Chrome exits before the debugger endpoint is ready', async () => {
    await expect(waitForChromeDebugEndpoint({
      port: 9333,
      chromeProcess: {
        exitCode: 1,
        killed: false,
        browserForge: { stderrTail: 'policy blocked remote debugging' },
        once: () => {}
      },
      timeoutMs: 1000,
      intervalMs: 1,
      sleep: async () => {},
      fetchImpl: async () => { throw new Error('should not fetch') }
    })).rejects.toThrow('Chrome 启动后提前退出')
  })
})
