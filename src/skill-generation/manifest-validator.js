import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { AUTH_RUNTIME_VERSION, AUTH_STRATEGIES, BUILTIN_COMMAND_IDS, SPEC_VERSION } from './constants.js'
import { validateDependencyGraph } from './dependency-graph.js'
import { readReadyMarker } from './generator.js'
import { normalizeSkillName } from './names.js'
import { scanTree } from './secret-scanner.js'
import { renderTemplateText, TEMPLATE_ROOT, templateValues } from './template-renderer.js'

async function readFirstAvailableJson(urls) {
  const errors = []
  for (const url of urls) {
    try {
      return JSON.parse(await readFile(url, 'utf8'))
    } catch (error) {
      errors.push(`${url.pathname}: ${error.message}`)
    }
  }
  throw new Error(`Unable to read Browser Forge manifest schema from known locations: ${errors.join('; ')}`)
}

const schema = await readFirstAvailableJson([
  new URL('../../schemas/manifest.schema.json', import.meta.url),
  new URL('../../skills/browser-forge/schemas/manifest.schema.json', import.meta.url)
])
const ajv = new Ajv2020({ allErrors: true, strict: 'log', strictRequired: false })
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
  'external-auth-runtime'
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

// Runtime files that must exactly match the trusted template. Business code
// (anything under `commands/`) is intentionally excluded — users can add,
// remove, and edit those freely.
const IMMUTABLE_RUNTIME_TEMPLATES = Object.freeze([
  ['scripts/install.sh', 'scripts/install.sh'],
  ['scripts/cli/pyproject.toml.tmpl', 'scripts/cli/pyproject.toml'],
  ['scripts/cli/src/browser_forge_generated/__init__.py', '__init__.py'],
  ['scripts/cli/src/browser_forge_generated/__main__.py', '__main__.py'],
  ['scripts/cli/src/browser_forge_generated/cli.py', 'cli.py'],
  ['scripts/cli/src/browser_forge_generated/http.py', 'http.py'],
  ['scripts/cli/src/browser_forge_generated/auth.py', 'auth.py'],
  ['scripts/cli/src/browser_forge_generated/handler.py', 'handler.py'],
  ['scripts/cli/src/browser_forge_generated/config.py', 'config.py'],
  ['scripts/cli/src/browser_forge_generated/envelope.py', 'envelope.py'],
  ['scripts/cli/src/browser_forge_generated/manifest.py', 'manifest.py'],
  ['scripts/cli/src/browser_forge_generated/telemetry.py', 'telemetry.py'],
  ['scripts/cli/src/browser_forge_generated/commands/__init__.py', 'commands/__init__.py']
])

// Headers that must never be sunk into manifest.transport.default_headers.
const HEADER_SECRET_RE = /(cookie|authorization|x-jacp-token|me_token|iam_token|.*[-_](?:token|ticket|secret|key|password))/i

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
    const commandId = item.match(/^`([a-z0-9]+(?:[-:][a-z0-9]+)*)`/i)?.[1] ??
      item.match(/^\[`?([a-z0-9]+(?:[-:][a-z0-9]+)*)`?\]\([^)]+\)/i)?.[1] ??
      (headingItem ? item.match(/^([a-z0-9]+(?:[-:][a-z0-9]+)*)\b/i)?.[1] : null)
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
    mode: (await stat(templatePath)).mode & 0o7777
  }
}

