import { describe, expect, it, vi } from 'vitest'
import {
  BROWSER_FORGE_BUNDLE_ID,
  createMainProcessScreenRecordingPermission,
  resetBrowserForgeScreenRecordingPermission
} from '../../src/main/screen-recording-recovery.js'

describe('macOS screen recording recovery', () => {
  it('resets only Browser Forge ScreenCapture authorization with fixed tccutil arguments', async () => {
    const execute = vi.fn(async () => ({ stdout: 'Successfully reset ScreenCapture approval status for com.browserforge.app\n', stderr: '' }))

    await expect(resetBrowserForgeScreenRecordingPermission({ platform: 'darwin', execute })).resolves.toEqual({
      ok: true,
      service: 'ScreenCapture',
      bundleId: 'com.browserforge.app'
    })
    expect(BROWSER_FORGE_BUNDLE_ID).toBe('com.browserforge.app')
    expect(execute).toHaveBeenCalledWith('/usr/bin/tccutil', [
      'reset',
      'ScreenCapture',
      'com.browserforge.app'
    ])
  })


  it('checks and requests ScreenCapture from native code loaded inside the Browser Forge main process', async () => {
    const nativeModule = {
      check: vi.fn(() => false),
      request: vi.fn(() => true)
    }
    const permission = createMainProcessScreenRecordingPermission({ nativeModule, platform: 'darwin' })

    await expect(permission.check()).resolves.toEqual({
      supported: true,
      status: 'not-granted',
      granted: false,
      restartRequired: false
    })
    await expect(permission.request()).resolves.toEqual({
      supported: true,
      status: 'restart-required',
      granted: false,
      restartRequired: true
    })
    expect(nativeModule.check).toHaveBeenCalledTimes(2)
    expect(nativeModule.request).toHaveBeenCalledTimes(1)
  })

  it('does not request again when main-process native preflight is already granted', async () => {
    const nativeModule = { check: vi.fn(() => true), request: vi.fn() }
    const permission = createMainProcessScreenRecordingPermission({ nativeModule, platform: 'darwin' })

    await expect(permission.request()).resolves.toEqual({
      supported: true,
      status: 'granted',
      granted: true,
      restartRequired: false
    })
    expect(nativeModule.request).not.toHaveBeenCalled()
  })

  it('reports manual authorization when macOS refuses to prompt programmatically', async () => {
    const permission = createMainProcessScreenRecordingPermission({
      nativeModule: { check: () => false, request: () => false },
      platform: 'darwin'
    })

    await expect(permission.request()).resolves.toEqual({
      supported: true,
      status: 'manual-authorization-required',
      granted: false,
      restartRequired: false
    })
  })

  it('returns unsupported without loading native permission code on other platforms', async () => {
    const nativeModule = { check: vi.fn(), request: vi.fn() }
    const permission = createMainProcessScreenRecordingPermission({ nativeModule, platform: 'win32', arch: 'x64' })

    await expect(permission.check()).resolves.toEqual({
      supported: false,
      status: 'unsupported',
      granted: false,
      restartRequired: false,
      platform: 'win32-x64'
    })
    expect(nativeModule.check).not.toHaveBeenCalled()
  })

  it('rejects non-macOS reset attempts without executing a command', async () => {
    const execute = vi.fn()

    await expect(resetBrowserForgeScreenRecordingPermission({ platform: 'win32', execute }))
      .rejects.toMatchObject({ code: 'SCREEN_RECORDING_RESET_UNSUPPORTED' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('wraps tccutil failures in a stable recovery error', async () => {
    const cause = Object.assign(new Error('tccutil failed'), { stderr: 'failed' })

    await expect(resetBrowserForgeScreenRecordingPermission({
      platform: 'darwin',
      execute: vi.fn(async () => { throw cause })
    })).rejects.toMatchObject({
      code: 'SCREEN_RECORDING_RESET_FAILED',
      cause
    })
  })
})
