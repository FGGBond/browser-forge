import { join } from 'path'

export function resolveNativeToolPath({
  toolName,
  platform = process.platform,
  resourcesPath = process.resourcesPath,
  projectRoot = process.cwd(),
  packaged = Boolean(resourcesPath?.endsWith('/Resources'))
} = {}) {
  if (!toolName) throw new Error('toolName is required')
  if (platform !== 'darwin') throw new Error(`No native video tool for platform: ${platform}`)
  if (packaged) return join(resourcesPath, 'native-tools', toolName)
  return join(projectRoot, 'native', 'macos', 'bin', toolName)
}
