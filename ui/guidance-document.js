const UNORDERED_ITEM = /^- (.*)$/
const ORDERED_ITEM = /^\d+\. (.*)$/
const CONTINUATION = /^ {2}(.*)$/
const ESCAPED_LIST_MARKER = /^\\((?:- |\d+\. ).*)$/

export function markdownToGuidanceBlocks(markdown = '') {
  const lines = normalizeLineEndings(markdown).split('\n')
  trimBlankEdges(lines)
  const blocks = []

  for (let index = 0; index < lines.length;) {
    if (lines[index] === '') {
      index += 1
      continue
    }

    const unordered = lines[index].match(UNORDERED_ITEM)
    if (unordered) {
      const parsed = readList(lines, index, UNORDERED_ITEM)
      blocks.push({ type: 'unordered-list', items: parsed.items })
      index = parsed.nextIndex
      continue
    }

    const ordered = lines[index].match(ORDERED_ITEM)
    if (ordered) {
      const parsed = readList(lines, index, ORDERED_ITEM)
      blocks.push({ type: 'ordered-list', items: parsed.items })
      index = parsed.nextIndex
      continue
    }

    const paragraph = []
    while (index < lines.length && lines[index] !== '') {
      if (paragraph.length > 0 && isListStart(lines[index])) break
      paragraph.push(unescapeParagraphLine(lines[index]))
      index += 1
    }
    if (paragraph.length) blocks.push({ type: 'paragraph', lines: paragraph })
  }

  return blocks
}

export function guidanceBlocksToMarkdown(blocks = []) {
  if (!Array.isArray(blocks)) return ''

  return blocks.flatMap(block => {
    if (block?.type === 'paragraph' && Array.isArray(block.lines)) {
      const lines = block.lines.map(line => escapeParagraphLine(cleanText(line)))
      return lines.length ? [lines.join('\n')] : []
    }

    if (block?.type === 'unordered-list' || block?.type === 'ordered-list') {
      if (!Array.isArray(block.items)) return []
      const items = block.items.filter(Array.isArray)
      if (!items.length) return []
      const lines = []
      items.forEach((item, index) => {
        const values = item.length ? item.map(cleanText) : ['']
        const marker = block.type === 'unordered-list' ? '- ' : `${index + 1}. `
        lines.push(marker + (values[0] ?? ''))
        values.slice(1).forEach(line => lines.push(`  ${line}`))
      })
      return [lines.join('\n')]
    }

    return []
  }).join('\n\n')
}

export function normalizeGuidanceMarkdown(markdown = '') {
  return guidanceBlocksToMarkdown(markdownToGuidanceBlocks(markdown))
}

export function renderGuidanceMarkdown(root, markdown = '') {
  const document = root?.ownerDocument
  if (!document?.createElement || !document?.createTextNode) {
    throw new TypeError('A DOM root is required to render guidance Markdown')
  }

  const fragment = document.createDocumentFragment()
  const blocks = markdownToGuidanceBlocks(markdown)
  for (const block of blocks) {
    if (block.type === 'paragraph') {
      const paragraph = document.createElement('p')
      appendLines(paragraph, block.lines, document)
      fragment.append(paragraph)
      continue
    }

    const list = document.createElement(block.type === 'ordered-list' ? 'ol' : 'ul')
    for (const item of block.items) {
      const listItem = document.createElement('li')
      appendLines(listItem, item, document)
      list.append(listItem)
    }
    fragment.append(list)
  }

  if (!fragment.childNodes.length) {
    const paragraph = document.createElement('p')
    paragraph.append(document.createElement('br'))
    fragment.append(paragraph)
  }
  root.replaceChildren(fragment)
}

export function guidanceElementToMarkdown(root) {
  if (!root?.childNodes) return ''
  const blocks = []
  let looseLines = []

  const flushLooseText = () => {
    if (!looseLines.length) return
    blocks.push({ type: 'paragraph', lines: trimTrailingEmptyLines(looseLines) })
    looseLines = []
  }

  for (const node of root.childNodes) {
    if (node.nodeType === 3) {
      looseLines.push(...nodeTextLines(node))
      continue
    }
    if (node.nodeType !== 1) continue

    const tag = node.tagName?.toLowerCase()
    if (tag === 'ul' || tag === 'ol') {
      flushLooseText()
      const items = [...node.children]
        .filter(child => child.tagName?.toLowerCase() === 'li')
        .map(child => trimTrailingEmptyLines(nodeTextLines(child)))
      blocks.push({ type: tag === 'ul' ? 'unordered-list' : 'ordered-list', items })
      continue
    }

    if (tag === 'br') {
      looseLines.push('')
      continue
    }

    flushLooseText()
    blocks.push({ type: 'paragraph', lines: trimTrailingEmptyLines(nodeTextLines(node)) })
  }
  flushLooseText()

  return guidanceBlocksToMarkdown(blocks.filter(block => block.type !== 'paragraph' || block.lines.some(Boolean)))
}

function readList(lines, startIndex, itemPattern) {
  const items = []
  let index = startIndex
  while (index < lines.length) {
    const item = lines[index].match(itemPattern)
    if (!item) break
    const values = [item[1]]
    index += 1
    while (index < lines.length) {
      const continuation = lines[index].match(CONTINUATION)
      if (!continuation) break
      values.push(continuation[1])
      index += 1
    }
    items.push(values)
  }
  return { items, nextIndex: index }
}

function isListStart(line) {
  return UNORDERED_ITEM.test(line) || ORDERED_ITEM.test(line)
}

function appendLines(element, lines, document) {
  const values = Array.isArray(lines) && lines.length ? lines : ['']
  values.forEach((line, index) => {
    if (index > 0) element.append(document.createElement('br'))
    if (line) element.append(document.createTextNode(cleanText(line)))
  })
  if (!element.childNodes.length) element.append(document.createElement('br'))
}

function nodeTextLines(node) {
  let text = ''
  const visit = current => {
    if (current.nodeType === 3) {
      text += current.nodeValue ?? ''
      return
    }
    if (current.nodeType !== 1) return
    const tag = current.tagName?.toLowerCase()
    if (tag === 'br') {
      text += '\n'
      return
    }
    const isNestedBlock = current !== node && (tag === 'div' || tag === 'p')
    if (isNestedBlock && text && !text.endsWith('\n')) text += '\n'
    for (const child of current.childNodes) visit(child)
    if (isNestedBlock && !text.endsWith('\n')) text += '\n'
  }
  visit(node)
  return normalizeEditableText(text).split('\n')
}

function cleanText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '')
}

function normalizeEditableText(value) {
  return cleanText(value)
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b\ufeff]/g, '')
}

function normalizeLineEndings(value) {
  return cleanText(value)
}

function unescapeParagraphLine(line) {
  return line.replace(ESCAPED_LIST_MARKER, '$1')
}

function escapeParagraphLine(line) {
  return isListStart(line) ? `\\${line}` : line
}

function trimBlankEdges(lines) {
  while (lines[0] === '') lines.shift()
  while (lines.at(-1) === '') lines.pop()
}

function trimTrailingEmptyLines(lines) {
  const result = lines.length ? [...lines] : ['']
  while (result.length > 1 && result.at(-1) === '') result.pop()
  return result
}
