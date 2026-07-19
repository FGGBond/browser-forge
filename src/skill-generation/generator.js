import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AUTH_RUNTIME_VERSION, SPEC_VERSION } from './constants.js'
import { normalizeSkillName } from './names.js'

const REQUIRED_RECORDING_FILES = ['RECORDING.md', 'recording.har', 'timeline.json', 'metadata.json']
const TEMPLATE_ROOT = fileURLToPath(new URL('../../skills/browser-forge/assets/skill-template/', import.meta.url))
const TOKEN_PATTERN = /\{\{(SKILL_NAME|SKILL_ID|PACKAGE_NAME|ENTRYPOINT_NAME|DESCRIPTION|TARGET_DOMAINS_JSON|SPEC_VERSION|AUTH_RUNTIME_VERSION)\}\}/g

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

async function assertMissing(path) {
  try {
    await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  throw new GenerationError(`Skill directory already exists: ${path}`, 'SKILL_ALREADY_EXISTS')
}

/**
 * Creates a rendered, standalone skill skeleton without copying recording material.
 */
export async function generateSkill({ recordingDir, skillName, description, targetDomains = [], outputRoot } = {}) {
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
  await assertMissing(skillDir)

  const temporaryDir = await mkdtemp(join(resolvedOutputRoot, `.browser-forge-${identifiers.skillName}-`))
  try {
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
    await assertMissing(skillDir)
    await rename(temporaryDir, skillDir)
  } catch (error) {
    await rm(temporaryDir, { recursive: true, force: true })
    throw error
  }

  return { skillDir, ...identifiers }
}
