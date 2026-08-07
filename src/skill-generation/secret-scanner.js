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
    expression: /\b(?:me_token|sso_token|ssa_token|sso\.jd\.com|ssa\.[A-Za-z0-9_.-]+)\s*=\s*([^\s;'"`{}]+)/gi
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
    code: 'HIGH_ENTROPY_SECRET',
    expression: /\b([A-Za-z0-9_-]{24,})\b/g
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
  return entropy >= 3.5
}

function lineAndColumn(text, offset) {
  const prefix = text.slice(0, offset)
  const line = prefix.split('\n').length
  const lastNewline = prefix.lastIndexOf('\n')
  return { line, column: offset - lastNewline }
}

function finding(code, path, text, offset) {
  return { code, path, ...lineAndColumn(text, offset), preview: `${code}: [REDACTED]` }
}

export function scanText(text, relativePath, allowlist = new Set()) {
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
        allowlist.has(secret) ||
        (code === 'HIGH_ENTROPY_SECRET' && !hasHighEntropy(secret)) ||
        occupied.some(range => start < range.end && end > range.start)
      ) continue
      occupied.push({ start, end })
      findings.push(finding(code, relativePath, text, start))
    }
  }

  return findings.sort((left, right) => left.line - right.line || left.column - right.column)
}

export async function scanTree(root, allowlist = new Set()) {
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
        findings.push(...scanText(text, relativePath, allowlist))
      }
    }
  }

  await scanDirectory(root)
  return findings
}
