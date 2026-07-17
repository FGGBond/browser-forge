import { describe, it, expect } from 'vitest'
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
})
