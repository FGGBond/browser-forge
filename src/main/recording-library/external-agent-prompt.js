export const GUIDED_PROMPT_TEMPLATE = `我在这段录制中完成了：

[描述你刚才进行了哪些操作，以及为什么这样操作]

我希望生成的 Browser Forge skill 实现：

[描述未来希望 Agent 自动完成的目标]

调用这个 skill 时，用户会提供：

[输入参数，例如订单号、商品链接、查询日期]

skill 应返回或产生：

[输出结果或页面变更]

成功标准：

[什么结果代表操作成功]

限制和注意事项：

[登录状态、操作风险、不可执行的步骤等]`

export function buildExternalAgentPrompt({ recordingPath, guidance }) {
  const normalizedPath = String(recordingPath || '').trim()
  if (!normalizedPath) throw new Error('recordingPath is required')
  const normalizedGuidance = String(guidance || '').trim()
  return `请使用已安装的 browser-forge skill 分析下面这段浏览器录制，并产出一个可独立运行的 skill 和 CLI 工具包。

录制物料绝对路径：
${normalizedPath}

用户说明分为：
- 本次录制中的动作与意图
- 希望提取的 skill 能力
- Skill 验收标准

用户对录制行为和目标的说明：
${normalizedGuidance || '用户尚未补充说明，请先基于录制物料分析并向用户确认关键目标。'}

分析要求：
- 读取录制目录中的 metadata.json、timeline.json、recording.har、tabs/ 和 video/manifest.json。
- 根据 timeline.json 中事件的 videoOffsetMs，按需调用 browser-forge 自带的零依赖视频抽帧工具获取对应时刻的浏览器画面。
- 视频抽帧不需要额外安装 FFmpeg、Homebrew、Python 或 pip。
- 最终结果必须是可独立运行、包含清晰输入输出契约和一系列 CLI 工具的 Browser Forge skill。
- 完成产物后，必须实际执行用户给出的验收任务，并说明每一项验收标准是否通过。`
}
