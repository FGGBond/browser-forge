import { lstat } from 'fs/promises'
import { relative, resolve } from 'path'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function libraryError(code, message, options = {}) {
  return Object.assign(new Error(message), { code, ...options })
}

export function createLibraryPaths(root) {
  const resolvedRoot = resolve(String(root))
  return {
    root: resolvedRoot,
    index: resolve(resolvedRoot, 'library.json'),
    active: resolve(resolvedRoot, 'active'),
    trash: resolve(resolvedRoot, 'trash'),
    staging: resolve(resolvedRoot, 'staging')
  }
}

export function assertRecordingId(id) {
  const value = String(id ?? '')
  if (!UUID_PATTERN.test(value)) throw libraryError('INVALID_INPUT', 'Invalid recording id')
  return value.toLowerCase()
}

export function assertContainedPath(parent, candidate) {
  const safeParent = resolve(parent)
  const safeCandidate = resolve(candidate)
  const child = relative(safeParent, safeCandidate)
  if (!child || child === '..' || child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || resolve(safeParent, child) !== safeCandidate) {
    throw libraryError('INVALID_INPUT', 'Path is outside the managed recording root')
  }
  return safeCandidate
}

export async function assertSafeDirectory(candidate, { parent } = {}) {
  const safeCandidate = parent ? assertContainedPath(parent, candidate) : resolve(candidate)
  let info
  try {
    info = await lstat(safeCandidate)
  } catch (error) {
    if (error?.code === 'ENOENT') throw libraryError('NOT_FOUND', 'Recording directory was not found', { cause: error })
    throw error
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw libraryError('CORRUPT_MATERIAL', 'Recording path is not a safe directory')
  }
  return safeCandidate
}
