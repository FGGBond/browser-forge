export function mergeVideoToolsManifest(existing, platformKey, platformTools) {
  if (typeof platformKey !== 'string' || !platformKey) throw new Error('platformKey is required')
  if (!platformTools || typeof platformTools !== 'object' || Array.isArray(platformTools)) {
    throw new Error('platformTools must be an object')
  }
  if (existing != null && (existing.version !== 1 || !existing.tools || typeof existing.tools !== 'object' || Array.isArray(existing.tools))) {
    throw new Error('Existing video-tools manifest is invalid')
  }
  return {
    version: 1,
    tools: {
      ...(existing?.tools ?? {}),
      [platformKey]: platformTools
    }
  }
}
