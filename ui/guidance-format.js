export const GUIDANCE_HEADINGS = Object.freeze({
  actions: '本次录制中的动作与意图',
  capability: '希望提取的 skill 能力',
  acceptance: 'Skill 验收标准'
})

export function emptyGuidance() {
  return { actions: '', capability: '', acceptance: '' }
}

export function serializeGuidanceMarkdown(fields = {}) {
  const values = Object.fromEntries(
    Object.keys(GUIDANCE_HEADINGS).map(key => [key, fields[key] ?? ''])
  )
  if (!Object.values(values).some(value => String(value).trim())) return ''

  return Object.entries(GUIDANCE_HEADINGS)
    .map(([key, heading]) => `## ${heading}\n\n${String(values[key] || '').trim()}`)
    .join('\n\n')
    .trim()
}

export function parseGuidanceMarkdown(text = '') {
  const source = String(text).trim()
  if (!source) return { ...emptyGuidance(), legacy: false }

  const result = emptyGuidance()
  let matched = false
  for (const [key, heading] of Object.entries(GUIDANCE_HEADINGS)) {
    const pattern = new RegExp(`(?:^|\\n)## ${escapeRegExp(heading)}\\n+([\\s\\S]*?)(?=\\n## |$)`)
    const match = source.match(pattern)
    if (match) {
      matched = true
      result[key] = match[1].trim()
    }
  }

  return matched
    ? { ...result, legacy: false }
    : { ...result, actions: source, legacy: true }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
