import { describe, expect, it } from 'vitest'
import {
  GUIDANCE_HEADINGS,
  emptyGuidance,
  parseGuidanceMarkdown,
  serializeGuidanceMarkdown
} from '../../ui/guidance-format.js'

describe('guidance Markdown format', () => {
  it('exposes stable headings for exactly three guidance fields', () => {
    expect(GUIDANCE_HEADINGS).toEqual({
      actions: '本次录制中的动作与意图',
      capability: '希望提取的 skill 能力',
      acceptance: 'Skill 验收标准'
    })
    expect(Object.isFrozen(GUIDANCE_HEADINGS)).toBe(true)
  })

  it('round-trips the three guidance answers', () => {
    const fields = {
      actions: '查询订单并读取物流状态',
      capability: '根据订单号返回承运商和最新节点',
      acceptance: '使用 JD123 查询，结果必须与详情页一致'
    }

    expect(parseGuidanceMarkdown(serializeGuidanceMarkdown(fields))).toEqual({
      ...fields,
      legacy: false
    })
  })

  it('uses an explicit version sentinel while keeping stable readable headings', () => {
    const markdown = serializeGuidanceMarkdown({ actions: '打开订单详情' })

    expect(markdown).toMatch(
      /^<!-- browser-forge-guidance:v2 actions=6 capability=0 acceptance=0 -->\n/
    )
    for (const heading of Object.values(GUIDANCE_HEADINGS)) {
      expect(markdown).toContain(`## ${heading}`)
    }
  })

  it('round-trips Markdown headings, fenced code blocks, and lists inside every answer', () => {
    const fields = {
      actions: [
        '先读取页面。',
        '',
        '## 普通动作标题',
        '',
        '## 本次录制中的动作与意图',
        '',
        '- 点击搜索',
        '- 打开详情',
        '',
        '```markdown',
        '## 希望提取的 skill 能力',
        '- 这只是代码块内容',
        '```'
      ].join('\n'),
      capability: [
        '生成查询能力。',
        '',
        '## 希望提取的 skill 能力',
        '',
        '1. 接收订单号',
        '2. 返回物流状态',
        '',
        '```js',
        "return { heading: '## Skill 验收标准' }",
        '```'
      ].join('\n'),
      acceptance: [
        '执行真实验收。',
        '',
        '## Skill 验收标准',
        '',
        '- [ ] 结果与详情页一致',
        '',
        '## 补充说明',
        '',
        '标题后的正文也必须保留。'
      ].join('\n')
    }

    expect(parseGuidanceMarkdown(serializeGuidanceMarkdown(fields))).toEqual({
      ...fields,
      legacy: false
    })
  })

  it('round-trips a complete previous marker frame inside a fenced Markdown example', () => {
    const embeddedFrame = [
      '下面是需要原样保留的格式示例：',
      '',
      '```markdown',
      '<!-- browser-forge-guidance:v1 -->',
      '',
      '<!-- browser-forge-guidance:actions:start -->',
      '## 本次录制中的动作与意图',
      '',
      '示例动作',
      '<!-- browser-forge-guidance:actions:end -->',
      '',
      '<!-- browser-forge-guidance:capability:start -->',
      '## 希望提取的 skill 能力',
      '',
      '示例能力',
      '<!-- browser-forge-guidance:capability:end -->',
      '',
      '<!-- browser-forge-guidance:acceptance:start -->',
      '## Skill 验收标准',
      '',
      '示例验收',
      '<!-- browser-forge-guidance:acceptance:end -->',
      '',
      '<!-- /browser-forge-guidance -->',
      '```',
      '',
      '示例后的正文也必须保留。'
    ].join('\n')
    const fields = {
      actions: embeddedFrame,
      capability: '真实能力',
      acceptance: '真实验收标准'
    }

    expect(parseGuidanceMarkdown(serializeGuidanceMarkdown(fields))).toEqual({
      ...fields,
      legacy: false
    })
  })

  it('preserves leading indented code and trailing Markdown whitespace exactly', () => {
    const fields = {
      actions: '    const order = await findOrder()\n    return order.status',
      capability: '\n先保留开头空行，再描述能力。\n',
      acceptance: '第一行使用 Markdown hard break。  \n\n尾部空白也属于正文。\t  \n'
    }

    expect(parseGuidanceMarkdown(serializeGuidanceMarkdown(fields))).toEqual({
      ...fields,
      legacy: false
    })
  })

  it('uses normalized LF JavaScript string lengths for multibyte and emoji content', () => {
    const input = {
      actions: '😀',
      capability: '汉\r\n字',
      acceptance: 'é🚀'
    }
    const normalized = {
      actions: '😀',
      capability: '汉\n字',
      acceptance: 'é🚀'
    }
    const markdown = serializeGuidanceMarkdown(input)

    expect(markdown).toMatch(
      /^<!-- browser-forge-guidance:v2 actions=2 capability=3 acceptance=3 -->\n/
    )
    expect(parseGuidanceMarkdown(markdown)).toEqual({
      ...normalized,
      legacy: false
    })
  })

  it('keeps legacy free-form guidance losslessly in actions', () => {
    const legacy = '旧版自由文本\n\n- 保留 Markdown\n- 保留换行'

    expect(parseGuidanceMarkdown(legacy)).toEqual({
      actions: legacy,
      capability: '',
      acceptance: '',
      legacy: true
    })
  })

  it('keeps all legacy text when it happens to contain one or more fixed headings', () => {
    const legacy = [
      '标题前的旧版说明不能丢失。',
      '',
      '## 本次录制中的动作与意图',
      '',
      '这仍然只是旧自由文本。',
      '',
      '## 希望提取的 skill 能力',
      '',
      '- 标题后的列表也必须保留',
      '',
      '最后一段同样不能丢失。'
    ].join('\n')

    expect(parseGuidanceMarkdown(legacy)).toEqual({
      actions: legacy,
      capability: '',
      acceptance: '',
      legacy: true
    })
  })

  it('treats a length-prefixed sentinel with an invalid structure as lossless legacy text', () => {
    const legacy = serializeGuidanceMarkdown({
      actions: '必须全文保留',
      capability: '不能错分',
      acceptance: '不能截断'
    }).replace('actions=6', 'actions=5')

    expect(parseGuidanceMarkdown(legacy)).toEqual({
      actions: legacy,
      capability: '',
      acceptance: '',
      legacy: true
    })
  })

  it('parses a complete structured document with CRLF line endings', () => {
    const fields = {
      actions: '打开订单详情\n\n- 读取订单号',
      capability: '## 查询能力\n\n返回物流状态',
      acceptance: '```text\n物流状态一致\n```'
    }
    const crlf = serializeGuidanceMarkdown(fields).replace(/\n/g, '\r\n')

    expect(parseGuidanceMarkdown(crlf)).toEqual({
      ...fields,
      legacy: false
    })
  })

  it('does not persist empty placeholder content', () => {
    expect(serializeGuidanceMarkdown(emptyGuidance())).toBe('')
    const parsedEmpty = parseGuidanceMarkdown('')
    expect(parsedEmpty).toEqual({
      actions: '',
      capability: '',
      acceptance: '',
      legacy: false
    })
    expect(serializeGuidanceMarkdown(parsedEmpty)).toBe('')
  })

  it('does not identify heading-only Markdown as the structured format', () => {
    const markdown = Object.values(GUIDANCE_HEADINGS)
      .map(heading => `## ${heading}\n\n旧自由文本中的内容`)
      .join('\n\n')

    expect(parseGuidanceMarkdown(markdown)).toEqual({
      actions: markdown,
      capability: '',
      acceptance: '',
      legacy: true
    })
  })
})
