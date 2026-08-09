import { describe, expect, it } from 'vitest'
import { getNativeToolExecutableName, getNativeToolPlatformKey, resolveNativeToolPath, resolveScreenRecordingHelperAppPath } from '../../src/main/recorder/native-tools.js'

const developmentRecorder = '/workspace/browser-forge/native-tools/Browser Forge Recorder.app/Contents/MacOS/Browser Forge Recorder'
const packagedRecorder = '/Applications/Browser Forge.app/Contents/Helpers/Browser Forge Recorder.app/Contents/MacOS/Browser Forge Recorder'

describe('resolveNativeToolPath', () => {
  it('resolves the recorder inside its generated Helper App during development', () => {
    expect(resolveNativeToolPath({
      toolName: 'Browser Forge Recorder',
      projectRoot: '/workspace/browser-forge',
      resourcesPath: undefined,
      packaged: false,
      platform: 'darwin',
      arch: 'arm64'
    })).toBe(developmentRecorder)
  })

  it('resolves the same Helper App executable under Contents/Helpers after packaging', () => {
    expect(resolveNativeToolPath({
      toolName: 'Browser Forge Recorder',
      resourcesPath: '/Applications/Browser Forge.app/Contents/Resources',
      packaged: true,
      platform: 'darwin',
      arch: 'arm64'
    })).toBe(packagedRecorder)
  })

  it('keeps the frame extractor in the Resources/native-tools directory', () => {
    expect(resolveNativeToolPath({
      toolName: 'bf-video-frame',
      resourcesPath: '/Applications/Browser Forge.app/Contents/Resources',
      packaged: true,
      platform: 'darwin',
      arch: 'arm64'
    })).toBe('/Applications/Browser Forge.app/Contents/Resources/native-tools/bf-video-frame')
  })

  it('does not infer packaged mode from a platform-specific resources path suffix', () => {
    expect(resolveNativeToolPath({
      toolName: 'Browser Forge Recorder',
      resourcesPath: '/Applications/Browser Forge.app/Contents/Resources',
      projectRoot: '/workspace/browser-forge',
      platform: 'darwin',
      arch: 'arm64'
    })).toBe(developmentRecorder)
  })
})

describe('resolveScreenRecordingHelperAppPath', () => {
  it('returns the fixed Helper App bundle instead of accepting a renderer path', () => {
    expect(resolveScreenRecordingHelperAppPath({
      projectRoot: '/workspace/browser-forge',
      packaged: false,
      platform: 'darwin',
      arch: 'arm64'
    })).toBe('/workspace/browser-forge/native-tools/Browser Forge Recorder.app')
    expect(resolveScreenRecordingHelperAppPath({
      resourcesPath: '/Applications/Browser Forge.app/Contents/Resources',
      packaged: true,
      platform: 'darwin',
      arch: 'arm64'
    })).toBe('/Applications/Browser Forge.app/Contents/Helpers/Browser Forge Recorder.app')
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
      toolName: 'Browser Forge Recorder',
      platform,
      arch,
      projectRoot: '/workspace/browser-forge',
      packaged: false
    })).toThrow(new RegExp(`${platform}-${arch}`))
  })
})

describe('getNativeToolExecutableName', () => {
  it('keeps platform executable naming in one registry for future Windows delivery', () => {
    expect(getNativeToolExecutableName({ tool: 'windowRecorder', platform: 'darwin', arch: 'arm64' })).toBe('Browser Forge Recorder')
    expect(getNativeToolExecutableName({ tool: 'windowRecorder', platform: 'win32', arch: 'x64' })).toBe('bf-window-recorder.exe')
  })
})
