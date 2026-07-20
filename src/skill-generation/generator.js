import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { AUTH_RUNTIME_VERSION, SPEC_VERSION } from './constants.js'
import { normalizeSkillName } from './names.js'

const REQUIRED_RECORDING_FILES = ['RECORDING.md', 'recording.har', 'timeline.json', 'metadata.json']
const TEMPLATE_ROOT = fileURLToPath(new URL('../../skills/browser-forge/assets/skill-template/', import.meta.url))
const TOKEN_PATTERN = /\{\{(SKILL_NAME|SKILL_ID|PACKAGE_NAME|ENTRYPOINT_NAME|DESCRIPTION|TARGET_DOMAINS_JSON|SPEC_VERSION|AUTH_RUNTIME_VERSION)\}\}/g
const OWNER_MARKER = '.browser-forge-owner.json'
const READY_MARKER = '.browser-forge-ready'

export class GenerationError extends Error {
  constructor(message, code = 'GENERATION_ENVIRONMENT_ERROR') {
    super(message)
    this.name = 'GenerationError'
    this.code = code
  }
}

async function ensureDirectory(path, label) {
  let details
  try {
    details = await stat(path)
  } catch (error) {
    throw new GenerationError(`${label} does not exist: ${path}`, 'RECORDING_NOT_FOUND')
  }
  if (!details.isDirectory()) {
    throw new GenerationError(`${label} is not a directory: ${path}`, 'RECORDING_NOT_DIRECTORY')
  }
}

async function validateRecording(recordingDir) {
  await ensureDirectory(recordingDir, 'Recording directory')
  const missing = []
  for (const filename of REQUIRED_RECORDING_FILES) {
    try {
      if (!(await stat(join(recordingDir, filename))).isFile()) missing.push(filename)
    } catch {
      missing.push(filename)
    }
  }
  if (missing.length > 0) {
    throw new GenerationError(`Recording is missing required files: ${missing.join(', ')}`, 'RECORDING_INCOMPLETE')
  }
}

function renderName(name, identifiers) {
  if (name === 'browser_forge-skill.tmpl') return identifiers.entrypointName
  if (name === 'browser_forge_generated') return identifiers.packageName
  return name.endsWith('.tmpl') ? name.slice(0, -'.tmpl'.length) : name
}

function renderText(text, values) {
  return text.replace(TOKEN_PATTERN, (_token, name) => values[name])
}

async function renderTree(source, destination, values, identifiers) {
  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const sourcePath = join(source, entry.name)
    const destinationPath = join(destination, renderName(entry.name, identifiers))
    if (entry.isDirectory()) {
      await mkdir(destinationPath)
      await renderTree(sourcePath, destinationPath, values, identifiers)
      continue
    }
    if (!entry.isFile()) continue

    await writeFile(destinationPath, renderText(await readFile(sourcePath, 'utf8'), values), 'utf8')
    const sourceMode = (await stat(sourcePath)).mode & 0o777
    await chmod(destinationPath, sourceMode)
  }
}

async function ownsReservation(skillDir, token) {
  try {
    const marker = JSON.parse(await readFile(join(skillDir, OWNER_MARKER), 'utf8'))
    return marker.owner_id === token
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return false
    throw error
  }
}

async function assertOwnership(skillDir, token) {
  if (!(await ownsReservation(skillDir, token))) {
    throw new GenerationError(`Lost ownership of skill directory: ${skillDir}`, 'OWNERSHIP_LOST')
  }
}

async function reserveSkillDir(skillDir, token) {
  try {
    await mkdir(skillDir)
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new GenerationError(`Skill directory already exists: ${skillDir}`, 'SKILL_ALREADY_EXISTS')
    }
    throw error
  }
  try {
    await writeFile(join(skillDir, OWNER_MARKER), `${JSON.stringify({ owner_id: token, spec_version: SPEC_VERSION })}\n`, { flag: 'wx' })
  } catch (error) {
    if (await ownsReservation(skillDir, token)) await rm(skillDir, { recursive: true, force: true })
    throw error
  }
}

