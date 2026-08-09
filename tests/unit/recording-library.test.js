import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { access, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { RecordingLibrary } from '../../src/main/recording-library/index.js'
import { atomicWriteJson } from '../../src/main/recording-library/atomic-file.js'
import { createRecordingMetadata } from '../../src/main/recording-library/metadata.js'
import { createLibraryPaths } from '../../src/main/recording-library/paths.js'

const firstId = '3d4527e4-4d47-4aea-a4ba-cd61218bbd27'
const secondId = 'b6789ee6-dd70-4b26-a829-ff551752e745'
const stagedId = '7ef60b97-118d-4c65-8326-8c784ff9438f'
let root
let outside
let paths
let now

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bf-library-'))
  outside = await mkdtemp(join(tmpdir(), 'bf-library-outside-'))
  paths = createLibraryPaths(root)
  now = vi.fn(() => new Date('2026-08-08T12:20:00.000Z'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

async function seedRecording({ parent, id, createdAt, title, state = 'active', host = 'example.com', durationMs = 42_000, videoStatus = 'complete', visitedHosts = [] }) {
  const directory = join(parent, id)
  await mkdir(directory, { recursive: true })
  const metadata = createRecordingMetadata({ id, createdAt, durationMs, videoStatus })
  metadata.title = title
  metadata.state = state
  metadata.capture.startHost = host
  metadata.capture.visitedHosts = visitedHosts
  if (state === 'trashed') metadata.trashedAt = createdAt
  await atomicWriteJson(join(directory, 'recording.json'), metadata)
  await atomicWriteJson(join(directory, 'timeline.json'), [])
  return metadata
}

async function libraryIndex(libraryRoot) {
  return JSON.parse(await readFile(join(libraryRoot, 'library.json'), 'utf8')).recordings
}

describe('RecordingLibrary initialization and reconciliation', () => {
  it('creates the managed layout and a rebuildable empty index', async () => {
    const library = new RecordingLibrary({ root, now })
    const report = await library.initialize()

    expect(report).toEqual({ adopted: [], repaired: [], errors: [] })
    await Promise.all([paths.active, paths.trash, paths.staging].map(path => access(path)))
    expect(JSON.parse(await readFile(paths.index, 'utf8'))).toEqual({ schemaVersion: 1, revision: 1, recordings: [] })
  })

  it('rejects a symlinked managed root before creating library directories', async () => {
    const symlinkRoot = join(root, 'linked-recordings')
    await symlink(outside, symlinkRoot, 'dir')

    await expect(new RecordingLibrary({ root: symlinkRoot, now }).initialize()).rejects.toMatchObject({ code: 'CORRUPT_MATERIAL' })
    await expect(access(join(outside, 'active'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects symlinked fixed active, trash, or staging directories', async () => {
    for (const name of ['active', 'trash', 'staging']) {
      const libraryRoot = join(root, name)
      await mkdir(libraryRoot)
      await symlink(outside, join(libraryRoot, name), 'dir')

      await expect(new RecordingLibrary({ root: libraryRoot, now }).initialize()).rejects.toMatchObject({ code: 'CORRUPT_MATERIAL' })
    }
  })

  it('rejects a fixed directory replaced by a symlink after initialization', async () => {
    const library = new RecordingLibrary({ root, now })
    await library.initialize()
    await rm(paths.trash, { recursive: true, force: true })
    await symlink(outside, paths.trash, 'dir')
    await seedRecording({ parent: outside, id: firstId, createdAt: '2026-08-08T12:15:00.000Z', title: 'Outside', state: 'trashed' })

    await expect(library.deletePermanently(firstId)).rejects.toMatchObject({ code: 'CORRUPT_MATERIAL' })
    await expect(access(join(outside, firstId, 'recording.json'))).resolves.toBeUndefined()
  })

  it('rebuilds a corrupt index from active and trash directories and repairs location state', async () => {
    await mkdir(paths.root, { recursive: true })
    await writeFile(paths.index, '{broken')
    await seedRecording({ parent: paths.active, id: firstId, createdAt: '2026-08-08T12:15:00.000Z', title: 'Orders', state: 'active' })
    await seedRecording({ parent: paths.trash, id: secondId, createdAt: '2026-08-08T12:10:00.000Z', title: 'Old recording', state: 'active' })

    const library = new RecordingLibrary({ root, now })
    const report = await library.initialize()

    expect(await library.list({ state: 'active' })).toHaveLength(1)
    expect(await library.list({ state: 'trashed' })).toHaveLength(1)
    expect(report.repaired).toContain(secondId)
    expect(JSON.parse(await readFile(join(paths.trash, secondId, 'recording.json'), 'utf8'))).toMatchObject({ state: 'trashed', trashedAt: '2026-08-08T12:20:00.000Z' })
    expect(JSON.parse(await readFile(paths.index, 'utf8'))).toMatchObject({ schemaVersion: 1, revision: 1 })
  })

  it('leaves symlink and malformed staging entries untouched and reports them', async () => {
    await mkdir(paths.staging, { recursive: true })
    await symlink(outside, join(paths.staging, stagedId), 'dir')
    await mkdir(join(paths.staging, firstId))
    const logger = { warn: vi.fn() }

    const report = await new RecordingLibrary({ root, now, logger }).initialize()

    expect(report.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: stagedId, code: 'CORRUPT_MATERIAL' }),
      expect.objectContaining({ id: firstId, code: 'CORRUPT_MATERIAL' })
    ]))
    expect((await lstat(join(paths.staging, stagedId))).isSymbolicLink()).toBe(true)
    expect((await lstat(join(paths.staging, firstId))).isDirectory()).toBe(true)
  })

  it('does not follow a symlinked recording.json during reconciliation', async () => {
    await mkdir(join(paths.active, firstId), { recursive: true })
    const outsideMetadata = join(outside, 'recording.json')
    await atomicWriteJson(outsideMetadata, createRecordingMetadata({ id: firstId, createdAt: '2026-08-08T12:15:00.000Z' }))
    await symlink(outsideMetadata, join(paths.active, firstId, 'recording.json'))

    const report = await new RecordingLibrary({ root, now }).initialize()

    expect(report.errors).toEqual([expect.objectContaining({ id: firstId, code: 'CORRUPT_MATERIAL' })])
    expect(await libraryIndex(root)).toEqual([])
  })

  it('adopts a complete staging recording that already has recording.json', async () => {
    await seedRecording({ parent: paths.staging, id: stagedId, createdAt: '2026-08-08T12:15:00.000Z', title: 'Recovered', state: 'staging' })

    const library = new RecordingLibrary({ root, now })
    const report = await library.initialize()

    expect(report.adopted).toEqual([stagedId])
    expect((await library.get(stagedId))).toMatchObject({ id: stagedId, state: 'active', title: 'Recovered' })
    await expect(access(join(paths.staging, stagedId))).rejects.toMatchObject({ code: 'ENOENT' })
    await access(join(paths.active, stagedId))
  })
})

describe('RecordingLibrary reads and mutations', () => {
  it('sorts newest first, searches title and host, and renames without moving the UUID directory', async () => {
    await seedRecording({ parent: paths.active, id: firstId, createdAt: '2026-08-08T12:15:00.000Z', title: 'Orders dashboard', host: 'shop.example', visitedHosts: ['shop.example', 'billing.partner.example'] })
    await seedRecording({ parent: paths.active, id: secondId, createdAt: '2026-08-08T12:18:00.000Z', title: 'Customer list', host: 'crm.example' })
    const library = new RecordingLibrary({ root, now })
    await library.initialize()

    expect((await library.list({ state: 'active' })).map(item => item.id)).toEqual([secondId, firstId])
    expect((await library.list({ state: 'active', query: 'orders' })).map(item => item.id)).toEqual([firstId])
    expect((await library.list({ state: 'active', query: 'CRM.EXAMPLE' })).map(item => item.id)).toEqual([secondId])
    expect((await library.list({ state: 'active', query: 'billing.partner' })).map(item => item.id)).toEqual([firstId])

    const before = join(paths.active, firstId)
    const updated = await library.rename(firstId, '  订单/查询:*?  ')
    expect(updated).toMatchObject({ id: firstId, title: '订单/查询:*?', absolutePath: before })
    expect((await library.get(firstId)).title).toBe('订单/查询:*?')
    expect((await stat(before)).isDirectory()).toBe(true)
    expect(JSON.parse(await readFile(paths.index, 'utf8')).revision).toBe(2)
  })

  it('rejects invalid state filters, IDs, missing recordings, and invalid titles', async () => {
    const library = new RecordingLibrary({ root, now })
    await library.initialize()
    await expect(library.list({ state: 'staging' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(library.get('../escape')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(library.get(firstId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(library.rename(firstId, '')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('reserves unique staging identities without exposing a user path choice', async () => {
    const ids = [firstId, firstId, secondId]
    const library = new RecordingLibrary({ root, now, randomUUID: () => ids.shift() })
    await library.initialize()
    await mkdir(join(paths.staging, firstId))

    expect(await library.createStagingRecording()).toEqual({ id: secondId, path: join(paths.staging, secondId) })
  })

  it('promotes completed session material into active storage and creates recording metadata', async () => {
    const library = new RecordingLibrary({ root, now, randomUUID: () => stagedId })
    await library.initialize()
    const staging = await library.createStagingRecording()
    await mkdir(join(staging.path, 'video'), { recursive: true })
    await atomicWriteJson(join(staging.path, 'metadata.json'), {
      startedAt: '2026-08-08T12:15:00.000Z',
      durationMs: 12_345,
      startUrl: 'https://example.com/orders'
    })
    await atomicWriteJson(join(staging.path, 'timeline.json'), [{ type: 'navigation', url: 'https://example.com/orders', videoOffsetMs: 0 }])
    await atomicWriteJson(join(staging.path, 'video', 'manifest.json'), { version: 1, state: 'partial', durationMs: 12_000, file: 'recording.mp4' })

    const detail = await library.promote({ id: stagedId, sessionDir: staging.path, promptText: '  查询订单状态  ' })

    expect(detail).toMatchObject({ id: stagedId, state: 'active', title: expect.stringContaining('example.com') })
    expect(detail.metadata.capture).toMatchObject({ status: 'complete', durationMs: 12_345 })
    expect(detail.metadata.video.status).toBe('partial')
    expect(detail.promptStatus).toBe('draft')
    expect(await library.getPrompt(stagedId)).toMatchObject({ text: '查询订单状态', status: 'draft' })
    expect(await readFile(join(paths.active, stagedId, 'prompt.md'), 'utf8')).toBe('查询订单状态\n')
    await access(join(paths.active, stagedId, 'recording.json'))
    await expect(access(staging.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('RecordingLibrary prompts', () => {
  it('saves one prompt atomically, updates index status, and removes the file when cleared', async () => {
    await seedRecording({ parent: paths.active, id: firstId, createdAt: '2026-08-08T12:15:00.000Z', title: 'Orders' })
    const library = new RecordingLibrary({ root, now })
    await library.initialize()

    expect(await library.getPrompt(firstId)).toEqual({ text: '', status: 'empty', updatedAt: null })
    const saved = await library.savePrompt(firstId, '  查询订单状态  ')
    expect(saved).toEqual({ text: '查询订单状态', status: 'draft', updatedAt: '2026-08-08T12:20:00.000Z' })
    expect(await library.getPrompt(firstId)).toEqual(saved)
    expect(await readFile(join(paths.active, firstId, 'prompt.md'), 'utf8')).toBe('查询订单状态\n')
    expect((await library.list({ state: 'active' }))[0].promptStatus).toBe('draft')

    expect(await library.savePrompt(firstId, '   ')).toEqual({ text: '', status: 'empty', updatedAt: null })
    await expect(access(join(paths.active, firstId, 'prompt.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects oversized prompt input before touching the recording', async () => {
    await seedRecording({ parent: paths.active, id: firstId, createdAt: '2026-08-08T12:15:00.000Z', title: 'Orders' })
    const library = new RecordingLibrary({ root, now })
    await library.initialize()

    await expect(library.savePrompt(firstId, '界'.repeat(100_000))).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect((await library.get(firstId)).promptStatus).toBe('empty')
  })

  it('does not follow a symlinked prompt file', async () => {
    await seedRecording({ parent: paths.active, id: firstId, createdAt: '2026-08-08T12:15:00.000Z', title: 'Orders' })
    await writeFile(join(outside, 'secret.md'), 'outside secret')
    await symlink(join(outside, 'secret.md'), join(paths.active, firstId, 'prompt.md'))
    const metadataPath = join(paths.active, firstId, 'recording.json')
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
    metadata.prompt = { status: 'draft', updatedAt: '2026-08-08T12:15:00.000Z' }
    await atomicWriteJson(metadataPath, metadata)
    const library = new RecordingLibrary({ root, now })
    await library.initialize()

    await expect(library.getPrompt(firstId)).rejects.toMatchObject({ code: 'CORRUPT_MATERIAL' })
  })

  it('derives the complete external prompt only for active managed recordings', async () => {
    await seedRecording({ parent: paths.active, id: firstId, createdAt: '2026-08-08T12:15:00.000Z', title: 'Orders' })
    await seedRecording({ parent: paths.trash, id: secondId, createdAt: '2026-08-08T12:10:00.000Z', title: 'Trashed', state: 'trashed' })
    const library = new RecordingLibrary({ root, now })
    await library.initialize()
    await library.savePrompt(firstId, '查询订单状态')

    const result = await library.getExternalAgentPrompt(firstId)
    expect(result.text).toContain(join(paths.active, firstId))
    expect(result.text).toContain('查询订单状态')
    expect(result.recordingId).toBe(firstId)
    expect(await readFile(join(paths.active, firstId, 'prompt.md'), 'utf8')).not.toContain(paths.root)
    await expect(library.getExternalAgentPrompt(secondId)).rejects.toMatchObject({ code: 'INVALID_STATE' })
  })
})

describe('RecordingLibrary recycle bin and export', () => {
  async function seedMaterial(id = firstId) {
    await seedRecording({ parent: paths.active, id, createdAt: '2026-08-08T12:15:00.000Z', title: '订单 查询', host: 'shop.example' })
    await mkdir(join(paths.active, id, 'video'), { recursive: true })
    await writeFile(join(paths.active, id, 'video', 'recording.mp4'), 'video-bytes')
    await writeFile(join(paths.active, id, 'prompt.md'), '查询订单\n')
    const metadataPath = join(paths.active, id, 'recording.json')
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
    metadata.prompt = { status: 'draft', updatedAt: '2026-08-08T12:16:00.000Z' }
    await atomicWriteJson(metadataPath, metadata)
  }

  it('moves to trash, restores unchanged, and permanently deletes only trash entries', async () => {
    await seedMaterial()
    const library = new RecordingLibrary({ root, now })
    await library.initialize()
    const promptBefore = await readFile(join(paths.active, firstId, 'prompt.md'))
    const videoBefore = await readFile(join(paths.active, firstId, 'video', 'recording.mp4'))

    const trashed = await library.trash(firstId)
    expect(trashed).toMatchObject({ state: 'trashed', metadata: { trashedAt: '2026-08-08T12:20:00.000Z' } })
    await expect(access(join(paths.active, firstId))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(paths.trash, firstId, 'prompt.md'))).toEqual(promptBefore)
    await expect(library.deletePermanently(secondId)).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const restored = await library.restore(firstId)
    expect(restored).toMatchObject({ state: 'active', metadata: { trashedAt: null } })
    expect(await readFile(join(paths.active, firstId, 'prompt.md'))).toEqual(promptBefore)
    expect(await readFile(join(paths.active, firstId, 'video', 'recording.mp4'))).toEqual(videoBefore)
    await expect(library.deletePermanently(firstId)).rejects.toMatchObject({ code: 'INVALID_STATE' })

    await library.trash(firstId)
    expect(await library.deletePermanently(firstId)).toEqual({ id: firstId, deleted: true })
    await expect(library.get(firstId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(access(join(paths.trash, firstId))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('exports complete independent copies with deterministic conflict suffixes', async () => {
    await seedMaterial()
    const exportRoot = await mkdtemp(join(tmpdir(), 'bf-exports-'))
    try {
      const library = new RecordingLibrary({ root, now })
      await library.initialize()
      const first = await library.export(firstId, exportRoot)
      const second = await library.export(firstId, exportRoot)

      expect(first.path).toBe(join(exportRoot, '订单-查询-20260808-121500'))
      expect(second.path).toBe(join(exportRoot, '订单-查询-20260808-121500-2'))
      expect(await readFile(join(first.path, 'prompt.md'), 'utf8')).toBe('查询订单\n')
      expect(await readFile(join(first.path, 'video', 'recording.mp4'), 'utf8')).toBe('video-bytes')
      expect(await readFile(join(first.path, 'EXPORT.md'), 'utf8')).toContain('browser-forge')
      expect(await readFile(join(paths.active, firstId, 'video', 'recording.mp4'), 'utf8')).toBe('video-bytes')
    } finally {
      await rm(exportRoot, { recursive: true, force: true })
    }
  })

  it('serializes export-name allocation across different recordings', async () => {
    await seedMaterial()
    const secondMetadata = await seedRecording({ parent: paths.active, id: secondId, createdAt: '2026-08-08T12:15:00.000Z', title: '订单 查询' })
    secondMetadata.capture.startHost = 'example.com'
    await atomicWriteJson(join(paths.active, secondId, 'recording.json'), secondMetadata)
    const exportRoot = await mkdtemp(join(tmpdir(), 'bf-exports-'))
    let releaseFirst
    const firstBlocked = new Promise(resolve => { releaseFirst = resolve })
    let copyCalls = 0
    const copyTree = vi.fn(async (_source, destination) => {
      copyCalls += 1
      await mkdir(destination, { recursive: true })
      if (copyCalls === 1) await firstBlocked
    })
    try {
      const library = new RecordingLibrary({ root, now, copyTree })
      await library.initialize()
      const firstExport = library.export(firstId, exportRoot)
      await vi.waitFor(() => expect(copyCalls).toBe(1))
      const secondExport = library.export(secondId, exportRoot)
      await new Promise(resolve => setTimeout(resolve, 25))

      expect(copyCalls).toBe(1)
      releaseFirst()
      const [first, second] = await Promise.all([firstExport, secondExport])
      expect(first.path).not.toBe(second.path)
      expect(copyCalls).toBe(2)
    } finally {
      releaseFirst?.()
      await rm(exportRoot, { recursive: true, force: true })
    }
  })

  it('rejects symlinks anywhere in an exported recording tree', async () => {
    await seedMaterial()
    await symlink(join(outside, 'secret'), join(paths.active, firstId, 'escape'))
    const exportRoot = await mkdtemp(join(tmpdir(), 'bf-exports-'))
    try {
      const library = new RecordingLibrary({ root, now })
      await library.initialize()
      await expect(library.export(firstId, exportRoot)).rejects.toMatchObject({ code: 'CORRUPT_MATERIAL' })
      expect((await lstat(join(paths.active, firstId, 'escape'))).isSymbolicLink()).toBe(true)
    } finally {
      await rm(exportRoot, { recursive: true, force: true })
    }
  })

  it('blocks same-recording mutations while export holds a stable snapshot', async () => {
    await seedMaterial()
    const exportRoot = await mkdtemp(join(tmpdir(), 'bf-exports-'))
    let releaseCopy
    let copyStarted
    const enteredCopy = new Promise(resolve => { copyStarted = resolve })
    const copyTree = vi.fn(async (_source, destination) => {
      await mkdir(destination, { recursive: true })
      copyStarted()
      await new Promise(resolve => { releaseCopy = resolve })
    })
    try {
      const library = new RecordingLibrary({ root, now, copyTree })
      await library.initialize()
      const exporting = library.export(firstId, exportRoot)
      await enteredCopy

      await expect(library.trash(firstId)).rejects.toMatchObject({ code: 'BUSY' })
      await expect(library.rename(firstId, 'new title')).rejects.toMatchObject({ code: 'BUSY' })
      await expect(library.savePrompt(firstId, 'new prompt')).rejects.toMatchObject({ code: 'BUSY' })
      releaseCopy()
      await exporting
    } finally {
      await rm(exportRoot, { recursive: true, force: true })
    }
  })
})

describe('RecordingLibrary media resolution', () => {
  it('resolves timeline, video, and poster through validated recording IDs', async () => {
    await seedRecording({ parent: paths.active, id: firstId, createdAt: '2026-08-08T12:15:00.000Z', title: 'Orders' })
    await mkdir(join(paths.active, firstId, 'video'), { recursive: true })
    await atomicWriteJson(join(paths.active, firstId, 'timeline.json'), [{ type: 'click', videoOffsetMs: 100 }])
    await writeFile(join(paths.active, firstId, 'video', 'recording.mp4'), 'video')
    await writeFile(join(paths.active, firstId, 'video', 'poster.png'), 'poster')
    const library = new RecordingLibrary({ root, now })
    await library.initialize()

    expect(await library.getTimeline(firstId)).toEqual([{ type: 'click', videoOffsetMs: 100 }])
    const video = await library.getVideo(firstId)
    const poster = await library.getPoster(firstId)
    expect(video).toMatchObject({ path: join(paths.active, firstId, 'video', 'recording.mp4'), status: 'complete', size: 5 })
    expect(poster).toMatchObject({ path: join(paths.active, firstId, 'video', 'poster.png'), size: 6 })
    expect(video.handle).toBeDefined()
    expect(poster.handle).toBeDefined()
    await video.handle.close()
    await poster.handle.close()
  })

  it('keeps an already-open media handle bound to the validated file', async () => {
    await seedRecording({ parent: paths.active, id: firstId, createdAt: '2026-08-08T12:15:00.000Z', title: 'Orders' })
    await mkdir(join(paths.active, firstId, 'video'), { recursive: true })
    const videoPath = join(paths.active, firstId, 'video', 'recording.mp4')
    await writeFile(videoPath, 'inside-video')
    await writeFile(join(outside, 'outside.mp4'), 'outside-video')
    const library = new RecordingLibrary({ root, now })
    await library.initialize()

    const media = await library.getVideo(firstId)
    await rm(videoPath)
    await symlink(join(outside, 'outside.mp4'), videoPath)
    expect(await media.handle.readFile('utf8')).toBe('inside-video')
    await media.handle.close()
  })

  it('reports total material size for destructive confirmation', async () => {
    await seedRecording({ parent: paths.active, id: firstId, createdAt: '2026-08-08T12:15:00.000Z', title: 'Orders' })
    await mkdir(join(paths.active, firstId, 'video'), { recursive: true })
    await writeFile(join(paths.active, firstId, 'video', 'recording.mp4'), Buffer.alloc(2048))
    const library = new RecordingLibrary({ root, now })
    await library.initialize()

    expect((await library.get(firstId)).sizeBytes).toBeGreaterThanOrEqual(2048)
  })

  it('rejects symlinked media and missing posters', async () => {
    await seedRecording({ parent: paths.active, id: firstId, createdAt: '2026-08-08T12:15:00.000Z', title: 'Orders' })
    await mkdir(join(paths.active, firstId, 'video'), { recursive: true })
    await writeFile(join(outside, 'video.mp4'), 'outside')
    await symlink(join(outside, 'video.mp4'), join(paths.active, firstId, 'video', 'recording.mp4'))
    const library = new RecordingLibrary({ root, now })
    await library.initialize()

    await expect(library.getVideo(firstId)).rejects.toMatchObject({ code: 'CORRUPT_MATERIAL' })
    await expect(library.getPoster(firstId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
