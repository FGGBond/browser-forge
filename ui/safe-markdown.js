const HTTP_URL = /^https?:\/\/[^\u0000-\u0020\u007f]+$/i

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function isSafeHttpUrl(value) {
  if (!HTTP_URL.test(value)) return false
  try {
    const parsed = new URL(value.replaceAll('&amp;', '&'))
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function renderEmphasis(value) {
  return value
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/_([^_\n]+)_/g, '<em>$1</em>')
}

function findLinkEnd(value, start) {
  const labelEnd = value.indexOf('](', start + 1)
  if (labelEnd < 0) return null
  const urlEnd = value.indexOf(')', labelEnd + 2)
  if (urlEnd < 0) return null
  return { labelEnd, urlEnd }
}

function renderInline(value) {
  let output = ''
  let plain = ''

  const flushPlain = () => {
    output += renderEmphasis(plain)
    plain = ''
  }

  for (let index = 0; index < value.length;) {
    if (value[index] === '`') {
      const codeEnd = value.indexOf('`', index + 1)
      if (codeEnd > index + 1) {
        flushPlain()
        output += `<code>${value.slice(index + 1, codeEnd)}</code>`
        index = codeEnd + 1
        continue
      }
    }

    const imageStart = value.startsWith('![', index)
    const linkStart = value[index] === '['
    if (imageStart || linkStart) {
      const syntaxStart = imageStart ? index + 1 : index
      const linkEnd = findLinkEnd(value, syntaxStart)
      if (linkEnd) {
        const wholeEnd = linkEnd.urlEnd + 1
        if (imageStart) {
          plain += value.slice(index, wholeEnd)
        } else {
          const label = value.slice(index + 1, linkEnd.labelEnd)
          const url = value.slice(linkEnd.labelEnd + 2, linkEnd.urlEnd).trim()
          if (isSafeHttpUrl(url)) {
            flushPlain()
            output += `<a href="${url}" target="_blank" rel="noreferrer noopener">${renderEmphasis(label)}</a>`
          } else {
            plain += value.slice(index, wholeEnd)
          }
        }
        index = wholeEnd
        continue
      }
    }

    plain += value[index]
    index += 1
  }

  flushPlain()
  return output
}

export function renderSafeMarkdown(markdown = '') {
  const lines = escapeHtml(String(markdown).replace(/\r\n?/g, '\n')).split('\n')
  const blocks = []
  let paragraph = []
  let listType = null
  let listItems = []

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    blocks.push(`<p>${renderInline(paragraph.join(' '))}</p>`)
    paragraph = []
  }

  const flushList = () => {
    if (!listType) return
    blocks.push(`<${listType}>${listItems.map(item => `<li>${renderInline(item)}</li>`).join('')}</${listType}>`)
    listType = null
    listItems = []
  }

  for (const line of lines) {
    if (/^\s*$/.test(line)) {
      flushParagraph()
      flushList()
      continue
    }

    const heading = line.match(/^(#{1,6})[ \t]+(.+)$/)
    if (heading) {
      flushParagraph()
      flushList()
      const level = heading[1].length
      blocks.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`)
      continue
    }

    const unorderedItem = line.match(/^\s*[-+*][ \t]+(.+)$/)
    const orderedItem = line.match(/^\s*\d+[.)][ \t]+(.+)$/)
    const nextListType = unorderedItem ? 'ul' : orderedItem ? 'ol' : null
    if (nextListType) {
      flushParagraph()
      if (listType && listType !== nextListType) flushList()
      listType = nextListType
      listItems.push((unorderedItem ?? orderedItem)[1].trim())
      continue
    }

    flushList()
    paragraph.push(line.trim())
  }

  flushParagraph()
  flushList()
  return blocks.join('\n')
}
