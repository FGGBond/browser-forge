export const GUIDANCE_HEADINGS = Object.freeze({
  actions: '本次录制中的动作与意图',
  capability: '希望提取的 skill 能力',
  acceptance: 'Skill 验收标准',
  notes: '补充上下文'
})

const LEGACY_V2_HEADINGS = Object.freeze({
  actions: GUIDANCE_HEADINGS.actions,
  capability: GUIDANCE_HEADINGS.capability,
  acceptance: GUIDANCE_HEADINGS.acceptance
})
const CURRENT_GUIDANCE_VERSION = 'v3'
const GUIDANCE_FORMATS = Object.freeze({
  v2: LEGACY_V2_HEADINGS,
  [CURRENT_GUIDANCE_VERSION]: GUIDANCE_HEADINGS
})
const GUIDANCE_END_SENTINEL = '<!-- /browser-forge-guidance -->'

export function emptyGuidance() {
  return { actions: '', capability: '', acceptance: '', notes: '' }
}

export function serializeGuidanceMarkdown(fields = {}) {
  const values = Object.fromEntries(
    Object.keys(GUIDANCE_HEADINGS).map(key => [key, normalizeLineEndings(fields[key])])
  )
  if (!Object.values(values).some(value => value.trim())) return ''

  const sentinel = [
    `<!-- browser-forge-guidance:${CURRENT_GUIDANCE_VERSION}`,
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
  for (const [version, headings] of Object.entries(GUIDANCE_FORMATS)) {
    const result = parseVersionedGuidance(normalized, version, headings)
    if (result) return { ...emptyGuidance(), ...result, legacy: false }
  }
  return legacyGuidance(source)
}

function parseVersionedGuidance(source, version, headings) {
  const keys = Object.keys(headings)
  const lengthFields = keys.map(key => `${key}=(0|[1-9]\\d*)`).join(' ')
  const sentinelPattern = new RegExp(
    `^<!-- browser-forge-guidance:${version} ${lengthFields} -->\\n\\n`
  )
  const sentinelMatch = source.match(sentinelPattern)
  if (!sentinelMatch) return null

  const lengths = sentinelMatch.slice(1).map(value => Number(value))
  if (!lengths.every(Number.isSafeInteger)) return null

  const result = {}
  let offset = sentinelMatch[0].length
  const entries = Object.entries(headings)

  for (const [index, [key, heading]] of entries.entries()) {
    const prefix = `## ${heading}\n\n`
    if (!source.startsWith(prefix, offset)) return null
    offset += prefix.length

    const contentEnd = offset + lengths[index]
    if (contentEnd > source.length) return null
    result[key] = source.slice(offset, contentEnd)
    offset = contentEnd

    const separator = index === entries.length - 1
      ? `\n\n${GUIDANCE_END_SENTINEL}`
      : '\n\n'
    if (!source.startsWith(separator, offset)) return null
    offset += separator.length
  }

  if (offset !== source.length) return null
  return result
}

function legacyGuidance(source) {
  return { ...emptyGuidance(), actions: source, legacy: true }
}

function normalizeLineEndings(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n')
}
