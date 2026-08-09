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

  it('keeps legacy free-form guidance losslessly in actions', () => {
    const legacy = '旧版自由文本\n\n- 保留 Markdown\n- 保留换行'

    expect(parseGuidanceMarkdown(legacy)).toEqual({
      actions: legacy,
      capability: '',
      acceptance: '',
      legacy: true
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

  it('ignores unknown headings without overwriting known fields', () => {
    const markdown = [
      '## 本次录制中的动作与意图',
      '',
      '打开订单详情',
      '',
      '## 未知字段',
      '',
      '不应进入已知字段',
      '',
      '## 希望提取的 skill 能力',
      '',
      '查询物流'
    ].join('\n')

    expect(parseGuidanceMarkdown(markdown)).toEqual({
      actions: '打开订单详情',
      capability: '查询物流',
      acceptance: '',
      legacy: false
    })
  })
})
