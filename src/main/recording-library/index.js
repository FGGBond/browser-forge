import { randomUUID as defaultRandomUUID } from 'crypto'
import * as defaultFs from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { join, resolve } from 'path'
import { atomicWriteJson, atomicWriteText } from './atomic-file.js'
import {
  MAX_RECORDING_TITLE_LENGTH,
  createRecordingMetadata,
  normalizeRecordingMetadata,
  toLibraryEntry
} from './metadata.js'
import { buildExternalAgentPrompt } from './external-agent-prompt.js'
import {
  assertContainedPath,
  assertRecordingId,
  assertSafeDirectory,
  createLibraryPaths,
  libraryError
} from './paths.js'

const LIST_STATES = new Set(['active', 'trashed'])
const LOCATION_DIRECTORY = { active: 'active', trashed: 'trash' }

export class RecordingLibrary {
  constructor({ root, fs = defaultFs, now = () => new Date(), randomUUID = defaultRandomUUID, logger = console, copyTree } = {}) {
    if (!root) throw libraryError('INVALID_INPUT', 'RecordingLibrary requires a root')
    this.paths = createLibraryPaths(root)
    this.fs = fs
    this.now = now
    this.randomUUID = randomUUID
    this.logger = logger
    this.copyTree = copyTree || ((source, destination) => copyTreeWithoutSymlinks(source, destination, this.fs))
    this.busyRecordings = new Set()
    this.exportDestinationTails = new Map()
    this.managedDirectories = new Map()
    this.index = { schemaVersion: 1, revision: 0, recordings: [] }
    this.mutationTail = Promise.resolve()
    this.initialized = false
  }

  getPaths() {
    return { ...this.paths }
  }

  async initialize() {
    await this.#ensureManagedDirectory(this.paths.root)
    await Promise.all([this.paths.active, this.paths.trash, this.paths.staging].map(path => this.#ensureManagedDirectory(path, this.paths.root)))
    return this.#enqueue(async () => {
      const previousRevision = await this.#readIndexRevision()
      const report = { adopted: [], repaired: [], errors: [] }
      const entries = []

      await this.#scanLocation({ directory: this.paths.active, state: 'active', entries, report })
      await this.#scanLocation({ directory: this.paths.trash, state: 'trashed', entries, report })
      await this.#adoptStaging({ entries, report })

      this.index = {
        schemaVersion: 1,
        revision: previousRevision > 0 ? previousRevision + 1 : 1,
        recordings: this.#sortEntries(entries)
      }
      await atomicWriteJson(this.paths.index, this.index)
      this.initialized = true
      return report
    })
  }

