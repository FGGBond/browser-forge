// tests/unit/skill-installer.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { installSkill } from '../../src/main/skill-installer.js'
import { mkdir, copyFile, writeFile, readFile, readdir } from 'fs/promises'
import { existsSync } from 'fs'

vi.mock('fs/promises')
vi.mock('fs')

const MOCK_SRC = '/app/skill'
const MOCK_DST = '/home/.claude/plugins/user/browser-forge'

beforeEach(() => vi.clearAllMocks())

describe('installSkill', () => {
  it('目标不存在时执行全量复制', async () => {
    vi.mocked(existsSync).mockReturnValue(false)
    mkdir.mockResolvedValue(undefined)
    readdir.mockResolvedValue([])
    writeFile.mockResolvedValue(undefined)

    const result = await installSkill({ srcDir: MOCK_SRC, dstDir: MOCK_DST, version: '0.1.0' })

    expect(result.action).toBe('installed')
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining('version'),
      '0.1.0'
    )
  })

  it('版本相同时跳过', async () => {
    vi.mocked(existsSync).mockReturnValue(true)
    readFile.mockResolvedValue('0.1.0')

    const result = await installSkill({ srcDir: MOCK_SRC, dstDir: MOCK_DST, version: '0.1.0' })

    expect(result.action).toBe('skipped')
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('版本不同时执行覆盖更新', async () => {
    vi.mocked(existsSync).mockReturnValue(true)
    readFile.mockResolvedValue('0.0.1')
    mkdir.mockResolvedValue(undefined)
    readdir.mockResolvedValue([])
    writeFile.mockResolvedValue(undefined)

    const result = await installSkill({ srcDir: MOCK_SRC, dstDir: MOCK_DST, version: '0.1.0' })

    expect(result.action).toBe('updated')
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining('version'),
      '0.1.0'
    )
  })
})
