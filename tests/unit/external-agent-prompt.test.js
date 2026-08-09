import { describe, expect, it } from 'vitest'
import { GUIDED_PROMPT_TEMPLATE, buildExternalAgentPrompt } from '../../src/main/recording-library/external-agent-prompt.js'

describe('external Agent prompt domain', () => {
  it('exports the complete guided Chinese template', () => {
    for (const heading of ['我在这段录制中完成了：', '我希望生成的 Browser Forge skill 实现：', '调用这个 skill 时，用户会提供：', 'skill 应返回或产生：', '成功标准：', '限制和注意事项：']) {
      expect(GUIDED_PROMPT_TEMPLATE).toContain(heading)
    }
  })

  it('builds complete instructions from a path and user guidance', () => {
    const recordingPath = '/Users/me/Library/Application Support/Browser Forge/recordings/active/3d4527e4-4d47-4aea-a4ba-cd61218bbd27'
    const result = buildExternalAgentPrompt({ recordingPath, guidance: '查询订单状态' })

    expect(result).toContain('browser-forge skill')
    expect(result).toContain(recordingPath)
    expect(result).toContain('查询订单状态')
    expect(result).toContain('独立运行')
    expect(result).toContain('CLI')
    for (const section of ['本次录制中的动作与意图', '希望提取的 skill 能力', 'Skill 验收标准']) {
      expect(result).toContain(section)
    }
    expect(result).toContain('timeline.json')
    expect(result).toContain('videoOffsetMs')
    expect(result).toContain('零依赖视频抽帧工具')
    expect(result).toContain('不需要额外安装 FFmpeg、Homebrew、Python 或 pip')
    expect(result).toContain('必须实际执行用户给出的验收任务')
    expect(result).toContain('每一项验收标准是否通过')
  })

  it('provides actionable fallback guidance when the persisted prompt is empty', () => {
    expect(buildExternalAgentPrompt({ recordingPath: '/managed/recording', guidance: '' })).toContain('向用户确认关键目标')
  })
})
