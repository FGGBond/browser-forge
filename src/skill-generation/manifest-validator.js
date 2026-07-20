import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { BUILTIN_COMMAND_IDS } from './constants.js'
import { validateDependencyGraph } from './dependency-graph.js'
import { readReadyMarker } from './generator.js'
import { scanTree } from './secret-scanner.js'

const schema = JSON.parse(await readFile(new URL('../../skills/browser-forge/schemas/manifest.schema.json', import.meta.url)))
const ajv = new Ajv2020({ allErrors: true, strict: true })
addFormats(ajv)
const validateSchema = ajv.compile(schema)

function schemaIssues(errors) {
  return (errors ?? []).map(error => ({
    code: 'SCHEMA_VALIDATION_ERROR',
    path: `manifest.json${error.instancePath}`,
    message: error.message ?? 'Manifest schema validation failed'
  }))
}

const REQUIRED_READY_FEATURES = Object.freeze([
  'manifest-command-parity',
  'progressive-help',
  'json-envelope',
  'offline-network-guard',
  'standalone-auth-runtime'
])

function issue(code, path, message) {
  return { code, path, message }
}

function commandIds(manifest) {
  return (Array.isArray(manifest?.commands) ? manifest.commands : [])
    .filter(command => command && typeof command.id === 'string')
    .map(command => command.id)
}