async function artifactFileIntegrity(skillDir, artifactRelativePath, expected) {
  try {
    const artifactPath = join(skillDir, artifactRelativePath)
    const skillRoot = `${await realpath(skillDir)}/`
    const actualPath = await realpath(artifactPath)
    if (!actualPath.startsWith(skillRoot)) return false
    const details = await lstat(artifactPath)
    if (!details.isFile() || details.isSymbolicLink()) return false
    const actual = await readFile(artifactPath)
    return (details.mode & 0o7777) === expected.mode && actual.equals(expected.contents)
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
  // Only enforce that runtime *directory* structure and immutable files exist
  // where expected. Business commands under `commands/` are user-owned.
  const sourceRoot = join(skillDir, 'scripts', 'cli', 'src')
  const packageRoot = identifiers.packageName
  const allowedFrameworkFiles = new Set(IMMUTABLE_RUNTIME_TEMPLATES.flatMap(([, runtimeRelativePath]) =>
    runtimeRelativePath.startsWith('scripts/') ? [] : [`${packageRoot}/${runtimeRelativePath}`]
  ))
  const missing = []

  try {
    // Every immutable file must exist as a real regular file (not symlink).
    for (const relativePath of allowedFrameworkFiles) {
      try {
        const details = await lstat(join(sourceRoot, relativePath))
        if (!details.isFile() || details.isSymbolicLink()) missing.push(relativePath)
      } catch {
        missing.push(relativePath)
      }
    }
    // The package root must exist.
    const packageStat = await lstat(join(sourceRoot, packageRoot))
    if (!packageStat.isDirectory()) missing.push(packageRoot)
  } catch {
    return ['scripts/cli/src']
  }

  return missing.sort()
}

async function forbiddenExecutionPathIssues(skillDir) {
  const forbidden = []

  async function visit(directory, relativeDirectory = '') {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) {
        forbidden.push(relativePath)
        continue
      }
      if (
        entry.name === '.venv' ||
        entry.name === '__pycache__' ||
        /\.(?:pyc|pyo)$/i.test(entry.name)
      ) {
        forbidden.push(relativePath)
        continue
      }
      if (entry.isDirectory() && !entry.isSymbolicLink() && !['.git', 'node_modules'].includes(entry.name)) {
        await visit(join(directory, entry.name), relativePath)
      }
    }
  }

  await visit(skillDir)
  return forbidden.sort().map(path => issue(
    'FORBIDDEN_EXECUTION_PATH',
    path,
    'Ready skills must not contain virtualenvs, bytecode caches, or compiled Python launch artifacts'
  ))
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

  const targetUrls = Array.isArray(manifest?.auth?.target_urls) ? manifest.auth.target_urls : []
  const strategy = manifest?.auth?.strategy ?? 'none'
  const defaultHeaders = manifest?.transport?.default_headers ?? {}
  const values = templateValues(identifiers, manifest?.description ?? '', targetUrls, {
    authStrategy: strategy,
    defaultHeaders
  })
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
  const missing = await unexpectedRuntimePaths(skillDir, identifiers)
  if (missing.length > 0) {
    issues.push(issue(
      'RUNTIME_INTEGRITY_FAILED',
      missing[0],
      `Generated runtime is missing required framework files: ${missing.join(', ')}`
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
      Array.isArray(command.next_actions),
      command.side_effect !== true || (
        ['supported', 'unsupported'].includes(command.safety?.dry_run) &&
        ['safe', 'duplicate-effect', 'unsafe'].includes(command.safety?.retry_risk) &&
        typeof command.safety?.verification === 'string' && command.safety.verification.trim() !== ''
      )
    ].some(valid => !valid)
    const invalidInputs = (Array.isArray(command.inputs) ? command.inputs : []).some(input =>
      typeof input?.name !== 'string' || input.name === '' ||
      typeof input?.type !== 'string' || input.type === '' ||
      typeof input?.required !== 'boolean'
    )
    if (missingMetadata || invalidInputs) {
      issues.push(issue(
        'HELP_CONTRACT_MISSING',
        `manifest.json/commands/${commandIndex}`,
        `Command help metadata or input source JSONPath is incomplete: ${command.id ?? commandIndex}`
      ))
    }
  }
  return issues
}

function duplicateCommandIssues(manifest) {
  const seen = new Set()
  const duplicates = []
  for (const commandId of commandIds(manifest)) {
    if (seen.has(commandId)) duplicates.push(commandId)
    seen.add(commandId)
  }
  return [...new Set(duplicates)].map(commandId => issue(
    'DUPLICATE_COMMAND_ID',
    'manifest.json/commands',
    `Command ids must be unique; duplicate found: ${commandId}`
  ))
}

function outputSchemaIssues(manifest) {
  const root = manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : {}
  return (Array.isArray(manifest?.commands) ? manifest.commands : []).flatMap((command, index) => {
    const schemaRef = command?.outputs?.schema_ref
    if (typeof schemaRef === 'string' && resolveLocalJsonPointer(root, schemaRef) !== undefined) return []
    return [issue(
      'OUTPUT_SCHEMA_MISSING',
      `manifest.json/commands/${index}/outputs/schema_ref`,
      `Command output schema_ref must resolve to a manifest $defs entry: ${schemaRef ?? command?.id ?? index}`
    )]
  })
}