  async createStagingRecording() {
    this.#requireInitialized()
    return this.#enqueue(async () => {
      await Promise.all([this.paths.active, this.paths.trash, this.paths.staging].map(path => this.#assertManagedDirectory(path)))
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const id = assertRecordingId(this.randomUUID())
        const candidates = [this.paths.active, this.paths.trash, this.paths.staging].map(parent => join(parent, id))
        const occupied = (await Promise.all(candidates.map(path => this.#exists(path)))).some(Boolean)
        if (!occupied) return { id, path: join(this.paths.staging, id) }
      }
      throw libraryError('BUSY', 'Unable to allocate a unique recording id')
    })
  }

  async promote({ id, sessionDir, promptText = '' }) {
    this.#requireInitialized()
    const recordingId = assertRecordingId(id)
    const promptInput = String(promptText ?? '')
    if (Buffer.byteLength(promptInput, 'utf8') > 256 * 1024) throw libraryError('INVALID_INPUT', 'Prompt is too large')
    const normalizedPrompt = promptInput.trim()
    return this.#enqueue(async () => {
      await this.#assertManagedDirectory(this.paths.staging)
      await this.#assertManagedDirectory(this.paths.active)
      const expectedPath = join(this.paths.staging, recordingId)
      if (resolve(sessionDir) !== expectedPath) throw libraryError('INVALID_INPUT', 'Session directory does not match the recording id')
      await assertSafeDirectory(expectedPath, { parent: this.paths.staging })
      const target = join(this.paths.active, recordingId)
      if (await this.#exists(target)) throw libraryError('INVALID_STATE', 'Recording is already active')

      const capture = await this.#readRequiredJson(join(expectedPath, 'metadata.json'), 'Capture metadata is missing')
      const timeline = await this.#readRequiredJson(join(expectedPath, 'timeline.json'), 'Timeline is missing')
      if (!Array.isArray(timeline)) throw libraryError('CORRUPT_MATERIAL', 'Timeline must be an array')
      const videoManifest = await this.#readSafeJson(join(expectedPath, 'video', 'manifest.json'), { required: false, message: 'Video manifest is invalid' })
      const createdAt = capture.startedAt || capture.createdAt || this.now()
      const titleTimeline = timeline.length > 0 ? timeline : [{ type: 'navigation', url: capture.startUrl }]
      let metadata = createRecordingMetadata({
        id: recordingId,
        createdAt,
        timeline: titleTimeline,
        durationMs: capture.durationMs,
        captureStatus: capture.status || 'complete',
        videoStatus: videoManifest?.state || 'unavailable'
      })
      if (normalizedPrompt) {
        const updatedAt = this.now().toISOString()
        await atomicWriteText(join(expectedPath, 'prompt.md'), `${normalizedPrompt}\n`)
        metadata = { ...metadata, updatedAt, prompt: { status: 'draft', updatedAt } }
      }
      await atomicWriteJson(join(expectedPath, 'recording.json'), metadata)
      await this.fs.rename(expectedPath, target)
      await this.#replaceIndexEntry(toLibraryEntry(metadata))
      return this.#detail(target, metadata)
    })
  }

  async list({ state = 'active', query = '' } = {}) {
    this.#requireInitialized()
    if (!LIST_STATES.has(state)) throw libraryError('INVALID_INPUT', 'Invalid recording state filter')
    const needle = String(query || '').trim().toLocaleLowerCase()
    return this.#sortEntries(this.index.recordings
      .filter(entry => entry.state === state)
      .filter(entry => !needle || `${entry.title}\n${entry.startHost || ''}`.toLocaleLowerCase().includes(needle)))
      .map(entry => ({ ...entry }))
  }

