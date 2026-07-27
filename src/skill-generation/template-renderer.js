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
  'TARGET_DOMAINS_JSON',
  'AUTH_PROVIDERS_JSON',
  'SPEC_VERSION',
  'AUTH_RUNTIME_VERSION'
])
const TOKEN_PATTERN = new RegExp(`\\{\\{(${TEMPLATE_TOKENS.join('|')})\\}\\}`, 'g')

export function templateValues(identifiers, description, targetDomains) {
  const hasJdTarget = targetDomains.some(value => {
    const domain = String(value).trim().toLowerCase().replace(/\.$/, '')
    return domain === 'jd.com' || domain.endsWith('.jd.com')
  })
  return {
    SKILL_NAME: identifiers.skillName,
    SKILL_ID: identifiers.skillId,
    PACKAGE_NAME: identifiers.packageName,
    ENTRYPOINT_NAME: identifiers.entrypointName,
    DESCRIPTION: JSON.stringify(description),
    TARGET_DOMAINS_JSON: JSON.stringify(targetDomains),
    AUTH_PROVIDERS_JSON: JSON.stringify(hasJdTarget ? ['jdme_sso', 'browser_cookie'] : ['browser_cookie']),
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
