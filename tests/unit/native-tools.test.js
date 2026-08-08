import { describe, expect, it } from 'vitest'
import { getNativeToolExecutableName, getNativeToolPlatformKey, resolveNativeToolPath } from '../../src/main/recorder/native-tools.js'

describe('resolveNativeToolPath', () => {
  it('uses the generated root native-tools directory during development', () => {
    expect(resolveNativeToolPath({
      toolName: 'bf-window-recorder',
      projectRoot: '/workspace/browser-forge',
      resourcesPath: undefined,
      packaged: false,
      platform: 'darwin',
      arch: 'arm64'
    })).toBe('/workspace/browser-forge/native-tools/bf-window-recorder')
  })

  it('uses the same native-tools directory in Electron resources after packaging', () => {
    expect(resolveNativeToolPath({
      toolName: 'bf-window-recorder',
      resourcesPath: '/Applications/Browser Forge.app/Contents/Resources',
      packaged: true,
      platform: 'darwin',
      arch: 'arm64'
    })).toBe('/Applications/Browser Forge.app/Contents/Resources/native-tools/bf-window-recorder')
  })

  it('does not infer packaged mode from a platform-specific resources path suffix', () => {
    expect(resolveNativeToolPath({
      toolName: 'bf-window-recorder',
      resourcesPath: '/Applications/Browser Forge.app/Contents/Resources',
      projectRoot: '/workspace/browser-forge',
      platform: 'darwin',
      arch: 'arm64'
    })).toBe('/workspace/browser-forge/native-tools/bf-window-recorder')
  })
})


describe('getNativeToolPlatformKey', () => {
  it('returns the delivered macOS ARM64 platform key', () => {
    expect(getNativeToolPlatformKey({ platform: 'darwin', arch: 'arm64' })).toBe('darwin-arm64')
  })

  it.each([
    ['darwin', 'x64'],
    ['win32', 'x64']
  ])('rejects an undelivered native tool platform before path resolution: %s-%s', (platform, arch) => {
    expect(() => resolveNativeToolPath({
      toolName: 'bf-window-recorder',
      platform,
      arch,
      projectRoot: '/workspace/browser-forge',
      packaged: false
    })).toThrow(new RegExp(`${platform}-${arch}`))
  })
})

describe('getNativeToolExecutableName', () => {
  it('keeps platform executable naming in one registry for future Windows delivery', () => {
    expect(getNativeToolExecutableName({ tool: 'windowRecorder', platform: 'darwin', arch: 'arm64' })).toBe('bf-window-recorder')
    expect(getNativeToolExecutableName({ tool: 'windowRecorder', platform: 'win32', arch: 'x64' })).toBe('bf-window-recorder.exe')
  })
})