function outputDefinitionIssues(manifest) {
  const definitions = manifest?.$defs
  if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) return []
  for (const [name, definition] of Object.entries(definitions)) {
    if (typeof definition !== 'boolean' && (!definition || typeof definition !== 'object' || Array.isArray(definition))) {
      return [issue(
        'OUTPUT_SCHEMA_INVALID',
        `manifest.json/$defs/${name}`,
        `Output definition is not a JSON Schema: ${name}`
      )]
    }
  }
  try {
    const definitionAjv = new Ajv2020({ allErrors: true, strict: 'log', strictRequired: false })
    addFormats(definitionAjv)
    definitionAjv.compile({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $defs: definitions
    })
    return []
  } catch (error) {
    return [issue(
      'OUTPUT_SCHEMA_INVALID',
      'manifest.json/$defs',
      `Output definitions must compile as JSON Schema: ${error.message}`
    )]
  }
}

function authStrategyPolicyIssues(manifest) {
  const strategy = manifest?.auth?.strategy
  if (!AUTH_STRATEGIES.includes(strategy)) {
    return [issue(
      'AUTH_STRATEGY_INVALID',
      'manifest.json/auth/strategy',
      `Auth strategy must be one of ${AUTH_STRATEGIES.join(', ')}`
    )]
  }
  return []
}

function transportHeaderPolicyIssues(manifest) {
  const issues = []
  const defaultHeaders = manifest?.transport?.default_headers ?? {}
  for (const name of Object.keys(defaultHeaders)) {
    if (HEADER_SECRET_RE.test(name)) {
      issues.push(issue(
        'TRANSPORT_HEADER_SECRET',
        `manifest.json/transport/default_headers/${name}`,
        `Header ${JSON.stringify(name)} looks like a credential and must not be hardcoded in the manifest`
      ))
    }
  }
  const perHost = manifest?.transport?.per_host ?? {}
  for (const [host, headers] of Object.entries(perHost)) {
    for (const name of Object.keys(headers ?? {})) {
      if (HEADER_SECRET_RE.test(name)) {
        issues.push(issue(
          'TRANSPORT_HEADER_SECRET',
          `manifest.json/transport/per_host/${host}/${name}`,
          `Header ${JSON.stringify(name)} on ${JSON.stringify(host)} looks like a credential and must not be hardcoded`
        ))
      }
    }
  }
  return issues
}

async function handlerReferenceIssues(skillDir, manifest) {
  const identifiers = trustedIdentifiers(manifest)
  if (!identifiers) return []
  const issues = []
  const commandsDir = join(skillDir, 'scripts', 'cli', 'src', identifiers.packageName, 'commands')
  for (const command of manifest?.commands ?? []) {
    const handler = command?.handler
    if (typeof handler !== 'string' || !handler) continue
    const [moduleName, functionName] = handler.split(':')
    if (!moduleName || !functionName) {
      issues.push(issue('HANDLER_REFERENCE_INVALID', `manifest.json/commands/${command.id}/handler`,
        `handler must be "<module>:<function>": ${handler}`))
      continue
    }
    const relativeParts = moduleName.split('.')
    relativeParts[relativeParts.length - 1] += '.py'
    const modulePath = join(commandsDir, ...relativeParts)
    try {
      const source = await readFile(modulePath, 'utf8')
      const fnRe = new RegExp(String.raw`^\s*def\s+${functionName}\s*\(`, 'm')
      if (!fnRe.test(source)) {
        issues.push(issue('HANDLER_REFERENCE_INVALID',
          `manifest.json/commands/${command.id}/handler`,
          `${moduleName}.py does not define ${functionName}(...)`))
      }
    } catch {
      issues.push(issue('HANDLER_REFERENCE_INVALID',
        `manifest.json/commands/${command.id}/handler`,
        `handler module not found: commands/${relativeParts.join('/')}`))
    }
  }
  return issues
}

function skillMetadataIssues(text, manifest, identifiers) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) {
    return [issue('SKILL_METADATA_INVALID', 'SKILL.md', 'SKILL.md must begin with YAML frontmatter')]
  }
  const fields = {}
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim() && !/^[A-Za-z][A-Za-z0-9_-]*\s*:/.test(line)) {
      return [issue('SKILL_METADATA_INVALID', 'SKILL.md', 'SKILL.md frontmatter must be parseable YAML metadata')]
    }
    if (/\[[^\]]*$|\{[^}]*$/.test(line)) {
      return [issue('SKILL_METADATA_INVALID', 'SKILL.md', 'SKILL.md frontmatter must be parseable YAML metadata')]
    }
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if (value.startsWith('"')) {
      try { value = JSON.parse(value) } catch { /* Report normalized mismatch below. */ }
    }
    fields[key] = value
  }
  if (
    fields.name !== identifiers?.skillName ||
    typeof fields.description !== 'string' ||
    fields.description.trim() === '' ||
    fields.description !== manifest?.description
  ) {
    return [issue(
      'SKILL_METADATA_INVALID',
      'SKILL.md',
      'SKILL.md frontmatter name and description must match the generated manifest identity'
    )]
  }
  return []
}