  async get(id) {
    this.#requireInitialized()
    const recording = await this.#resolve(id, ['active', 'trashed'])
    return { ...this.#detail(recording.path, recording.metadata), sizeBytes: await this.#calculateTreeSize(recording.path) }
  }

  async getTimeline(id) {
    this.#requireInitialized()
    const recording = await this.#resolve(id, ['active', 'trashed'])
    const timeline = await this.#readRequiredJson(join(recording.path, 'timeline.json'), 'Timeline is missing or invalid')
    if (!Array.isArray(timeline)) throw libraryError('CORRUPT_MATERIAL', 'Timeline must be an array')
    return timeline
  }

  async getVideo(id) {
    this.#requireInitialized()
    const recording = await this.#resolve(id, ['active', 'trashed'])
    if (!['complete', 'partial'].includes(recording.metadata.video.status)) throw libraryError('INVALID_STATE', 'Recording has no playable video')
    const media = await this.#openSafeFile(recording.path, join('video', 'recording.mp4'), { required: true, message: 'Video material is missing or invalid' })
    return { ...media, status: recording.metadata.video.status }
  }

  async getPoster(id) {
    this.#requireInitialized()
    const recording = await this.#resolve(id, ['active', 'trashed'])
    const media = await this.#openSafeFile(recording.path, join('video', 'poster.png'), { required: false, message: 'Poster material is invalid' })
    if (!media) throw libraryError('NOT_FOUND', 'Poster was not generated')
    return media
  }

  async getPrompt(id) {
    this.#requireInitialized()
    const recording = await this.#resolveActive(id)
    if (recording.metadata.prompt.status !== 'draft') return { text: '', status: 'empty', updatedAt: null }
    const text = await this.#readSafeText(join(recording.path, 'prompt.md'), 'Prompt material is invalid')
    return {
      text: text.replace(/\n$/, ''),
      status: 'draft',
      updatedAt: recording.metadata.prompt.updatedAt
    }
  }

  async savePrompt(id, text) {
    this.#requireInitialized()
    const input = String(text ?? '')
    if (Buffer.byteLength(input, 'utf8') > 256 * 1024) throw libraryError('INVALID_INPUT', 'Prompt is too large')
    const normalized = input.trim()
    return this.#enqueue(async () => {
      this.#assertNotBusy(id)
      const recording = await this.#resolveActive(id)
      const promptPath = join(recording.path, 'prompt.md')
      if (normalized) {
        await atomicWriteText(promptPath, `${normalized}\n`)
      } else {
        await this.fs.unlink(promptPath).catch(error => {
          if (error?.code !== 'ENOENT') throw error
        })
      }
      const updatedAt = normalized ? this.now().toISOString() : null
      const metadata = {
        ...recording.metadata,
        updatedAt: this.now().toISOString(),
        prompt: { status: normalized ? 'draft' : 'empty', updatedAt }
      }
      await atomicWriteJson(join(recording.path, 'recording.json'), metadata)
      await this.#replaceIndexEntry(toLibraryEntry(metadata))
      return { text: normalized, status: metadata.prompt.status, updatedAt }
    })
  }

  async getExternalAgentPrompt(id) {
    this.#requireInitialized()
    const recording = await this.#resolveActive(id)
    const prompt = recording.metadata.prompt.status === 'draft'
      ? await this.#readSafeText(join(recording.path, 'prompt.md'), 'Prompt material is invalid')
      : ''
    return {
      recordingId: recording.metadata.id,
      text: buildExternalAgentPrompt({ recordingPath: recording.path, guidance: prompt })
    }
  }

  async trash(id) {
    this.#requireInitialized()
    const recordingId = assertRecordingId(id)
    return this.#enqueue(async () => {
      this.#assertNotBusy(recordingId)
      const source = await this.#resolveInState(recordingId, 'active')
      await this.#assertManagedDirectory(this.paths.trash)
      const target = join(this.paths.trash, recordingId)
      await this.fs.rename(source.path, target)
      const timestamp = this.now().toISOString()
      const metadata = { ...source.metadata, state: 'trashed', trashedAt: timestamp, updatedAt: timestamp }
      await atomicWriteJson(join(target, 'recording.json'), metadata)
      await this.#replaceIndexEntry(toLibraryEntry(metadata))
      return this.#detail(target, metadata)
    })
  }

  async restore(id) {
    this.#requireInitialized()
    const recordingId = assertRecordingId(id)
    return this.#enqueue(async () => {
      this.#assertNotBusy(recordingId)
      const source = await this.#resolveInState(recordingId, 'trashed')
      await this.#assertManagedDirectory(this.paths.active)
      const target = join(this.paths.active, recordingId)
      await this.fs.rename(source.path, target)
      const metadata = { ...source.metadata, state: 'active', trashedAt: null, updatedAt: this.now().toISOString() }
      await atomicWriteJson(join(target, 'recording.json'), metadata)
      await this.#replaceIndexEntry(toLibraryEntry(metadata))
      return this.#detail(target, metadata)
    })
  }

  async deletePermanently(id) {
    this.#requireInitialized()
    const recordingId = assertRecordingId(id)
    return this.#enqueue(async () => {
      this.#assertNotBusy(recordingId)
      const recording = await this.#resolveInState(recordingId, 'trashed')
      await assertSafeDirectory(recording.path, { parent: this.paths.trash })
      try {
        await this.fs.rm(recording.path, { recursive: true, force: false })
      } catch (error) {
        throw toLibraryError(error, 'FILESYSTEM_FAILURE', 'Could not permanently delete recording')
      }
      await this.#removeIndexEntry(recordingId)
      return { id: recordingId, deleted: true }
    })
  }

  async export(id, destinationRoot) {
    this.#requireInitialized()
    const recordingId = assertRecordingId(id)
    const recording = await this.#enqueue(async () => {
      this.#assertNotBusy(recordingId)
      const resolved = await this.#resolveInState(recordingId, 'active')
      this.busyRecordings.add(recordingId)
      return resolved
    })

    let temporaryPath
    try {
      const safeDestination = await assertSafeDirectory(destinationRoot)
      return await this.#withExportDestinationLock(safeDestination, async () => {
        const finalPath = await this.#nextExportPath(safeDestination, recording.metadata)
        temporaryPath = `${finalPath}.browser-forge-exporting`
        await this.fs.rm(temporaryPath, { recursive: true, force: true })
        await this.copyTree(recording.path, temporaryPath)
        await atomicWriteText(join(temporaryPath, 'EXPORT.md'), exportReadme())
        await this.fs.rename(temporaryPath, finalPath)
        temporaryPath = null
        return { path: finalPath }
      })
    } catch (error) {
      if (temporaryPath) await this.fs.rm(temporaryPath, { recursive: true, force: true }).catch(() => {})
      if (error?.code && ['INVALID_INPUT', 'INVALID_STATE', 'NOT_FOUND', 'BUSY', 'CORRUPT_MATERIAL'].includes(error.code)) throw error
      throw toLibraryError(error, 'FILESYSTEM_FAILURE', 'Could not export recording')
    } finally {
      this.busyRecordings.delete(recordingId)
    }
  }

  async rename(id, title) {
    this.#requireInitialized()
    const trimmed = String(title ?? '').trim()
    if (!trimmed || trimmed.length > MAX_RECORDING_TITLE_LENGTH) throw libraryError('INVALID_INPUT', 'Invalid title')
    return this.#enqueue(async () => {
      this.#assertNotBusy(id)
      const recording = await this.#resolve(id, ['active', 'trashed'])
      const metadata = { ...recording.metadata, title: trimmed, updatedAt: this.now().toISOString() }
      await atomicWriteJson(join(recording.path, 'recording.json'), metadata)
      await this.#replaceIndexEntry(toLibraryEntry(metadata))
      return this.#detail(recording.path, metadata)
    })
  }

  async #ensureManagedDirectory(path, parent = null) {
    try {
      await this.fs.mkdir(path, { recursive: parent === null })
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    const info = await this.fs.lstat(path)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw libraryError('CORRUPT_MATERIAL', 'Managed recording directory is not a safe directory')
    }
    if (parent) assertContainedPath(parent, path)
    const realpath = await this.fs.realpath(path)
    this.managedDirectories.set(path, { realpath, dev: info.dev, ino: info.ino })
  }

  async #assertManagedDirectory(path) {
    const expected = this.managedDirectories.get(path)
    if (!expected) throw libraryError('INVALID_STATE', 'Managed recording directory identity is unavailable')
    let info
    let realpath
    try {
      info = await this.fs.lstat(path)
      realpath = await this.fs.realpath(path)
    } catch (error) {
      throw libraryError('CORRUPT_MATERIAL', 'Managed recording directory changed after initialization', { cause: error })
    }
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      realpath !== expected.realpath ||
      (Number.isInteger(expected.dev) && Number.isInteger(info.dev) && info.dev !== expected.dev) ||
      (Number.isInteger(expected.ino) && Number.isInteger(info.ino) && info.ino !== expected.ino)
    ) {
      throw libraryError('CORRUPT_MATERIAL', 'Managed recording directory changed after initialization')
    }
  }

  #withExportDestinationLock(destination, operation) {
    const previous = this.exportDestinationTails.get(destination) || Promise.resolve()
    const run = previous.catch(() => {}).then(operation)
    const tail = run.catch(() => {})
    this.exportDestinationTails.set(destination, tail)
    return run.finally(() => {
      if (this.exportDestinationTails.get(destination) === tail) this.exportDestinationTails.delete(destination)
    })
  }

  #requireInitialized() {
    if (!this.initialized) throw libraryError('INVALID_STATE', 'Recording library is not initialized')
  }

  #enqueue(operation) {
    const run = this.mutationTail.then(operation, operation)
    this.mutationTail = run.catch(() => {})
    return run
  }

  async #readIndexRevision() {
    try {
      const index = await this.#readSafeJson(this.paths.index, { required: false, message: 'Library index is invalid' })
      if (index?.schemaVersion !== 1 || !Number.isSafeInteger(index.revision) || index.revision < 0 || !Array.isArray(index.recordings)) return 0
      return index.revision
    } catch {
      return 0
    }
  }

  async #scanLocation({ directory, state, entries, report }) {
    const children = await this.fs.readdir(directory, { withFileTypes: true })
    for (const child of children) {
      const id = child.name
      try {
        assertRecordingId(id)
        if (child.isSymbolicLink() || !child.isDirectory()) throw libraryError('CORRUPT_MATERIAL', 'Recording entry is not a safe directory')
        const path = join(directory, id)
        await assertSafeDirectory(path, { parent: directory })
        const original = await this.#readRequiredJson(join(path, 'recording.json'), 'Recording metadata is missing')
        if (String(original.id).toLowerCase() !== id.toLowerCase()) throw libraryError('CORRUPT_MATERIAL', 'Directory identity does not match recording metadata')
        const normalized = normalizeRecordingMetadata(original, state, { now: this.now() })
        if (JSON.stringify(original) !== JSON.stringify(normalized)) {
          await atomicWriteJson(join(path, 'recording.json'), normalized)
          report.repaired.push(id)
        }
        entries.push(toLibraryEntry(normalized))
      } catch (error) {
        this.#reportError(report, id, error)
      }
    }
  }

  async #adoptStaging({ entries, report }) {
    const children = await this.fs.readdir(this.paths.staging, { withFileTypes: true })
    for (const child of children) {
      const id = child.name
      try {
        assertRecordingId(id)
        if (child.isSymbolicLink() || !child.isDirectory()) throw libraryError('CORRUPT_MATERIAL', 'Staging entry is not a safe directory')
        const source = join(this.paths.staging, id)
        await assertSafeDirectory(source, { parent: this.paths.staging })
        const original = await this.#readRequiredJson(join(source, 'recording.json'), 'Incomplete staging recording')
        if (String(original.id).toLowerCase() !== id.toLowerCase()) throw libraryError('CORRUPT_MATERIAL', 'Directory identity does not match recording metadata')
        const metadata = normalizeRecordingMetadata(original, 'active', { now: this.now() })
        const target = join(this.paths.active, id)
        if (await this.#exists(target)) throw libraryError('INVALID_STATE', 'Active recording already exists')
        await atomicWriteJson(join(source, 'recording.json'), metadata)
        await this.fs.rename(source, target)
        entries.push(toLibraryEntry(metadata))
        report.adopted.push(id)
      } catch (error) {
        this.#reportError(report, id, error)
      }
    }
  }

  #reportError(report, id, error) {
    const code = error?.code && ['INVALID_INPUT', 'INVALID_STATE', 'CORRUPT_MATERIAL', 'NOT_FOUND'].includes(error.code)
      ? error.code
      : 'CORRUPT_MATERIAL'
    const item = { id, code, message: error?.message || 'Unreadable recording material' }
    report.errors.push(item)
    this.logger?.warn?.('[browser-forge] recording reconciliation warning', item)
  }

  #assertNotBusy(id) {
    const recordingId = assertRecordingId(id)
    if (this.busyRecordings.has(recordingId)) throw libraryError('BUSY', 'Recording is busy')
  }

  async #resolveInState(id, desiredState) {
    const recordingId = assertRecordingId(id)
    try {
      return await this.#resolve(recordingId, [desiredState])
    } catch (error) {
      if (error?.code !== 'NOT_FOUND') throw error
      const otherState = desiredState === 'active' ? 'trashed' : 'active'
      try {
        await this.#resolve(recordingId, [otherState])
      } catch (otherError) {
        if (otherError?.code === 'NOT_FOUND') throw error
        throw otherError
      }
      throw libraryError('INVALID_STATE', `Recording must be ${desiredState}`)
    }
  }

  async #nextExportPath(destinationRoot, metadata) {
    const baseName = `${sanitizeExportName(metadata.title)}-${formatExportTimestamp(metadata.createdAt)}`
    for (let suffix = 1; suffix < 10_000; suffix += 1) {
      const name = suffix === 1 ? baseName : `${baseName}-${suffix}`
      const candidate = assertContainedPath(destinationRoot, join(destinationRoot, name))
      if (!await this.#exists(candidate) && !await this.#exists(`${candidate}.browser-forge-exporting`)) return candidate
    }
    throw libraryError('BUSY', 'Unable to allocate an export directory')
  }

  async #resolveActive(id) {
    try {
      return await this.#resolveInState(id, 'active')
    } catch (error) {
      if (error?.code === 'INVALID_STATE') throw libraryError('INVALID_STATE', 'Recording must be restored before editing or analyzing its prompt')
      throw error
    }
  }

  async #resolve(id, states) {
    const recordingId = assertRecordingId(id)
    for (const state of states) {
      const parent = this.paths[LOCATION_DIRECTORY[state]]
      await this.#assertManagedDirectory(parent)
      const path = assertContainedPath(parent, join(parent, recordingId))
      if (!await this.#exists(path)) continue
      await assertSafeDirectory(path, { parent })
      const original = await this.#readRequiredJson(join(path, 'recording.json'), 'Recording metadata is missing')
      if (String(original.id).toLowerCase() !== recordingId) throw libraryError('CORRUPT_MATERIAL', 'Directory identity does not match recording metadata')
      const metadata = normalizeRecordingMetadata(original, state, { now: this.now() })
      return { path, metadata }
    }
    throw libraryError('NOT_FOUND', 'Recording was not found')
  }

  async #calculateTreeSize(path) {
    const info = await this.fs.lstat(path)
    if (info.isSymbolicLink()) throw libraryError('CORRUPT_MATERIAL', 'Recording contains a symlink')
    if (info.isFile()) return info.size
    if (!info.isDirectory()) throw libraryError('CORRUPT_MATERIAL', 'Recording contains unsupported material')
    const children = await this.fs.readdir(path)
    let total = 0
    for (const child of children) total += await this.#calculateTreeSize(join(path, child))
    return total
  }

  async #openSafeFile(recordingPath, relativePath, { required, message }) {
    const path = await this.#resolveSafeFile(recordingPath, relativePath, { required, message })
    if (!path) return null
    let handle
    try {
      handle = await this.fs.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0))
      const info = await handle.stat()
      if (!info.isFile()) throw libraryError('CORRUPT_MATERIAL', message)
      return { path, handle, size: info.size }
    } catch (error) {
      await handle?.close().catch(() => {})
      if (error?.code === 'ELOOP') throw libraryError('CORRUPT_MATERIAL', message, { cause: error })
      throw error
    }
  }

  async #resolveSafeFile(recordingPath, relativePath, { required, message }) {
    const path = assertContainedPath(recordingPath, join(recordingPath, relativePath))
    let info
    try {
      info = await this.fs.lstat(path)
    } catch (error) {
      if (error?.code === 'ENOENT' && !required) return null
      if (error?.code === 'ENOENT') throw libraryError('CORRUPT_MATERIAL', message, { cause: error })
      throw error
    }
    if (info.isSymbolicLink() || !info.isFile()) throw libraryError('CORRUPT_MATERIAL', message)
    return path
  }

  async #readRequiredJson(path, message) {
    return this.#readSafeJson(path, { required: true, message })
  }

  async #readSafeText(path, message) {
    let info
    try {
      info = await this.fs.lstat(path)
    } catch (error) {
      if (error?.code === 'ENOENT') throw libraryError('CORRUPT_MATERIAL', message, { cause: error })
      throw error
    }
    if (info.isSymbolicLink() || !info.isFile()) throw libraryError('CORRUPT_MATERIAL', message)
    let handle
    try {
      handle = await this.fs.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0))
      const openedInfo = await handle.stat()
      if (!openedInfo.isFile()) throw libraryError('CORRUPT_MATERIAL', message)
      return await handle.readFile('utf8')
    } catch (error) {
      if (error?.code === 'ELOOP') throw libraryError('CORRUPT_MATERIAL', message, { cause: error })
      throw error
    } finally {
      await handle?.close().catch(() => {})
    }
  }

  async #readSafeJson(path, { required, message }) {
    let info
    try {
      info = await this.fs.lstat(path)
    } catch (error) {
      if (error?.code === 'ENOENT' && !required) return null
      if (error?.code === 'ENOENT') throw libraryError('CORRUPT_MATERIAL', message, { cause: error })
      throw error
    }
    if (info.isSymbolicLink() || !info.isFile()) throw libraryError('CORRUPT_MATERIAL', message)

    let handle
    try {
      handle = await this.fs.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0))
      const openedInfo = await handle.stat()
      if (!openedInfo.isFile()) throw libraryError('CORRUPT_MATERIAL', message)
      return JSON.parse(await handle.readFile('utf8'))
    } catch (error) {
      if (error?.code === 'ELOOP' || error instanceof SyntaxError) throw libraryError('CORRUPT_MATERIAL', message, { cause: error })
      throw error
    } finally {
      await handle?.close().catch(() => {})
    }
  }

  async #replaceIndexEntry(entry) {
    const recordings = this.index.recordings.filter(item => item.id !== entry.id)
    recordings.push(entry)
    this.index = {
      schemaVersion: 1,
      revision: this.index.revision + 1,
      recordings: this.#sortEntries(recordings)
    }
    await atomicWriteJson(this.paths.index, this.index)
  }

  async #removeIndexEntry(id) {
    this.index = {
      schemaVersion: 1,
      revision: this.index.revision + 1,
      recordings: this.index.recordings.filter(item => item.id !== id)
    }
    await atomicWriteJson(this.paths.index, this.index)
  }

  #sortEntries(entries) {
    return [...entries].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
  }

  #detail(path, metadata) {
    return {
      ...toLibraryEntry(metadata),
      metadata,
      absolutePath: path
    }
  }

  async #exists(path) {
    try {
      await this.fs.lstat(path)
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
  }
}


