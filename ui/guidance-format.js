export const GUIDANCE_HEADINGS = Object.freeze({
  actions: '本次录制中的动作与意图',
  capability: '希望提取的 skill 能力',
  acceptance: 'Skill 验收标准'
})

const GUIDANCE_VERSION = 'v2'
const GUIDANCE_END_SENTINEL = '<!-- /browser-forge-guidance -->'
const GUIDANCE_SENTINEL_PATTERN = new RegExp(
  `^<!-- browser-forge-guidance:${GUIDANCE_VERSION} actions=(0|[1-9]\\d*) capability=(0|[1-9]\\d*) acceptance=(0|[1-9]\\d*) -->\\n\\n`
)

export function emptyGuidance() {
  return { actions: '', capability: '', acceptance: '' }
}

export function serializeGuidanceMarkdown(fields = {}) {
  const values = Object.fromEntries(
    Object.keys(GUIDANCE_HEADINGS).map(key => [key, normalizeLineEndings(fields[key])])
  )
  if (!Object.values(values).some(value => value.trim())) return ''

  const sentinel = [
    `<!-- browser-forge-guidance:${GUIDANCE_VERSION}`,
    ...Object.keys(GUIDANCE_HEADINGS).map(key => `${key}=${values[key].length}`)
  ].join(' ') + ' -->'
  const sections = Object.entries(GUIDANCE_HEADINGS).map(
    ([key, heading]) => `## ${heading}\n\n${values[key]}`
  )

  return [sentinel, ...sections, GUIDANCE_END_SENTINEL].join('\n\n')
}

export function parseGuidanceMarkdown(text = '') {
  const source = String(text)
  if (!source.trim()) return { ...emptyGuidance(), legacy: false }

  const normalized = normalizeLineEndings(source)
  const sentinelMatch = normalized.match(GUIDANCE_SENTINEL_PATTERN)
  if (!sentinelMatch) return legacyGuidance(source)

  const lengths = sentinelMatch.slice(1).map(value => Number(value))
  if (!lengths.every(Number.isSafeInteger)) return legacyGuidance(source)

  const result = emptyGuidance()
  let offset = sentinelMatch[0].length
  const entries = Object.entries(GUIDANCE_HEADINGS)

  for (const [index, [key, heading]] of entries.entries()) {
    const prefix = `## ${heading}\n\n`
    if (!normalized.startsWith(prefix, offset)) return legacyGuidance(source)
    offset += prefix.length

    const contentEnd = offset + lengths[index]
    if (contentEnd > normalized.length) return legacyGuidance(source)
    result[key] = normalized.slice(offset, contentEnd)
    offset = contentEnd

    const separator = index === entries.length - 1
      ? `\n\n${GUIDANCE_END_SENTINEL}`
      : '\n\n'
    if (!normalized.startsWith(separator, offset)) return legacyGuidance(source)
    offset += separator.length
  }

  if (offset !== normalized.length) return legacyGuidance(source)
  return { ...result, legacy: false }
}

function legacyGuidance(source) {
  return { ...emptyGuidance(), actions: source, legacy: true }
}

function normalizeLineEndings(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n')
}
