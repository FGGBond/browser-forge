import { chmod, link, mkdir, mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
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
const LOCK_SUFFIX = '.lock'

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
  } catch {
    return false
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
    if (error.code === 'EEXIST') {
      throw new GenerationError(`Skill reservation changed unexpectedly: ${skillDir}`, 'RESERVATION_CONFLICT')
    }
    throw error
  }
}

async function ownsLock(lockPath, token) {
  try {
    const marker = JSON.parse(await readFile(lockPath, 'utf8'))
    return marker.owner_id === token
  } catch {
    return false
  }
}

async function acquirePublicationLock(lockPath, token) {
  try {
    await writeFile(lockPath, `${JSON.stringify({ owner_id: token, spec_version: SPEC_VERSION })}\n`, {
      flag: 'wx',
      mode: 0o600
    })
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new GenerationError(`Skill generation is already in progress: ${lockPath}`, 'GENERATION_IN_PROGRESS')
    }
    throw error
  }
}

async function releasePublicationLock(lockPath, token) {
  if (!(await ownsLock(lockPath, token))) return
  try {
    await unlink(lockPath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

function publicationConflict(destinationPath) {
  return new GenerationError(`Publication destination already exists: ${destinationPath}`, 'PUBLICATION_CONFLICT')
}

async function publishTree(temporaryDir, destinationDir, skillDir, token, testHooks) {
  const entries = await readdir(temporaryDir, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    await assertOwnership(skillDir, token)
    const sourcePath = join(temporaryDir, entry.name)
    const destinationPath = join(destinationDir, entry.name)
    await testHooks?.afterPublishOwnershipCheck?.({ entryName: entry.name, sourcePath, destinationPath, skillDir })

    try {
      if (entry.isDirectory()) {
        await mkdir(destinationPath)
        await assertOwnership(skillDir, token)
        await publishTree(sourcePath, destinationPath, skillDir, token, testHooks)
        continue
      }
      if (!entry.isFile()) continue

      await link(sourcePath, destinationPath)
      await unlink(sourcePath)
      await assertOwnership(skillDir, token)
    } catch (error) {
      if (error instanceof GenerationError) throw error
      if (error.code === 'EEXIST' || error.code === 'EISDIR' || error.code === 'ENOTEMPTY') {
        throw publicationConflict(destinationPath)
      }
      if (!(await ownsReservation(skillDir, token))) {
        throw new GenerationError(`Lost ownership of skill directory: ${skillDir}`, 'OWNERSHIP_LOST')
      }
      throw error
    }
  }
}

async function writeReadyMarker(skillDir, token) {
  await assertOwnership(skillDir, token)
  const readyMarker = join(skillDir, READY_MARKER)
  const contents = `${JSON.stringify({
    completed: true
  })}\n`
  try {
    await writeFile(readyMarker, contents, { flag: 'wx' })
  } catch (error) {
    if (error.code === 'EEXIST') throw publicationConflict(readyMarker)
    throw error
  }
}

export async function readReadyMarker(skillDir) {
  try {
    const marker = JSON.parse(await readFile(join(skillDir, READY_MARKER), 'utf8'))
    if (marker?.completed !== true) return null
    return { completed: true }
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
  const lockPath = join(resolvedOutputRoot, `.browser-forge-${identifiers.skillName}${LOCK_SUFFIX}`)
  await mkdir(resolvedOutputRoot, { recursive: true })

  const ownershipToken = randomUUID().replaceAll('-', '/')
  let temporaryDir
  let lockAcquired = false
  try {
    await acquirePublicationLock(lockPath, ownershipToken)
    lockAcquired = true
    await reserveSkillDir(skillDir, ownershipToken)
    temporaryDir = await mkdtemp(join(resolvedOutputRoot, `.browser-forge-${identifiers.skillName}-`))
    await testHooks?.beforeRender?.({ skillDir, temporaryDir, lockPath })
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
    await publishTree(temporaryDir, skillDir, skillDir, ownershipToken, testHooks)
    await testHooks?.beforeReady?.({ skillDir, temporaryDir, lockPath })
    await assertOwnership(skillDir, ownershipToken)
    await rm(temporaryDir, { recursive: true, force: true })
    temporaryDir = undefined
    await writeReadyMarker(skillDir, ownershipToken)
  } catch (error) {
    if (temporaryDir) await rm(temporaryDir, { recursive: true, force: true })
    throw error
  } finally {
    if (lockAcquired) await releasePublicationLock(lockPath, ownershipToken)
  }

  return { skillDir, ready: true, ...identifiers }
}
