import { describe, it, expect, vi } from 'vitest'
import { CdpClient } from '../../src/main/recorder/cdp-client.js'

describe('CdpClient', () => {
  it('can be constructed with a port', () => {
    const client = new CdpClient({ port: 9222 })
    expect(client.port).toBe(9222)
  })

  it('tracks attached targets', () => {
    const client = new CdpClient({ port: 9222 })
    expect(client.getTargets()).toEqual([])
  })

  it('does not finish attaching an initial target until its collectors are ready', async () => {
    let releaseCollectors
    const collectorsReady = new Promise(resolve => { releaseCollectors = resolve })
    const session = { close: vi.fn() }
    const cdp = vi.fn(async () => session)
    const client = new CdpClient({ port: 9222, cdp })
    client._browser = { Target: { attachToTarget: vi.fn(async () => ({ sessionId: 'session-1' })) } }
    client.onTargetAttached = vi.fn(async () => collectorsReady)
    let attached = false

    const attaching = client._attachTarget({ targetId: 'page-1', type: 'page' }).then(() => { attached = true })
    await Promise.resolve()
    expect(attached).toBe(false)

    releaseCollectors()
    await attaching
    expect(client.onTargetAttached).toHaveBeenCalledWith('page-1', session)
    expect(attached).toBe(true)
  })
})
