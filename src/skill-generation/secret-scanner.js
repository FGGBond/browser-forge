import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const SKIPPED_DIRECTORIES = new Set(['.git', '.venv', '__pycache__', 'node_modules'])
const REDACTED_VALUE = /^(?:<[^>]+>|\{\{[^}]+\}\}|redacted|removed|placeholder)$/i

const PATTERNS = [
  {
    code: 'BEARER_TOKEN',
    expression: /\bBearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g
  },
  {
    code: 'JD_SESSION_COOKIE',
    expression: /\b(?:me_token|sso_token|ssa_token|ssa\.jd\.com|ssa\.[A-Za-z0-9_.-]+)\s*=\s*([^\s;'"`{}]+)/gi
  },
  {
    code: 'AUTHORIZATION_HEADER',
    expression: /\b(?:authorization|x-api-key|x-auth-token)\s*:\s*(?!Bearer\s+)([^\s;'"`]+)/gi
  },
  {
    code: 'COOKIE_ASSIGNMENT',
    expression: /\b(?:set-cookie|cookie)\s*[:=]\s*([^\s;'"`]+)/gi
  },
  {
    code: 'HIGH_ENTROPY_SECRET',
    expression: /["']?(?:access_token|api[_-]?key|csrf[_-]?token|secret|token)["']?\s*[:=]\s*["']?([A-Za-z0-9_-]{16,})/gi
  },
  {
    // Bare high-entropy tokens. Require a digit + length 32 to reduce
    // false-positives on identifiers we generate ourselves (e.g. the wrapper
    // path `browser_forge-<skill-name>` frequently sits in the 24-31 range).
    code: 'HIGH_ENTROPY_SECRET',
    expression: /\b([A-Za-z0-9_-]{32,})\b/g
  }
]

function isRedacted(value) {
  return REDACTED_VALUE.test(value.trim())
}

function hasHighEntropy(value) {
  const counts = new Map()
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1)
  const entropy = [...counts.values()]
    .map(count => count / value.length)
    .reduce((sum, probability) => sum - probability * Math.log2(probability), 0)
  return entropy >= 3.5 && /\d/.test(value)
}

function lineAndColumn(text, offset) {
  const prefix = text.slice(0, offset)
  const line = prefix.split('\n').length
  const lastNewline = prefix.lastIndexOf('\n')
  return { line, column: offset - lastNewline }
}

function shortPreview(value) {
  if (value.length <= 8) return value
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

function finding(code, path, text, offset, secret) {
  return { code, path, ...lineAndColumn(text, offset), preview: `${code}: ${shortPreview(secret)}` }
}

function buildIdentifierAllowlist(hints = []) {
  const values = new Set()
  for (const hint of hints) {
    if (typeof hint !== 'string' || !hint) continue
    values.add(hint)
    values.add(hint.replaceAll('-', '_'))
    values.add(hint.replaceAll('_', '-'))
  }
  return values
}

function matchesAllowlist(secret, allowlist) {
  if (allowlist.has(secret)) return true
  for (const entry of allowlist) {
    if (!entry) continue
    if (secret.includes(entry)) return true
  }
  return false
}

export function scanText(text, relativePath, { identifierAllowlist = new Set() } = {}) {
  const findings = []
  const occupied = []

  for (const { code, expression } of PATTERNS) {
    expression.lastIndex = 0
    for (const match of text.matchAll(expression)) {
      const secret = match[1]
      const start = match.index
      const end = start + match[0].length
      if (
        isRedacted(secret) ||
        (code === 'HIGH_ENTROPY_SECRET' && !hasHighEntropy(secret)) ||
        (code === 'HIGH_ENTROPY_SECRET' && matchesAllowlist(secret, identifierAllowlist)) ||
        occupied.some(range => start < range.end && end > range.start)
      ) continue
      occupied.push({ start, end })
      findings.push(finding(code, relativePath, text, start, secret))
    }
  }

  return findings.sort((left, right) => left.line - right.line || left.column - right.column)
}

async function manifestHints(root) {
  try {
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
    const hints = [manifest?.id, manifest?.name]
    const entrypoint = manifest?.cli?.entrypoint
    if (typeof entrypoint === 'string') hints.push(entrypoint.replace(/^scripts\//, ''))
    if (manifest?.name) hints.push(`browser_forge_${String(manifest.name).replaceAll('-', '_')}`)
    return hints.filter(Boolean)
  } catch {
    return []
  }
}

export async function scanTree(root) {
  const allowlist = buildIdentifierAllowlist(await manifestHints(root))
  const findings = []

  async function scanDirectory(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await scanDirectory(path)
      } else if (entry.isFile()) {
        const text = await readFile(path, 'utf8')
        const relativePath = relative(root, path).split(sep).join('/')
        findings.push(...scanText(text, relativePath, { identifierAllowlist: allowlist }))
      }
    }
  }

  await scanDirectory(root)
  return findings
}
