import { randomUUID as defaultRandomUUID } from 'crypto'
import * as defaultFs from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { join, resolve } from 'path'
import { atomicWriteJson } from './atomic-file.js'
import {
  MAX_RECORDING_TITLE_LENGTH,
  createRecordingMetadata,
  normalizeRecordingMetadata,
  toLibraryEntry
} from './metadata.js'
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
  constructor({ root, fs = defaultFs, now = () => new Date(), randomUUID = defaultRandomUUID, logger = console } = {}) {
    if (!root) throw libraryError('INVALID_INPUT', 'RecordingLibrary requires a root')
    this.paths = createLibraryPaths(root)
    this.fs = fs
    this.now = now
    this.randomUUID = randomUUID
    this.logger = logger
    this.index = { schemaVersion: 1, revision: 0, recordings: [] }
    this.mutationTail = Promise.resolve()
    this.initialized = false
  }

  getPaths() {
    return { ...this.paths }
  }

  async initialize() {
    await Promise.all([this.paths.root, this.paths.active, this.paths.trash, this.paths.staging].map(path => this.fs.mkdir(path, { recursive: true })))
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
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const id = assertRecordingId(this.randomUUID())
        const candidates = [this.paths.active, this.paths.trash, this.paths.staging].map(parent => join(parent, id))
        const occupied = (await Promise.all(candidates.map(path => this.#exists(path)))).some(Boolean)
        if (!occupied) return { id, path: join(this.paths.staging, id) }
      }
      throw libraryError('BUSY', 'Unable to allocate a unique recording id')
    })
  }

  async promote({ id, sessionDir }) {
    this.#requireInitialized()
    const recordingId = assertRecordingId(id)
    return this.#enqueue(async () => {
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
      const metadata = createRecordingMetadata({
        id: recordingId,
        createdAt,
        timeline: titleTimeline,
        durationMs: capture.durationMs,
        captureStatus: capture.status || 'complete',
        videoStatus: videoManifest?.state || 'unavailable'
      })
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
    return this.#detail(recording.path, recording.metadata)
  }

  async rename(id, title) {
    this.#requireInitialized()
    const trimmed = String(title ?? '').trim()
    if (!trimmed || trimmed.length > MAX_RECORDING_TITLE_LENGTH) throw libraryError('INVALID_INPUT', 'Invalid title')
    return this.#enqueue(async () => {
      const recording = await this.#resolve(id, ['active', 'trashed'])
      const metadata = { ...recording.metadata, title: trimmed, updatedAt: this.now().toISOString() }
      await atomicWriteJson(join(recording.path, 'recording.json'), metadata)
      await this.#replaceIndexEntry(toLibraryEntry(metadata))
      return this.#detail(recording.path, metadata)
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

  async #resolve(id, states) {
    const recordingId = assertRecordingId(id)
    for (const state of states) {
      const parent = this.paths[LOCATION_DIRECTORY[state]]
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

  async #readRequiredJson(path, message) {
    return this.#readSafeJson(path, { required: true, message })
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