async function removeOwnedReservation(skillDir, token) {
  if (await ownsReservation(skillDir, token)) {
    await rm(skillDir, { recursive: true, force: true })
  }
}

async function publishTree(temporaryDir, skillDir, token) {
  await assertOwnership(skillDir, token)
  const entries = await readdir(temporaryDir, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    await assertOwnership(skillDir, token)
    await rename(join(temporaryDir, entry.name), join(skillDir, entry.name))
  }
}

async function writeReadyMarker(skillDir, token) {
  await assertOwnership(skillDir, token)
  const temporaryMarker = join(skillDir, `${READY_MARKER}-${randomUUID()}`)
  const contents = `${JSON.stringify({
    completed: true,
    spec_version: SPEC_VERSION,
    auth_runtime_version: AUTH_RUNTIME_VERSION
  })}\n`
  await writeFile(temporaryMarker, contents, { flag: 'wx' })
  await assertOwnership(skillDir, token)
  await rename(temporaryMarker, join(skillDir, READY_MARKER))
}

export async function readReadyMarker(skillDir) {
  try {
    const marker = JSON.parse(await readFile(join(skillDir, READY_MARKER), 'utf8'))
    if (marker?.completed !== true || marker.spec_version !== SPEC_VERSION) return null
    return marker
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null
    throw error
  }
}

/**
 * Creates a rendered, standalone skill skeleton without copying recording material.
 */
export async function generateSkill({ recordingDir, skillName, description, targetDomains = [], outputRoot, testHooks } = {}) {
  if (typeof recordingDir !== 'string' || recordingDir.trim() === '') {
    throw new GenerationError('recordingDir is required', 'INVALID_ARGUMENT')
  }
  if (typeof description !== 'string') {
    throw new GenerationError('description is required', 'INVALID_ARGUMENT')
  }
  if (!Array.isArray(targetDomains) || !targetDomains.every(domain => typeof domain === 'string')) {
    throw new GenerationError('targetDomains must be an array of strings', 'INVALID_ARGUMENT')
  }

  const resolvedRecordingDir = resolve(recordingDir)
  let identifiers
  try {
    identifiers = normalizeSkillName(skillName)
  } catch (error) {
    throw new GenerationError(error.message, 'INVALID_ARGUMENT')
  }
  await validateRecording(resolvedRecordingDir)

  const resolvedOutputRoot = resolve(outputRoot ?? join(dirname(resolvedRecordingDir), 'skills'))
  const skillDir = join(resolvedOutputRoot, identifiers.skillName)
  await mkdir(resolvedOutputRoot, { recursive: true })

  const ownershipToken = randomUUID().replaceAll('-', '/')
  let temporaryDir
  let reserved = false
  try {
    await reserveSkillDir(skillDir, ownershipToken)
    reserved = true
    temporaryDir = await mkdtemp(join(resolvedOutputRoot, `.browser-forge-${identifiers.skillName}-`))
    await testHooks?.beforeRender?.({ skillDir, temporaryDir })
    const values = {
      SKILL_NAME: identifiers.skillName,
      SKILL_ID: identifiers.skillId,
      PACKAGE_NAME: identifiers.packageName,
      ENTRYPOINT_NAME: identifiers.entrypointName,
      DESCRIPTION: JSON.stringify(description),
      TARGET_DOMAINS_JSON: JSON.stringify(targetDomains),
      SPEC_VERSION,
      AUTH_RUNTIME_VERSION
    }
    await renderTree(TEMPLATE_ROOT, temporaryDir, values, identifiers)
    await publishTree(temporaryDir, skillDir, ownershipToken)
    await testHooks?.beforeReady?.({ skillDir, temporaryDir })
    await assertOwnership(skillDir, ownershipToken)
    await rm(temporaryDir, { recursive: true, force: true })
    temporaryDir = undefined
    await writeReadyMarker(skillDir, ownershipToken)
  } catch (error) {
    if (temporaryDir) await rm(temporaryDir, { recursive: true, force: true })
    if (reserved) await removeOwnedReservation(skillDir, ownershipToken)
    throw error
  }

  return { skillDir, ready: true, ...identifiers }
}
