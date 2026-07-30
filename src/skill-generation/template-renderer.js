import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AUTH_RUNTIME_VERSION, SPEC_VERSION } from './constants.js'

function firstExistingPath(urls) {
  for (const url of urls) {
    const path = fileURLToPath(url)
    if (existsSync(path)) return path
  }
  return fileURLToPath(urls.at(-1))
}

export const TEMPLATE_ROOT = firstExistingPath([
  new URL('../../assets/skill-template/', import.meta.url),
  new URL('../../skills/browser-forge/assets/skill-template/', import.meta.url)
])

const TEMPLATE_TOKENS = Object.freeze([
  'SKILL_NAME',
  'SKILL_ID',
  'PACKAGE_NAME',
  'ENTRYPOINT_NAME',
  'DESCRIPTION',
  'DESCRIPTION_YAML',
  'TARGET_URLS_JSON',
  'TARGET_HOSTS_JSON',
  'AUTH_STRATEGY',
  'DEFAULT_HEADERS_JSON',
  'SPEC_VERSION',
  'AUTH_RUNTIME_VERSION'
])
const TOKEN_PATTERN = new RegExp(`\\{\\{(${TEMPLATE_TOKENS.join('|')})\\}\\}`, 'g')

function deriveHost(url) {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return String(url).trim().toLowerCase()
  }
}

function looksLikeJdHost(host) {
  const trimmed = host.replace(/\.$/, '')
  return trimmed === 'jd.com' || trimmed.endsWith('.jd.com')
}

export function suggestAuthStrategy(targetUrls) {
  const hosts = targetUrls.map(deriveHost).filter(Boolean)
  if (hosts.length === 0) return 'none'
  if (hosts.some(looksLikeJdHost)) return 'jd-internal'
  return 'browser-cookie'
}

export function templateValues(identifiers, description, targetUrls, extras = {}) {
  const hosts = [...new Set(targetUrls.map(deriveHost).filter(Boolean))]
  const strategy = extras.authStrategy ?? suggestAuthStrategy(targetUrls)
  const defaultHeaders = extras.defaultHeaders ?? {}
  const desc = description ?? ''
  return {
    SKILL_NAME: identifiers.skillName,
    SKILL_ID: identifiers.skillId,
    PACKAGE_NAME: identifiers.packageName,
    ENTRYPOINT_NAME: identifiers.entrypointName,
    DESCRIPTION: JSON.stringify(desc),
    DESCRIPTION_YAML: JSON.stringify(desc), // JSON strings are valid YAML flow scalars
    TARGET_URLS_JSON: JSON.stringify(targetUrls),
    TARGET_HOSTS_JSON: JSON.stringify(hosts),
    AUTH_STRATEGY: JSON.stringify(strategy),
    DEFAULT_HEADERS_JSON: JSON.stringify(defaultHeaders),
    SPEC_VERSION,
    AUTH_RUNTIME_VERSION
  }
}

export function renderTemplateText(text, values) {
  return text.replace(TOKEN_PATTERN, (_token, name) => {
    if (!Object.hasOwn(values, name)) throw new Error(`Missing trusted template value: ${name}`)
    return values[name]
  })
}
