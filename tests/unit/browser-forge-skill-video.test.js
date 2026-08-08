import { describe, expect, it } from 'vitest'
import { readFile } from 'fs/promises'

describe('browser-forge managed recording video contract', () => {
  it('documents zero-dependency frame extraction for managed and exported recordings', async () => {
    const skill = await readFile('skills/browser-forge/SKILL.md', 'utf8')
    const video = await readFile('skills/browser-forge/references/video-analysis.md', 'utf8')
    const combined = `${skill}\n${video}`
    expect(skill).toContain('App 管理的录制')
    expect(skill).toContain('导出的录制副本')
    expect(combined).toContain('extract-video-frame.mjs')
    expect(combined).toContain('--recording-dir')
    expect(combined).toContain('--offset-ms')
    expect(combined).toContain('videoOffsetMs')
    expect(skill).toContain('不需要 FFmpeg')
    expect(skill).toContain('Homebrew、Python 或 pip')
  })
})
