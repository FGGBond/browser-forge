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

async function seedRecording({ parent, id, createdAt, title, state = 'active', host = 'example.com', durationMs = 42_000, videoStatus = 'complete' }) {
  const directory = join(parent, id)
  await mkdir(directory, { recursive: true })
  const metadata = createRecordingMetadata({ id, createdAt, durationMs, videoStatus })
  metadata.title = title
  metadata.state = state
  metadata.capture.startHost = host
  if (state === 'trashed') metadata.trashedAt = createdAt
  await atomicWriteJson(join(directory, 'recording.json'), metadata)
  await atomicWriteJson(join(directory, 'timeline.json'), [])
  return metadata
}

describe('RecordingLibrary initialization and reconciliation', () => {
  it('creates the managed layout and a rebuildable empty index', async () => {
    const library = new RecordingLibrary({ root, now })
    const report = await library.initialize()

    expect(report).toEqual({ adopted: [], repaired: [], errors: [] })
    await Promise.all([paths.active, paths.trash, paths.staging].map(path => access(path)))
    expect(JSON.parse(await readFile(paths.index, 'utf8'))).toEqual({ schemaVersion: 1, revision: 1, recordings: [] })
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
    await seedRecording({ parent: paths.active, id: firstId, createdAt: '2026-08-08T12:15:00.000Z', title: 'Orders dashboard', host: 'shop.example' })
    await seedRecording({ parent: paths.active, id: secondId, createdAt: '2026-08-08T12:18:00.000Z', title: 'Customer list', host: 'crm.example' })
    const library = new RecordingLibrary({ root, now })
    await library.initialize()

    expect((await library.list({ state: 'active' })).map(item => item.id)).toEqual([secondId, firstId])
    expect((await library.list({ state: 'active', query: 'orders' })).map(item => item.id)).toEqual([firstId])
    expect((await library.list({ state: 'active', query: 'CRM.EXAMPLE' })).map(item => item.id)).toEqual([secondId])

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

    const detail = await library.promote({ id: stagedId, sessionDir: staging.path })

    expect(detail).toMatchObject({ id: stagedId, state: 'active', title: expect.stringContaining('example.com') })
    expect(detail.metadata.capture).toMatchObject({ status: 'complete', durationMs: 12_345 })
    expect(detail.metadata.video.status).toBe('partial')
    await access(join(paths.active, stagedId, 'recording.json'))
    await expect(access(staging.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
