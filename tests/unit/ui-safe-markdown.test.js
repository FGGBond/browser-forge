import { describe, expect, it } from 'vitest'
import { renderSafeMarkdown } from '../../ui/safe-markdown.js'

describe('safe local markdown renderer', () => {
  it('renders only the planned local markdown subset', () => {
    const markdown = [
      '# 标题',
      '',
      '普通 **加粗**、*斜体* 和 `代码`。',
      '',
      '- 第一项',
      '- 第二项',
      '',
      '1. 第一步',
      '2. 第二步',
      '',
      '[HTTP](http://example.com/a?x=1&y=2) 与 [HTTPS](https://example.com/docs)'
    ].join('\n')

    const html = renderSafeMarkdown(markdown)

    expect(html).toContain('<h1>标题</h1>')
    expect(html).toContain('<p>普通 <strong>加粗</strong>、<em>斜体</em> 和 <code>代码</code>。</p>')
    expect(html).toContain('<ul><li>第一项</li><li>第二项</li></ul>')
    expect(html).toContain('<ol><li>第一步</li><li>第二步</li></ol>')
    expect(html).toContain('href="http://example.com/a?x=1&amp;y=2"')
    expect(html).toContain('href="https://example.com/docs"')
    expect(html).toContain('rel="noreferrer noopener"')
  })

  it('escapes raw HTML and never creates executable elements or handlers', () => {
    const html = renderSafeMarkdown('<script>alert(1)</script>\n\n<img src="https://attacker.invalid/x" onerror="alert(2)">')

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('&lt;img src=&quot;https://attacker.invalid/x&quot; onerror=&quot;alert(2)&quot;&gt;')
    expect(html).not.toMatch(/<(?:script|img)\b/i)
    expect(html).not.toMatch(/<[^>]+\sonerror\s*=/i)
  })

  it('renders image syntax as inert text without an img or remote-fetching attribute', () => {
    const html = renderSafeMarkdown('![远程图](https://attacker.invalid/tracker.png)')

    expect(html).toContain('![远程图](https://attacker.invalid/tracker.png)')
    expect(html).not.toMatch(/<img\b|\ssrc\s*=|\ssrcset\s*=/i)
    expect(html).not.toContain('href="https://attacker.invalid/tracker.png"')
  })

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'mailto:test@example.com',
    '//attacker.invalid/path'
  ])('does not create a link for dangerous protocol %s', protocol => {
    const html = renderSafeMarkdown(`[危险链接](${protocol})`)

    expect(html).toContain('[危险链接](')
    expect(html).not.toMatch(/<a\b|\shref\s*=/i)
  })
})
