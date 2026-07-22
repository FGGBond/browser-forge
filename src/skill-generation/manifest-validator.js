import { lstat, readFile, readdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { AUTH_RUNTIME_VERSION, BUILTIN_COMMAND_IDS, SPEC_VERSION } from './constants.js'
import { validateDependencyGraph } from './dependency-graph.js'
import { readReadyMarker } from './generator.js'
import { normalizeSkillName } from './names.js'
import { scanTree } from './secret-scanner.js'
import { renderTemplateText, TEMPLATE_ROOT, templateValues } from './template-renderer.js'

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
const REQUIRED_COMMAND_DOC_SECTIONS = Object.freeze([
  'Inputs',
  ...REQUIRED_HELP_SECTIONS
])
const IMMUTABLE_RUNTIME_TEMPLATES = Object.freeze([
  ['scripts/install.sh', 'scripts/install.sh'],
  ['scripts/cli/pyproject.toml.tmpl', 'scripts/cli/pyproject.toml'],
  ['scripts/cli/src/browser_forge_generated/__init__.py', '__init__.py'],
  ['scripts/cli/src/browser_forge_generated/__main__.py', '__main__.py'],
  ['scripts/cli/src/browser_forge_generated/cli.py', 'cli.py'],
  ['scripts/cli/src/browser_forge_generated/client.py', 'client.py'],
  ['scripts/cli/src/browser_forge_generated/config.py', 'config.py'],
  ['scripts/cli/src/browser_forge_generated/envelope.py', 'envelope.py'],
  ['scripts/cli/src/browser_forge_generated/manifest.py', 'manifest.py'],
  ['scripts/cli/src/browser_forge_generated/auth/__init__.py', 'auth/__init__.py'],
  ['scripts/cli/src/browser_forge_generated/auth/browser_cookies.py', 'auth/browser_cookies.py'],
  ['scripts/cli/src/browser_forge_generated/auth/cookie_jar.py', 'auth/cookie_jar.py'],
  ['scripts/cli/src/browser_forge_generated/auth/jdme_sso.py', 'auth/jdme_sso.py'],
  ['scripts/cli/src/browser_forge_generated/auth/provider.py', 'auth/provider.py'],
  ['scripts/cli/src/browser_forge_generated/auth/session_store.py', 'auth/session_store.py']
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

    const headingItem = line.match(/^\s*#{3,6}\s+(.*)$/)?.[1]
    const listItem = line.match(/^\s*(?:[-*+]\s+|\d+\.\s+)(.*)$/)?.[1]
    const item = headingItem ?? listItem
    if (!item) continue
    const commandId = item.match(/^`([a-z0-9]+(?:-[a-z0-9]+)*)`/i)?.[1] ??
      item.match(/^\[`?([a-z0-9]+(?:-[a-z0-9]+)*)`?\]\([^)]+\)/i)?.[1] ??
      (headingItem ? item.match(/^([a-z0-9]+(?:-[a-z0-9]+)*)\b/i)?.[1] : null)
    if (commandId) ids.push(commandId.toLowerCase())
  }
  return [...new Set(ids)].sort()
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function trustedIdentifiers(manifest) {
  try {
    if (typeof manifest?.name !== 'string') return null
    const identifiers = normalizeSkillName(manifest.name)
    return identifiers.skillId === manifest?.id ? identifiers : null
  } catch {
    return null
  }
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

async function renderedTemplateFile(templateRelativePath, values) {
  const templatePath = join(TEMPLATE_ROOT, templateRelativePath)
  const source = await readFile(templatePath, 'utf8')
  return {
    contents: Buffer.from(renderTemplateText(source, values), 'utf8'),
    mode: (await stat(templatePath)).mode & 0o777
  }
}

async function artifactFileIntegrity(skillDir, artifactRelativePath, expected) {
  try {
    const artifactPath = join(skillDir, artifactRelativePath)
    const details = await lstat(artifactPath)
    if (!details.isFile() || details.isSymbolicLink()) return false
    const actual = await readFile(artifactPath)
    return (details.mode & 0o777) === expected.mode && actual.equals(expected.contents)
  } catch {
    return false
  }
}

async function entrypointIntegrityIssues(skillDir, manifest, identifiers, values) {
  const expectedPath = identifiers ? `scripts/${identifiers.entrypointName}` : null
  if (!expectedPath || manifest?.cli?.entrypoint !== expectedPath) {
    return [issue(
      'ENTRYPOINT_INVALID',
      'manifest.json/cli/entrypoint',
      'CLI entrypoint path must exactly match the trusted generated wrapper path'
    )]
  }

  const expected = await renderedTemplateFile('scripts/browser_forge-skill.tmpl', values)
  if (!await artifactFileIntegrity(skillDir, expectedPath, expected)) {
    return [issue(
      'ENTRYPOINT_INVALID',
      expectedPath,
      `CLI entrypoint content and mode must exactly match trusted template SHA256 ${sha256(expected.contents)}`
    )]
  }
  return []
}

async function unexpectedRuntimePaths(skillDir, identifiers) {
  const sourceRoot = join(skillDir, 'scripts', 'cli', 'src')
  const packageRoot = identifiers.packageName
  const allowedDirectories = new Set([
    packageRoot,
    `${packageRoot}/auth`,
    `${packageRoot}/commands`
  ])
  const allowedFiles = new Set(IMMUTABLE_RUNTIME_TEMPLATES.flatMap(([, runtimeRelativePath]) =>
    runtimeRelativePath.startsWith('scripts/') ? [] : [`${packageRoot}/${runtimeRelativePath}`]
  ))
  const unexpected = []

  async function visit(directory, relativeDirectory = '') {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === '__pycache__') continue
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) {
        unexpected.push(relativePath)
        continue
      }
      if (entry.isDirectory()) {
        if (!allowedDirectories.has(relativePath) && !relativePath.startsWith(`${packageRoot}/commands/`)) {
          unexpected.push(relativePath)
          continue
        }
        await visit(join(directory, entry.name), relativePath)
        continue
      }
      if (!entry.isFile()) {
        unexpected.push(relativePath)
        continue
      }
      if (!allowedFiles.has(relativePath) && !relativePath.startsWith(`${packageRoot}/commands/`)) {
        unexpected.push(relativePath)
      }
    }
  }

  try {
    await visit(sourceRoot)
  } catch {
    return ['scripts/cli/src']
  }
  return unexpected.sort()
}

