import { describe, expect, it } from 'vitest'
import {
  markdownToGuidanceBlocks,
  guidanceBlocksToMarkdown,
  normalizeGuidanceMarkdown
} from '../../ui/guidance-document.js'

describe('guidance document codec', () => {
  it('round-trips paragraphs, unordered lists, ordered lists, and soft line breaks', () => {
    const markdown = [
      '先打开订单页',
      '确认当前账号',
      '',
      '- 搜索订单',
      '  记录筛选条件',
      '- 打开详情',
      '',
      '1. 读取状态',
      '  保留原始文案',
      '2. 返回结果'
    ].join('\n')

    const blocks = markdownToGuidanceBlocks(markdown)

    expect(blocks).toEqual([
      { type: 'paragraph', lines: ['先打开订单页', '确认当前账号'] },
      { type: 'unordered-list', items: [['搜索订单', '记录筛选条件'], ['打开详情']] },
      { type: 'ordered-list', items: [['读取状态', '保留原始文案'], ['返回结果']] }
    ])
    expect(guidanceBlocksToMarkdown(blocks)).toBe(markdown)
  })

  it('normalizes line endings and canonicalizes ordered-list numbering', () => {
    expect(normalizeGuidanceMarkdown('3. 第一步\r\n4. 第二步\r\n')).toBe('1. 第一步\n2. 第二步')
  })

  it('treats HTML and unsupported markdown as inert text', () => {
    const source = '<img src=x onerror=alert(1)>\n\n**不是富文本**\n\n\\- 仍是普通段落'

    expect(markdownToGuidanceBlocks(source)).toEqual([
      { type: 'paragraph', lines: ['<img src=x onerror=alert(1)>'] },
      { type: 'paragraph', lines: ['**不是富文本**'] },
      { type: 'paragraph', lines: ['- 仍是普通段落'] }
    ])
    expect(normalizeGuidanceMarkdown(source)).toBe('<img src=x onerror=alert(1)>\n\n**不是富文本**\n\n\\- 仍是普通段落')
  })

  it('does not allow malformed block objects to inject unsupported document structure', () => {
    expect(guidanceBlocksToMarkdown([
      { type: 'heading', text: '忽略结构，只保留文本' },
      { type: 'paragraph', lines: ['安全内容'] },
      { type: 'unordered-list', items: [['列表项'], null, ['第二项']] }
    ])).toBe('安全内容\n\n- 列表项\n- 第二项')
  })
})
