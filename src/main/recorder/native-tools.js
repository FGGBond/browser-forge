import { dirname, join } from 'path'

const MACOS_RECORDER_EXECUTABLE = 'Browser Forge Recorder'
const MACOS_RECORDER_APP = 'Browser Forge Recorder.app'

const NATIVE_TOOL_PLATFORMS = Object.freeze({
  'darwin-arm64': Object.freeze({
    delivered: true,
    executables: Object.freeze({
      windowRecorder: MACOS_RECORDER_EXECUTABLE,
      screenPermission: 'bf-screen-permission.node',
      videoFrame: 'bf-video-frame'
    })
  }),
  // Reserved contract for the next backend. Keeping naming and lookup here
  // prevents platform-specific `.exe` decisions from leaking into callers.
  'win32-x64': Object.freeze({
    delivered: false,
    executables: Object.freeze({
      windowRecorder: 'bf-window-recorder.exe',
      screenPermission: 'bf-screen-permission.node',
      videoFrame: 'bf-video-frame.exe'
    })
  })
})

function platformKey({ platform = process.platform, arch = process.arch } = {}) {
  return `${platform}-${arch}`
}

export function getNativeToolPlatformKey(options = {}) {
  const key = platformKey(options)
  if (!NATIVE_TOOL_PLATFORMS[key]?.delivered) {
    throw new Error(`No native video tool for platform: ${key}`)
  }
  return key
}

export function getNativeToolExecutableName({ tool, ...options } = {}) {
  const key = platformKey(options)
  const name = NATIVE_TOOL_PLATFORMS[key]?.executables?.[tool]
  if (!name) throw new Error(`No native video executable named ${tool ?? 'unknown'} for platform: ${key}`)
  return name
}

export function resolveScreenRecordingHelperAppPath({
  platform = process.platform,
  arch = process.arch,
  resourcesPath = process.resourcesPath,
  projectRoot = process.cwd(),
  packaged = false
} = {}) {
  getNativeToolPlatformKey({ platform, arch })
  if (platform !== 'darwin') throw new Error(`No screen recording Helper App for platform: ${platform}-${arch}`)
  if (packaged) {
    if (!resourcesPath) throw new Error('resourcesPath is required for packaged native tools')
    return join(dirname(resourcesPath), 'Helpers', MACOS_RECORDER_APP)
  }
  return join(projectRoot, 'native-tools', MACOS_RECORDER_APP)
}

export function resolveNativeToolPath({
  toolName,
  platform = process.platform,
  arch = process.arch,
  resourcesPath = process.resourcesPath,
  projectRoot = process.cwd(),
  packaged = false
} = {}) {
  if (!toolName) throw new Error('toolName is required')
  getNativeToolPlatformKey({ platform, arch })
  if (platform === 'darwin' && toolName === MACOS_RECORDER_EXECUTABLE) {
    return join(
      resolveScreenRecordingHelperAppPath({ platform, arch, resourcesPath, projectRoot, packaged }),
      'Contents',
      'MacOS',
      MACOS_RECORDER_EXECUTABLE
    )
  }
  if (packaged) {
    if (!resourcesPath) throw new Error('resourcesPath is required for packaged native tools')
    return join(resourcesPath, 'native-tools', toolName)
  }
  return join(projectRoot, 'native-tools', toolName)
}