async function runtimeIntegrityIssues(skillDir, manifest) {
  const issues = []
  const identifiers = trustedIdentifiers(manifest)
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

  if (manifest?.auth?.runtime_version !== AUTH_RUNTIME_VERSION) {
    issues.push(issue(
      'AUTH_VERSION_MISMATCH',
      'manifest.json/auth/runtime_version',
      `Manifest auth runtime version must equal trusted runtime version ${AUTH_RUNTIME_VERSION}`
    ))
  }
  if (manifest?.cli?.envelope_version !== SPEC_VERSION) {
    issues.push(issue(
      'ENVELOPE_VERSION_MISMATCH',
      'manifest.json/cli/envelope_version',
      `Manifest envelope version must equal trusted runtime version ${SPEC_VERSION}`
    ))
  }

  if (!identifiers) {
    issues.push(issue(
      'RUNTIME_INTEGRITY_FAILED',
      'manifest.json/id',
      'Manifest identity cannot be mapped to trusted generated runtime identifiers'
    ))
    issues.push(...await entrypointIntegrityIssues(skillDir, manifest, identifiers, null))
    return issues
  }

  const values = templateValues(identifiers, manifest?.description, manifest?.auth?.target_domains)
  const runtimeRoot = `scripts/cli/src/${identifiers.packageName}`
  for (const [templateRelativePath, runtimeRelativePath] of IMMUTABLE_RUNTIME_TEMPLATES) {
    const artifactRelativePath = runtimeRelativePath.startsWith('scripts/')
      ? runtimeRelativePath
      : `${runtimeRoot}/${runtimeRelativePath}`
    const expected = await renderedTemplateFile(templateRelativePath, values)
    if (!await artifactFileIntegrity(skillDir, artifactRelativePath, expected)) {
      issues.push(issue(
        'RUNTIME_INTEGRITY_FAILED',
        artifactRelativePath,
        `Immutable runtime file must exactly match trusted template SHA256 ${sha256(expected.contents)}`
      ))
    }
  }
  const unexpectedPaths = await unexpectedRuntimePaths(skillDir, identifiers)
  if (unexpectedPaths.length > 0) {
    issues.push(issue(
      'RUNTIME_INTEGRITY_FAILED',
      unexpectedPaths[0],
      `Generated runtime contains paths outside the trusted infrastructure and commands extension allowlist: ${unexpectedPaths.join(', ')}`
    ))
  }
  issues.push(...await entrypointIntegrityIssues(skillDir, manifest, identifiers, values))

  return issues
}

