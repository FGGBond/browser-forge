export const GUIDANCE_HEADINGS = Object.freeze({
  actions: '本次录制中的动作与意图',
  capability: '希望提取的 skill 能力',
  acceptance: 'Skill 验收标准'
})

const GUIDANCE_VERSION_SENTINEL = '<!-- browser-forge-guidance:v1 -->'
const GUIDANCE_END_SENTINEL = '<!-- /browser-forge-guidance -->'
const GUIDANCE_FIELD_BOUNDARIES = Object.freeze(
  Object.fromEntries(
    Object.keys(GUIDANCE_HEADINGS).map(key => [key, Object.freeze({
      start: `<!-- browser-forge-guidance:${key}:start -->`,
      end: `<!-- browser-forge-guidance:${key}:end -->`
    })])
  )
)

export function emptyGuidance() {
  return { actions: '', capability: '', acceptance: '' }
}

export function serializeGuidanceMarkdown(fields = {}) {
  const values = Object.fromEntries(
    Object.keys(GUIDANCE_HEADINGS).map(key => [key, normalizeGuidanceValue(fields[key])])
  )
  if (!Object.values(values).some(value => value)) return ''

  const sections = Object.entries(GUIDANCE_HEADINGS).map(([key, heading]) => {
    const boundary = GUIDANCE_FIELD_BOUNDARIES[key]
    return `${boundary.start}\n## ${heading}\n\n${values[key]}\n${boundary.end}`
  })

  return [GUIDANCE_VERSION_SENTINEL, ...sections, GUIDANCE_END_SENTINEL].join('\n\n')
}

export function parseGuidanceMarkdown(text = '') {
  const source = String(text)
  if (!source.trim()) return { ...emptyGuidance(), legacy: false }

  const normalized = source.replace(/\r\n?/g, '\n')
  if (!normalized.startsWith(`${GUIDANCE_VERSION_SENTINEL}\n`)) {
    return legacyGuidance(source)
  }

  const match = normalized.match(structuredGuidancePattern())
  if (!match) return legacyGuidance(source)

  const result = emptyGuidance()
  Object.keys(GUIDANCE_HEADINGS).forEach((key, index) => {
    result[key] = match[index + 1]
  })
  return { ...result, legacy: false }
}

function structuredGuidancePattern() {
  const sections = Object.entries(GUIDANCE_HEADINGS).map(([key, heading]) => {
    const boundary = GUIDANCE_FIELD_BOUNDARIES[key]
    return [
      escapeRegExp(boundary.start),
      `\n## ${escapeRegExp(heading)}\n\n`,
      '([\\s\\S]*?)',
      `\n${escapeRegExp(boundary.end)}`
    ].join('')
  })

  return new RegExp([
    `^${escapeRegExp(GUIDANCE_VERSION_SENTINEL)}\n\n`,
    sections.join('\n\n'),
    `\n\n${escapeRegExp(GUIDANCE_END_SENTINEL)}\n?$`
  ].join(''))
}

function legacyGuidance(source) {
  return { ...emptyGuidance(), actions: source, legacy: true }
}

function normalizeGuidanceValue(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim()
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
