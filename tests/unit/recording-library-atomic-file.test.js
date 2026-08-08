import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { atomicWriteJson, atomicWriteText, readJson } from '../../src/main/recording-library/atomic-file.js'

let root

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'bf-atomic-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('recording library atomic files', () => {
  it('atomically replaces JSON and leaves no sibling temporary file', async () => {
    const target = join(root, 'nested', 'recording.json')
    await atomicWriteJson(target, { revision: 1 })
    await atomicWriteJson(target, { revision: 2 })

    expect(await readJson(target)).toEqual({ revision: 2 })
    expect((await readdir(join(root, 'nested'))).filter(name => name.includes('.tmp-'))).toEqual([])
  })

  it('writes text exactly as supplied', async () => {
    const target = join(root, 'prompt.md')
    await atomicWriteText(target, 'guidance\n')
    expect(await readFile(target, 'utf8')).toBe('guidance\n')
  })

  it('returns the caller fallback only for a missing JSON file', async () => {
    expect(await readJson(join(root, 'missing.json'), { fallback: null })).toBeNull()
    await writeFile(join(root, 'broken.json'), '{')
    await expect(readJson(join(root, 'broken.json'), { fallback: null })).rejects.toThrow()
  })
})
