import { describe, expect, it, vi } from 'vitest'
import { ScreenRecordingPermission } from '../../src/main/recorder/screen-recording-permission.js'

function jsonResult(overrides = {}) {
  return JSON.stringify({
    type: 'screen-recording-permission',
    action: 'check',
    status: 'not-granted',
    granted: false,
    restartRequired: false,
    ...overrides
  }) + '\n'
}

describe('ScreenRecordingPermission', () => {
  it('checks permission through the registered native window recorder', async () => {
    const execute = vi.fn(async () => ({ stdout: jsonResult({ status: 'granted', granted: true }), stderr: '' }))
    const permission = new ScreenRecordingPermission({
      platform: 'darwin',
      arch: 'arm64',
      resolveBinaryPath: name => `/native/${name}`,
      execute
    })

    await expect(permission.check()).resolves.toEqual({
      supported: true,
      status: 'granted',
      granted: true,
      restartRequired: false
    })
    expect(execute).toHaveBeenCalledWith('/native/bf-window-recorder', ['--check-permission'])
  })

  it.each([
    ['denied', false],
    ['restart-required', true],
    ['granted', false]
  ])('normalizes request status %s', async (status, restartRequired) => {
    const granted = status === 'granted'
    const permission = new ScreenRecordingPermission({
      platform: 'darwin',
      arch: 'arm64',
      resolveBinaryPath: () => '/native/bf-window-recorder',
      execute: async () => ({ stdout: jsonResult({ action: 'request', status, granted, restartRequired }), stderr: '' })
    })

    await expect(permission.request()).resolves.toEqual({ supported: true, status, granted, restartRequired })
  })

  it('rejects malformed or mismatched native protocol output', async () => {
    const permission = new ScreenRecordingPermission({
      platform: 'darwin',
      arch: 'arm64',
      resolveBinaryPath: () => '/native/bf-window-recorder',
      execute: async () => ({ stdout: '{"type":"completed"}\n', stderr: '' })
    })

    await expect(permission.check()).rejects.toMatchObject({ code: 'SCREEN_RECORDING_PERMISSION_PROTOCOL_ERROR' })
  })

  it('surfaces native execution failures with a stable error code', async () => {
    const permission = new ScreenRecordingPermission({
      platform: 'darwin',
      arch: 'arm64',
      resolveBinaryPath: () => '/native/bf-window-recorder',
      execute: async () => { throw new Error('spawn EACCES') }
    })

    await expect(permission.check()).rejects.toMatchObject({ code: 'SCREEN_RECORDING_PERMISSION_CHECK_FAILED' })
  })

  it('returns an explicit unsupported state without launching a binary on an undelivered platform', async () => {
    const execute = vi.fn()
    const permission = new ScreenRecordingPermission({ platform: 'win32', arch: 'x64', execute })

    await expect(permission.check()).resolves.toEqual({
      supported: false,
      status: 'unsupported',
      granted: false,
      restartRequired: false,
      platform: 'win32-x64'
    })
    await expect(permission.request()).resolves.toEqual(expect.objectContaining({ status: 'unsupported' }))
    expect(execute).not.toHaveBeenCalled()
  })
})
