const WIDTH_KEYS = {
  'sidebar-width': 'browser-forge.sidebar-width',
  'analysis-pane-width': 'browser-forge.analysis-pane-width'
}

export function readUiPreference(key, storage = globalThis.localStorage) {
  const storageKey = WIDTH_KEYS[key]
  if (!storageKey) return ''
  try {
    return storage?.getItem(storageKey) ?? ''
  } catch {
    return ''
  }
}

export function writeUiPreference(key, value, storage = globalThis.localStorage) {
  const storageKey = WIDTH_KEYS[key]
  if (!storageKey) return
  try {
    if (value === null || value === undefined || value === '') storage?.removeItem(storageKey)
    else storage?.setItem(storageKey, String(value))
  } catch {
    // 偏好持久化失败不应阻断布局。
  }
}

export function readNumberPreference(key, fallback, storage = globalThis.localStorage) {
  const raw = readUiPreference(key, storage)
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) ? value : fallback
}

export function writeNumberPreference(key, value, storage = globalThis.localStorage) {
  writeUiPreference(key, Number.isFinite(value) ? String(Math.round(value)) : '', storage)
}