async function copyTreeWithoutSymlinks(source, destination, fs) {
  const sourceInfo = await fs.lstat(source)
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) throw libraryError('CORRUPT_MATERIAL', 'Unsafe export source')
  await fs.mkdir(destination, { recursive: false })
  const children = await fs.readdir(source, { withFileTypes: true })
  for (const child of children) {
    const sourcePath = join(source, child.name)
    const destinationPath = join(destination, child.name)
    const info = await fs.lstat(sourcePath)
    if (info.isSymbolicLink()) throw libraryError('CORRUPT_MATERIAL', 'Export source contains a symlink')
    if (info.isDirectory()) await copyTreeWithoutSymlinks(sourcePath, destinationPath, fs)
    else if (info.isFile()) await fs.copyFile(sourcePath, destinationPath)
    else throw libraryError('CORRUPT_MATERIAL', 'Export source contains unsupported material')
  }
}

function sanitizeExportName(title) {
  const normalized = String(title || '').normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .slice(0, 60)
  return normalized || 'browser-forge-recording'
}

function formatExportTimestamp(value) {
  const iso = new Date(value).toISOString()
  return `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}`
}

function exportReadme() {
  return `# Browser Forge Recording Export\n\nThis directory is an independent copy of a Browser Forge recording. Supply this directory to the installed browser-forge skill. Use timeline.json event videoOffsetMs values with the bundled extract-video-frame.mjs tool when visual context is needed.\n`
}

function toLibraryError(error, code, message) {
  if (error?.code && ['INVALID_INPUT', 'INVALID_STATE', 'NOT_FOUND', 'BUSY', 'CORRUPT_MATERIAL'].includes(error.code)) return error
  return libraryError(code, message, { cause: error })
}