function commandIdsFromSkillDocument(text) {
  const ids = []
  for (const line of text.split('\n')) {
    if (!/^\s*(?:[-*+]\s+|#{3,6}\s+)/.test(line)) continue
    const quoted = line.match(/`([a-z0-9]+(?:-[a-z0-9]+)*)`/i)?.[1]
    const plain = line.match(/^\s*(?:[-*+]\s+|#{3,6}\s+)([a-z0-9]+(?:-[a-z0-9]+)*)\b/i)?.[1]
    if (quoted ?? plain) ids.push((quoted ?? plain).toLowerCase())
  }
  return [...new Set(ids)].sort()
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

async function runtimeContractIssues(skillDir, manifest, readyMarker) {
  const issues = []
  const packageName = `browser_forge_${String(manifest?.name ?? '').replaceAll('-', '_')}`
  const runtimeRoot = join(skillDir, 'scripts', 'cli', 'src', packageName)

  if (readyMarker?.auth_runtime_version !== manifest?.auth?.runtime_version) {
    issues.push(issue(
      'AUTH_VERSION_MISMATCH',
      'manifest.json/auth/runtime_version',
      'Manifest auth runtime version does not match the generated runtime version'
    ))
  }

  if (readyMarker?.envelope_version !== manifest?.cli?.envelope_version) {
    issues.push(issue(
      'ENVELOPE_VERSION_MISMATCH',
      'manifest.json/cli/envelope_version',
      'Manifest envelope version does not match the generated runtime version'
    ))
  }

  const generatedBuiltins = Array.isArray(readyMarker?.builtin_commands)
    ? [...readyMarker.builtin_commands].sort()
    : [...BUILTIN_COMMAND_IDS].sort()
  const manifestCommandIds = commandIds(manifest)
  for (const builtin of generatedBuiltins) {
    if (!manifestCommandIds.includes(builtin)) {
      issues.push(issue(
        'BUILTIN_COMMAND_MISSING',
        'manifest.json/commands',
        `Required builtin command is missing: ${builtin}`
      ))
    }
  }

  const requiredAuthFiles = ['provider.py', 'jdme_sso.py', 'browser_cookies.py', 'cookie_jar.py', 'session_store.py']
  for (const filename of requiredAuthFiles) {
    try {
      await readFile(join(runtimeRoot, 'auth', filename), 'utf8')
    } catch {
      issues.push(issue(
        'AUTH_RUNTIME_MISSING',
        `scripts/cli/src/${packageName}/auth/${filename}`,
        `Generated authentication runtime file is missing: ${filename}`
      ))
    }
  }

  try {
    const envelopeSource = await readFile(join(runtimeRoot, 'envelope.py'), 'utf8')
    const version = envelopeSource.match(/^SPEC_VERSION\s*=\s*["']([^"']+)["']/m)?.[1]
    const fields = ['spec_version', 'ok', 'command', 'status', 'data', 'artifacts', 'auth', 'next_actions']
    if (version !== manifest?.cli?.envelope_version || fields.some(field => !envelopeSource.includes(`"${field}"`))) {
      issues.push(issue(
        'ENVELOPE_CONTRACT_MISSING',
        `scripts/cli/src/${packageName}/envelope.py`,
        'Generated runtime does not implement the declared JSON envelope contract'
      ))
    }
  } catch {
    issues.push(issue(
      'ENVELOPE_CONTRACT_MISSING',
      `scripts/cli/src/${packageName}/envelope.py`,
      'Generated JSON envelope runtime is missing'
    ))
  }

  try {
    const clientSource = await readFile(join(runtimeRoot, 'client.py'), 'utf8')
    const hasNetworkEnvironmentGate = clientSource.includes('BROWSER_FORGE_DISABLE_NETWORK') ||
      /BROWSER_FORGE_["']\s*["']DISABLE_NETWORK/.test(clientSource)
    if (!hasNetworkEnvironmentGate || !clientSource.includes('NETWORK_DISABLED')) {
      issues.push(issue(
        'OFFLINE_GATE_MISSING',
        `scripts/cli/src/${packageName}/client.py`,
        'Generated client does not contain the network-disabled execution gate'
      ))
    }
  } catch {
    issues.push(issue(
      'OFFLINE_GATE_MISSING',
      `scripts/cli/src/${packageName}/client.py`,
      'Generated client runtime is missing'
    ))
  }

  try {
    const cliSource = await readFile(join(runtimeRoot, 'cli.py'), 'utf8')
    if (['Dependencies:', 'Output:', 'Next actions:'].some(section => !cliSource.includes(section))) {
      issues.push(issue(
        'HELP_CONTRACT_MISSING',
        `scripts/cli/src/${packageName}/cli.py`,
        'Generated CLI help does not contain dependency, output, and next-action sections'
      ))
    }
  } catch {
    issues.push(issue(
      'HELP_CONTRACT_MISSING',
      `scripts/cli/src/${packageName}/cli.py`,
      'Generated CLI runtime is missing'
    ))
  }

  return issues
}

async function readyContractIssues(skillDir, manifest, readyMarker) {
  const issues = []
  const manifestIds = [...new Set(commandIds(manifest))].sort()
  let skillIds = []
  try {
    skillIds = commandIdsFromSkillDocument(await readFile(join(skillDir, 'SKILL.md'), 'utf8'))
  } catch {
    // The parity issue below is stable for both a missing and unreadable SKILL.md.
  }
  if (!sameValues(manifestIds, skillIds)) {
    issues.push(issue(
      'SKILL_COMMAND_MISMATCH',
      'SKILL.md#commands',
      'SKILL.md command list must exactly match manifest commands'
    ))
  }

  for (const commandId of manifestIds.filter(commandId => !BUILTIN_COMMAND_IDS.includes(commandId))) {
    const relativePath = `references/commands/${commandId}.md`
    try {
      await readFile(join(skillDir, relativePath), 'utf8')
    } catch {
      issues.push(issue('COMMAND_DOC_MISSING', relativePath, `Business command documentation is missing: ${commandId}`))
    }
  }

  const features = Array.isArray(manifest?.required_features) ? manifest.required_features : []
  for (const feature of REQUIRED_READY_FEATURES) {
    if (!features.includes(feature)) {
      issues.push(issue(
        'REQUIRED_FEATURE_MISSING',
        'manifest.json/required_features',
        `Ready skill must declare generated capability: ${feature}`
      ))
    }
  }

  issues.push(...await runtimeContractIssues(skillDir, manifest, readyMarker))
  return issues
}

export async function validateSkill(skillDir) {
  let manifest = null
  const issues = []
  let readyMarker = null
  try {
    readyMarker = await readReadyMarker(skillDir)
    if (!readyMarker) {
      issues.push({ code: 'SKILL_NOT_READY', path: '.browser-forge-ready', message: 'Generated skill is incomplete or has no ready marker' })
    }
  } catch (error) {
    issues.push({ code: 'READY_MARKER_READ_ERROR', path: '.browser-forge-ready', message: error.message })
  }
  let manifestText
  try {
    manifestText = await readFile(join(skillDir, 'manifest.json'), 'utf8')
  } catch (error) {
    issues.push({ code: 'MANIFEST_READ_ERROR', path: 'manifest.json', message: error.message })
  }

  if (manifestText !== undefined) {
    try {
      manifest = JSON.parse(manifestText)
    } catch (error) {
      issues.push({ code: 'MANIFEST_PARSE_ERROR', path: 'manifest.json', message: error.message })
    }
  }

  if (manifestText !== undefined && !issues.some(issue => issue.code === 'MANIFEST_PARSE_ERROR')) {
    try {
      if (!validateSchema(manifest)) issues.push(...schemaIssues(validateSchema.errors))
    } catch (error) {
      issues.push({ code: 'SCHEMA_VALIDATION_ERROR', path: 'manifest.json', message: error.message })
    }
    try {
      issues.push(...validateDependencyGraph(manifest))
    } catch (error) {
      issues.push({ code: 'DEPENDENCY_GRAPH_VALIDATION_ERROR', path: 'manifest.json', message: error.message })
    }
    if (manifest?.status === 'ready') {
      try {
        issues.push(...await readyContractIssues(skillDir, manifest, readyMarker))
      } catch (error) {
        issues.push({ code: 'READY_CONTRACT_VALIDATION_ERROR', path: '.', message: error.message })
      }
    }
  }

  let findings = []
  try {
    findings = await scanTree(skillDir)
  } catch (error) {
    issues.push({ code: 'SKILL_SCAN_ERROR', path: '.', message: error.message })
  }

  if (manifest?.status === 'ready' && (issues.length > 0 || findings.length > 0)) {
    issues.push({
      code: 'READY_GATE_FAILED',
      path: 'manifest.json/status',
      message: 'Ready status requires every schema, documentation, runtime, graph, offline, and secret gate to pass'
    })
  }

  return { ok: issues.length === 0 && findings.length === 0, complete: readyMarker !== null, issues, findings, manifest }
}