function resolveLocalJsonPointer(root, reference) {
  if (typeof reference !== 'string' || !reference.startsWith('#/')) return undefined
  const rawTokens = reference.slice(2).split('/')
  if (rawTokens.some(token => /~(?![01])/.test(token))) return undefined
  const tokens = rawTokens.map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'))
  let current = root
  for (const token of tokens) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || !Object.hasOwn(current, token)) {
      return undefined
    }
    current = current[token]
  }
  return current
}

function readyMarkerIssues(marker) {
  const markerBuiltinCommands = Array.isArray(marker?.builtin_commands) ? marker.builtin_commands : []
  const issues = []
  if (marker?.spec_version !== SPEC_VERSION) {
    issues.push(issue(
      'READY_MARKER_VERSION_MISMATCH',
      '.browser-forge-ready/spec_version',
      `Ready marker spec_version must equal ${SPEC_VERSION}`
    ))
  }
  if (marker?.auth_runtime_version !== AUTH_RUNTIME_VERSION) {
    issues.push(issue(
      'READY_MARKER_VERSION_MISMATCH',
      '.browser-forge-ready/auth_runtime_version',
      `Ready marker auth_runtime_version must equal ${AUTH_RUNTIME_VERSION}`
    ))
  }
  if (!sameValues([...markerBuiltinCommands].sort(), [...BUILTIN_COMMAND_IDS].sort())) {
    issues.push(issue(
      'READY_MARKER_VERSION_MISMATCH',
      '.browser-forge-ready/builtin_commands',
      'Ready marker builtin_commands must match the trusted builtin command set'
    ))
  }
  return issues
}

function markdownSectionMissing(text, section) {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return !new RegExp(`^#{2,6}[ \\t]+${escaped}[ \\t]*#*[ \\t]*$`, 'im').test(text)
}

function commandDocumentIssues(text, command, relativePath) {
  const missingSections = REQUIRED_COMMAND_DOC_SECTIONS.filter(section => markdownSectionMissing(text, section))
  const schemaRef = command?.outputs?.schema_ref
  if (missingSections.length === 0 && typeof schemaRef === 'string' && text.includes(schemaRef)) return []
  return [issue(
    'HELP_CONTRACT_MISSING',
    relativePath,
    `Command documentation lacks required help metadata or schema_ref reference: ${command?.id ?? 'unknown'}`
  )]
}

async function readyContractIssues(skillDir, manifest) {
  const issues = []
  const identifiers = trustedIdentifiers(manifest)
  const manifestIds = commandIds(manifest).sort()
  const uniqueManifestIds = [...new Set(manifestIds)]
  let skillIds = []
  try {
    const skillText = await readFile(join(skillDir, 'SKILL.md'), 'utf8')
    skillIds = commandIdsFromSkillDocument(skillText)
    issues.push(...skillMetadataIssues(skillText, manifest, identifiers))
  } catch {
    /* parity issue below */
  }
  if (!sameValues(uniqueManifestIds, skillIds)) {
    issues.push(issue(
      'SKILL_COMMAND_MISMATCH',
      'SKILL.md#commands',
      'SKILL.md command list must exactly match manifest commands'
    ))
  }

  for (const commandId of uniqueManifestIds.filter(commandId => !BUILTIN_COMMAND_IDS.includes(commandId))) {
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

  issues.push(...duplicateCommandIssues(manifest))
  issues.push(...helpMetadataIssues(manifest))
  issues.push(...outputSchemaIssues(manifest))
  issues.push(...outputDefinitionIssues(manifest))
  issues.push(...authStrategyPolicyIssues(manifest))
  issues.push(...transportHeaderPolicyIssues(manifest))
  issues.push(...await handlerReferenceIssues(skillDir, manifest))
  issues.push(...await forbiddenExecutionPathIssues(skillDir))
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
    } else {
      issues.push(...readyMarkerIssues(readyMarker))
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
