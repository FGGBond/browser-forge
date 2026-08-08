import { join } from 'path'

const NATIVE_TOOL_PLATFORMS = Object.freeze({
  'darwin-arm64': Object.freeze({
    delivered: true,
    executables: Object.freeze({
      windowRecorder: 'bf-window-recorder',
      videoFrame: 'bf-video-frame'
    })
  }),
  // Reserved contract for the next backend. Keeping naming and lookup here
  // prevents platform-specific `.exe` decisions from leaking into callers.
  'win32-x64': Object.freeze({
    delivered: false,
    executables: Object.freeze({
      windowRecorder: 'bf-window-recorder.exe',
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
  if (packaged) {
    if (!resourcesPath) throw new Error('resourcesPath is required for packaged native tools')
    return join(resourcesPath, 'native-tools', toolName)
  }
  return join(projectRoot, 'native-tools', toolName)
}