function helpMetadataIssues(manifest) {
  const issues = []
  const commands = Array.isArray(manifest?.commands) ? manifest.commands : []
  for (const [commandIndex, rawCommand] of commands.entries()) {
    const command = rawCommand && typeof rawCommand === 'object' && !Array.isArray(rawCommand) ? rawCommand : {}
    const missingMetadata = [
      typeof command.summary === 'string' && command.summary.trim() !== '',
      typeof command.side_effect === 'boolean',
      typeof command.idempotent === 'boolean',
      Array.isArray(command.inputs),
      typeof command.outputs?.schema_ref === 'string' && command.outputs.schema_ref !== '',
      typeof command.requires?.auth === 'boolean',
      Array.isArray(command.requires?.commands),
      Array.isArray(command.next_actions)
    ].some(valid => !valid)
    const invalidInputs = (Array.isArray(command.inputs) ? command.inputs : []).some(input =>
      typeof input?.name !== 'string' || input.name === '' ||
      typeof input?.type !== 'string' || input.type === '' ||
      typeof input?.required !== 'boolean' ||
      !Array.isArray(input?.sources)
    )
    const missingSourcePath = (Array.isArray(command.inputs) ? command.inputs : []).some(input =>
      (Array.isArray(input?.sources) ? input.sources : []).some(source =>
        typeof source?.command !== 'string' || source.command === '' ||
        typeof source?.json_path !== 'string' || source.json_path === ''
      )
    )
    if (missingMetadata || invalidInputs || missingSourcePath) {
      issues.push(issue(
        'HELP_CONTRACT_MISSING',
        `manifest.json/commands/${commandIndex}`,
        `Command help metadata or input source JSONPath is incomplete: ${command.id ?? commandIndex}`
      ))
    }
  }
  return issues
}

function markdownSectionMissing(text, section) {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return !new RegExp(`^#{2,6}[ \\t]+${escaped}[ \\t]*#*[ \\t]*$`, 'im').test(text)
}

function commandDocumentIssues(text, command, relativePath) {
  const missingSections = REQUIRED_COMMAND_DOC_SECTIONS.filter(section => markdownSectionMissing(text, section))
  const missingSources = (Array.isArray(command?.inputs) ? command.inputs : []).flatMap(input =>
    (Array.isArray(input?.sources) ? input.sources : [])
  ).filter(source =>
    typeof source?.command !== 'string' || !text.includes(source.command) ||
    typeof source?.json_path !== 'string' || !text.includes(source.json_path)
  )
  const schemaRef = command?.outputs?.schema_ref
  if (missingSections.length === 0 && missingSources.length === 0 && typeof schemaRef === 'string' && text.includes(schemaRef)) {
    return []
  }
  return [issue(
    'HELP_CONTRACT_MISSING',
    relativePath,
    `Command documentation lacks required help metadata or source JSONPath: ${command?.id ?? 'unknown'}`
  )]
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
      const command = manifest.commands.find(candidate => candidate?.id === commandId)
      issues.push(...commandDocumentIssues(await readFile(join(skillDir, relativePath), 'utf8'), command, relativePath))
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

  issues.push(...helpMetadataIssues(manifest))
  issues.push(...await runtimeIntegrityIssues(skillDir, manifest))
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
  }

  let findings = []
  try {
    findings = await scanTree(skillDir)
  } catch (error) {
    issues.push({ code: 'SKILL_SCAN_ERROR', path: '.', message: error.message })
  }

  if (manifest?.status === 'ready') {
    try {
      issues.push(...await readyContractIssues(skillDir, manifest))
    } catch (error) {
      issues.push({ code: 'READY_CONTRACT_VALIDATION_ERROR', path: '.', message: error.message })
    }
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
