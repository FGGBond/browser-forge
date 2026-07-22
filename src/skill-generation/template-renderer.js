import { fileURLToPath } from 'node:url'
import { AUTH_RUNTIME_VERSION, SPEC_VERSION } from './constants.js'

export const TEMPLATE_ROOT = fileURLToPath(new URL('../../skills/browser-forge/assets/skill-template/', import.meta.url))

const TEMPLATE_TOKENS = Object.freeze([
  'SKILL_NAME',
  'SKILL_ID',
  'PACKAGE_NAME',
  'ENTRYPOINT_NAME',
  'DESCRIPTION',
  'TARGET_DOMAINS_JSON',
  'SPEC_VERSION',
  'AUTH_RUNTIME_VERSION'
])
const TOKEN_PATTERN = new RegExp(`\\{\\{(${TEMPLATE_TOKENS.join('|')})\\}\\}`, 'g')

export function templateValues(identifiers, description, targetDomains) {
  return {
    SKILL_NAME: identifiers.skillName,
    SKILL_ID: identifiers.skillId,
    PACKAGE_NAME: identifiers.packageName,
    ENTRYPOINT_NAME: identifiers.entrypointName,
    DESCRIPTION: JSON.stringify(description),
    TARGET_DOMAINS_JSON: JSON.stringify(targetDomains),
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
