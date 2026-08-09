import { describe, expect, it, vi } from 'vitest'
import { installMacLocal } from '../../scripts/install-mac-local.mjs'

describe('local macOS installer', () => {
  it('builds, quits, resets, replaces, registers, and launches in the only safe order', async () => {
    const calls = []
    const buildApp = vi.fn(async () => calls.push('build'))
    const quitApp = vi.fn(async () => calls.push('quit'))
    const resetPermission = vi.fn(async () => calls.push('reset'))
    const replaceApp = vi.fn(async ({ sourceApp, targetApp }) => calls.push(`replace:${sourceApp}:${targetApp}`))
    const registerApp = vi.fn(async targetApp => calls.push(`register:${targetApp}`))
    const launchApp = vi.fn(async targetApp => calls.push(`launch:${targetApp}`))

    await expect(installMacLocal({
      platform: 'darwin',
      sourceApp: '/build/Browser Forge.app',
      targetApp: '/Applications/Browser Forge.app',
      buildApp,
      quitApp,
      resetPermission,
      replaceApp,
      registerApp,
      launchApp
    })).resolves.toEqual({
      ok: true,
      sourceApp: '/build/Browser Forge.app',
      targetApp: '/Applications/Browser Forge.app'
    })

    expect(calls).toEqual([
      'build',
      'quit',
      'reset',
      'replace:/build/Browser Forge.app:/Applications/Browser Forge.app',
      'register:/Applications/Browser Forge.app',
      'launch:/Applications/Browser Forge.app'
    ])
    expect(resetPermission).toHaveBeenCalledWith()
  })

  it('rejects non-macOS installation before any side effect', async () => {
    const buildApp = vi.fn()

    await expect(installMacLocal({ platform: 'win32', buildApp }))
      .rejects.toMatchObject({ code: 'LOCAL_MAC_INSTALL_UNSUPPORTED' })
    expect(buildApp).not.toHaveBeenCalled()
  })
})
