import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// Headers that browsers set on their own or that carry credentials — never sink
// these into default_headers.
const BLOCKED_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'authorization',
  'cache-control',
  'connection',
  'content-length',
  'content-type',
  'cookie',
  'dnt',
  'host',
  'origin',
  'pragma',
  'proxy-authorization',
  'referer',
  'upgrade-insecure-requests',
  'user-agent'
])

// Header names or value substrings that suggest a per-request secret. If we see
// these we drop the header even if it looks universal in the recording.
const SECRET_HINT_RE = /(token|ticket|csrf|xsrf|nonce|signature|api[-_]?key|session[-_]?id|auth)/i
const SECRET_VALUE_HINT_RE = /^[A-Za-z0-9_.-]{32,}$/

function isRecordingHeaderPrefix(name) {
  const lower = name.toLowerCase()
  return lower.startsWith('sec-ch-') || lower.startsWith('sec-fetch-') || lower.startsWith(':')
}

function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return null
  }
}

function normalizeTargetHosts(targetHosts) {
  return new Set(targetHosts.map(host => String(host).toLowerCase().replace(/^\.+/, '').replace(/\.$/, '')))
}

function hostMatches(requestHost, targetSet) {
  if (!requestHost) return false
  if (targetSet.has(requestHost)) return true
  for (const host of targetSet) {
    if (host.startsWith('.')) {
      if (requestHost === host.slice(1) || requestHost.endsWith(host)) return true
    } else if (requestHost.endsWith('.' + host)) {
      return true
    }
  }
  return false
}

/**
 * Analyze a recording.har and pick out custom request headers that appear on
 * ~all requests to the target hosts. Returns a plain object suitable for
 * `manifest.transport.default_headers`.
 *
 * @param {string} recordingDir
 * @param {string[]} targetHosts
 * @param {{minCoverage?: number}} [options]
 */
export async function extractDefaultHeaders(recordingDir, targetHosts, options = {}) {
  const minCoverage = options.minCoverage ?? 0.8
  const targetSet = normalizeTargetHosts(targetHosts)
  let har
  try {
    har = JSON.parse(await readFile(join(recordingDir, 'recording.har'), 'utf8'))
  } catch {
    return {}
  }
  const entries = Array.isArray(har?.log?.entries) ? har.log.entries : []
  const matchingEntries = entries.filter(entry => hostMatches(hostOf(entry?.request?.url), targetSet))
  if (matchingEntries.length < 3) return {}

  // header name -> { count, values: Set }
  const stats = new Map()
  for (const entry of matchingEntries) {
    const headers = Array.isArray(entry?.request?.headers) ? entry.request.headers : []
    const seenNames = new Set()
    for (const header of headers) {
      const rawName = typeof header?.name === 'string' ? header.name : ''
      if (!rawName) continue
      const canonical = rawName.toLowerCase()
      if (BLOCKED_HEADERS.has(canonical)) continue
      if (isRecordingHeaderPrefix(canonical)) continue
      if (SECRET_HINT_RE.test(canonical)) continue
      if (seenNames.has(canonical)) continue
      seenNames.add(canonical)
      const value = typeof header.value === 'string' ? header.value : ''
      if (!value) continue
      if (SECRET_VALUE_HINT_RE.test(value)) continue
      const bucket = stats.get(canonical) ?? { canonical, originalName: rawName, count: 0, values: new Map() }
      bucket.count += 1
      bucket.values.set(value, (bucket.values.get(value) ?? 0) + 1)
      stats.set(canonical, bucket)
    }
  }

  const result = {}
  const threshold = Math.max(3, Math.ceil(matchingEntries.length * minCoverage))
  const modalRatio = options.modalRatio ?? 0.6
  for (const bucket of stats.values()) {
    if (bucket.count < threshold) continue
    // Pick a single value: unanimous → use it; otherwise take the modal value
    // only when it dominates by `modalRatio` across the observed values.
    const sortedValues = [...bucket.values.entries()].sort((a, b) => b[1] - a[1])
    const [topValue, topCount] = sortedValues[0]
    if (topCount / bucket.count < modalRatio) continue
    result[bucket.originalName] = topValue
  }
  return result
}

export const _internal = { BLOCKED_HEADERS, SECRET_HINT_RE }
