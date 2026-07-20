import { readFile, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
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
const REQUIRED_HELP_SECTIONS = Object.freeze([
  'Dependencies',
  'Authentication',
  'Output',
  'Next actions',
  'Side effects',
  'Idempotency',
  'Examples'
])
const ENVELOPE_FIELDS = Object.freeze([
  'spec_version',
  'ok',
  'command',
  'status',
  'data',
  'artifacts',
  'auth',
  'next_actions'
])

function issue(code, path, message) {
  return { code, path, message }
}

function commandIds(manifest) {
  return (Array.isArray(manifest?.commands) ? manifest.commands : [])
    .filter(command => command && typeof command.id === 'string')
    .map(command => command.id)
}

export function commandIdsFromSkillDocument(text) {
  const ids = []
  let inCommandsSection = false
  for (const line of text.split('\n')) {
    if (/^##[ \t]+commands[ \t]*#*[ \t]*$/i.test(line)) {
      inCommandsSection = true
      continue
    }
    if (inCommandsSection && /^#{1,2}[ \t]+/.test(line)) break
    if (!inCommandsSection) continue

    const item = line.match(/^\s*(?:[-*+]\s+|\d+\.\s+|#{3,6}\s+)(.*)$/)?.[1]
    if (!item) continue
    const commandId = item.match(/^`([a-z0-9]+(?:-[a-z0-9]+)*)`/i)?.[1] ??
      item.match(/^\[`?([a-z0-9]+(?:-[a-z0-9]+)*)`?\]\([^)]+\)/i)?.[1] ??
      item.match(/^([a-z0-9]+(?:-[a-z0-9]+)*)\b/i)?.[1]
    if (commandId) ids.push(commandId.toLowerCase())
  }
  return [...new Set(ids)].sort()
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function runtimePackageName(manifest) {
  const skillName = String(manifest?.id ?? '').match(/^browser_forge\.([a-z0-9]+(?:-[a-z0-9]+)*)$/)?.[1]
  return skillName ? `browser_forge_${skillName.replaceAll('-', '_')}` : null
}

function findSystemPython() {
  for (const command of ['python3', 'python']) {
    const result = spawnSync(command, [
      '-c',
      'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'
    ], { encoding: 'utf8', timeout: 5_000 })
    if (result.status === 0) return command
  }
  return null
}

function runGeneratedPython(python, skillDir, packageName, args) {
  const environment = {
    ...process.env,
    PYTHONPATH: join(skillDir, 'scripts', 'cli', 'src'),
    BROWSER_FORGE_MANIFEST_PATH: join(skillDir, 'manifest.json'),
    BROWSER_FORGE_DISABLE_NETWORK: '1'
  }
  delete environment.PYTHONHOME
  delete environment.BROWSER_FORGE_BASE_URL
  delete environment.BROWSER_FORGE_AUTH_VALUE
  delete environment.BROWSER_FORGE_COOKIE_VALUE
  return spawnSync(python, args[0] === '-c' ? args : ['-m', packageName, ...args], {
    cwd: skillDir,
    encoding: 'utf8',
    env: environment,
    timeout: 10_000,
    maxBuffer: 1024 * 1024
  })
}

function parseSingleJsonLine(text) {
  const lines = String(text ?? '').trim().split(/\r?\n/)
  if (lines.length !== 1 || lines[0] === '') return null
  try {
    const parsed = JSON.parse(lines[0])
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function entrypointContractIssues(skillDir, manifest, packageName) {
  const issues = []
  const relativePath = manifest?.cli?.entrypoint
  if (typeof relativePath !== 'string' || !packageName) {
    return [issue('ENTRYPOINT_TARGET_MISMATCH', 'manifest.json/cli/entrypoint', 'CLI entrypoint does not target the generated runtime package')]
  }

  const entrypointPath = join(skillDir, relativePath)
  let details
  try {
    details = await stat(entrypointPath)
  } catch {
    return [issue('ENTRYPOINT_MISSING', relativePath, 'Declared CLI entrypoint file is missing')]
  }
  if (!details.isFile()) {
    issues.push(issue('ENTRYPOINT_MISSING', relativePath, 'Declared CLI entrypoint is not a file'))
    return issues
  }
  if ((details.mode & 0o111) === 0) {
    issues.push(issue('ENTRYPOINT_NOT_EXECUTABLE', relativePath, 'Declared CLI entrypoint is not executable'))
  }

  try {
    const source = await readFile(entrypointPath, 'utf8')
    if (!source.includes(`PACKAGE_NAME="${packageName}"`) || !source.includes('-m "$PACKAGE_NAME"')) {
      issues.push(issue('ENTRYPOINT_TARGET_MISMATCH', relativePath, 'CLI entrypoint does not target the generated runtime package'))
    }
  } catch {
    issues.push(issue('ENTRYPOINT_TARGET_MISMATCH', relativePath, 'CLI entrypoint could not be inspected'))
  }
  return issues
}

function runtimeExecutionIssues(skillDir, manifest, packageName) {
  const issues = []
  const python = findSystemPython()
  if (!python || !packageName) {
    return [issue(
      'RUNTIME_PYTHON_UNAVAILABLE',
      'manifest.json/cli/python_requires',
      'Python 3.10 or newer is required to validate the generated runtime'
    )]
  }

  const authProbe = runGeneratedPython(python, skillDir, packageName, [
    '-c',
    `import json; from ${packageName}.auth import AUTH_RUNTIME_VERSION; print(json.dumps(AUTH_RUNTIME_VERSION))`
  ])
  let authVersion = null
  if (authProbe.status === 0) {
    try {
      authVersion = JSON.parse(String(authProbe.stdout).trim())
    } catch {
      // The stable mismatch below covers unreadable runtime version output.
    }
  }
  if (authVersion !== manifest?.auth?.runtime_version) {
    issues.push(issue(
      'AUTH_VERSION_MISMATCH',
      'manifest.json/auth/runtime_version',
      'Manifest auth runtime version does not match the copied runtime code version'
    ))
  }

  const described = runGeneratedPython(python, skillDir, packageName, ['describe'])
  const describedPayload = described.status === 0 ? parseSingleJsonLine(described.stdout) : null
  if (described.status !== 0) {
    issues.push(issue(
      'RUNTIME_DESCRIBE_FAILED',
      'manifest.json/commands',
      'Generated runtime could not execute describe from its source tree'
    ))
  } else if (!describedPayload) {
    issues.push(issue(
      'RUNTIME_DESCRIBE_INVALID_JSON',
      'manifest.json/commands',
      'Generated runtime describe output must be exactly one JSON object'
    ))
  } else {
    if (
      describedPayload.ok !== true ||
      ENVELOPE_FIELDS.some(field => !Object.hasOwn(describedPayload, field))
    ) {
      issues.push(issue(
        'ENVELOPE_CONTRACT_MISSING',
        'manifest.json/cli/envelope_version',
        'Generated runtime describe output does not implement the JSON envelope contract'
      ))
    }
    if (describedPayload.spec_version !== manifest?.cli?.envelope_version) {
      issues.push(issue(
        'ENVELOPE_VERSION_MISMATCH',
        'manifest.json/cli/envelope_version',
        'Manifest envelope version does not match generated runtime output'
      ))
    }
    const describedIds = commandIds(describedPayload?.data?.manifest).sort()
    const manifestIds = commandIds(manifest).sort()
    if (!sameValues(describedIds, manifestIds)) {
      issues.push(issue(
        'RUNTIME_COMMAND_MISMATCH',
        'manifest.json/commands',
        'Generated runtime describe command set must exactly match manifest commands'
      ))
    }
  }

  for (const commandId of commandIds(manifest)) {
    const help = runGeneratedPython(python, skillDir, packageName, [commandId, '--help'])
    if (help.status !== 0) {
      issues.push(issue(
        'COMMAND_HELP_FAILED',
        `${manifest.cli.entrypoint}#${commandId}`,
        `Generated runtime help failed for command: ${commandId}`
      ))
      continue
    }
    const missingSections = REQUIRED_HELP_SECTIONS.filter(section => {
      const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return !new RegExp(`^\\s*${escaped}:\\s*$`, 'm').test(help.stdout)
    })
    if (missingSections.length > 0) {
      issues.push(issue(
        'HELP_CONTRACT_MISSING',
        `${manifest.cli.entrypoint}#${commandId}`,
        `Generated runtime help is missing required sections for ${commandId}: ${missingSections.join(', ')}`
      ))
    }
  }

  return issues
}

async function runtimeContractIssues(skillDir, manifest) {
  const issues = []
  const packageName = runtimePackageName(manifest)
  const manifestCommandIds = commandIds(manifest)
  for (const builtin of BUILTIN_COMMAND_IDS) {
    if (!manifestCommandIds.includes(builtin)) {
      issues.push(issue(
        'BUILTIN_COMMAND_MISSING',
        'manifest.json/commands',
        `Required builtin command is missing: ${builtin}`
      ))
    }
  }

  if (!packageName) {
    issues.push(...await entrypointContractIssues(skillDir, manifest, packageName))
    issues.push(...runtimeExecutionIssues(skillDir, manifest, packageName))
    return issues
  }

  const runtimeRoot = join(skillDir, 'scripts', 'cli', 'src', packageName)

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

  issues.push(...await entrypointContractIssues(skillDir, manifest, packageName))
  issues.push(...runtimeExecutionIssues(skillDir, manifest, packageName))

  return issues
}

async function readyContractIssues(skillDir, manifest) {
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

  issues.push(...await runtimeContractIssues(skillDir, manifest))
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
        issues.push(...await readyContractIssues(skillDir, manifest))
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
