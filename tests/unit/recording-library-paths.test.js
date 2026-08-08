import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import {
  assertContainedPath,
  assertRecordingId,
  assertSafeDirectory,
  createLibraryPaths
} from '../../src/main/recording-library/paths.js'

const validId = '3d4527e4-4d47-4aea-a4ba-cd61218bbd27'
let root
let outside

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bf-paths-'))
  outside = await mkdtemp(join(tmpdir(), 'bf-outside-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

describe('recording library paths', () => {
  it('creates the fixed App-managed layout', () => {
    expect(createLibraryPaths(root)).toEqual({
      root: resolve(root),
      index: join(resolve(root), 'library.json'),
      active: join(resolve(root), 'active'),
      trash: join(resolve(root), 'trash'),
      staging: join(resolve(root), 'staging')
    })
  })

  it.each(['../escape', 'not-a-uuid', `${validId}/child`, '', null])('rejects invalid recording id %s', value => {
    expect(() => assertRecordingId(value)).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
  })

  it('accepts and normalizes a UUID', () => {
    expect(assertRecordingId(validId.toUpperCase())).toBe(validId)
  })

  it('rejects a path outside the expected parent', () => {
    expect(() => assertContainedPath(root, join(outside, 'file'))).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(assertContainedPath(root, join(root, validId))).toBe(join(resolve(root), validId))
  })

  it('rejects a symlink recording directory', async () => {
    await symlink(outside, join(root, validId), 'dir')
    await expect(assertSafeDirectory(join(root, validId), { parent: root })).rejects.toMatchObject({ code: 'CORRUPT_MATERIAL' })
  })

  it('accepts a real contained directory and rejects files', async () => {
    const directory = join(root, validId)
    await mkdir(directory)
    expect(await assertSafeDirectory(directory, { parent: root })).toBe(directory)
    const file = join(root, 'file')
    await writeFile(file, 'x')
    await expect(assertSafeDirectory(file, { parent: root })).rejects.toMatchObject({ code: 'CORRUPT_MATERIAL' })
  })
})
