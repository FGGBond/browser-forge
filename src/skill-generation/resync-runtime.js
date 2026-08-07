import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AUTH_RUNTIME_VERSION, BUILTIN_COMMAND_IDS, SPEC_VERSION } from './constants.js'
import {
  ENTRYPOINT_TEMPLATE,
  IMMUTABLE_RUNTIME_TEMPLATES,
  trustedIdentifiers,
  validateSkill
} from './manifest-validator.js'
import { renderTemplateText, TEMPLATE_ROOT, templateValues } from './template-renderer.js'

const READY_MARKER = '.browser-forge-ready'

export class ResyncError extends Error {
  constructor(message, code = 'RESYNC_ERROR') {
    super(message)
    this.name = 'ResyncError'
    this.code = code
  }
}

async function renderTemplateFile(templateRelativePath, values) {
  const templatePath = join(TEMPLATE_ROOT, templateRelativePath)
  const source = await readFile(templatePath, 'utf8')
  return {
    contents: renderTemplateText(source, values),
    mode: (await stat(templatePath)).mode & 0o7777
  }
}

async function writeRendered(skillDir, artifactRelativePath, rendered) {
  const target = join(skillDir, artifactRelativePath)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, rendered.contents, 'utf8')
  await chmod(target, rendered.mode)
}

// Remove bytecode caches / venv artifacts a prior test run may have dropped
// into the runtime tree; the validator forbids them under a ready skill.
async function purgeExecutionArtifacts(skillDir, packageName) {
  const sourceRoot = join(skillDir, 'scripts', 'cli', 'src', packageName)
  for (const relative of ['__pycache__', 'auth/__pycache__', 'commands/__pycache__']) {
    await rm(join(sourceRoot, relative), { recursive: true, force: true })
  }
  await rm(join(skillDir, 'tests', '__pycache__'), { recursive: true, force: true })
}

async function syncReadyMarker(skillDir) {
  const markerPath = join(skillDir, READY_MARKER)
  let marker
  try {
    marker = JSON.parse(await readFile(markerPath, 'utf8'))
  } catch {
    throw new ResyncError('Skill has no readable .browser-forge-ready marker; only ready skills can be resynced', 'NOT_READY')
  }
  const updated = {
    ...marker,
    completed: true,
    spec_version: SPEC_VERSION,
    auth_runtime_version: AUTH_RUNTIME_VERSION,
    builtin_commands: BUILTIN_COMMAND_IDS
  }
  await writeFile(markerPath, `${JSON.stringify(updated)}\n`, 'utf8')
}

async function syncManifestVersion(skillDir) {
  const manifestPath = join(skillDir, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest?.auth && manifest.auth.runtime_version !== AUTH_RUNTIME_VERSION) {
    manifest.auth.runtime_version = AUTH_RUNTIME_VERSION
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }
}

/**
 * Rewrites a ready skill's immutable runtime layer from the CURRENT templates,
 * leaving the business layer (manifest business fields, references, tests,
 * SKILL.md) untouched. This is the controlled counterpart to the SHA lock:
 * the lock freezes runtime files against the trusted template, and this pulls
 * a drifted skill back onto that exact template so a template fix reaches
 * existing skills. Because it renders from the same templateValues the
 * validator uses to compute expected SHAs, a successful resync is byte-for-byte
 * what validation demands. Validation is re-run as a gate; on failure the
 * function throws and the caller should not treat the skill as resynced.
 */
export async function resyncRuntime(skillDir, { skipValidation = false } = {}) {
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(skillDir, 'manifest.json'), 'utf8'))
  } catch (error) {
    throw new ResyncError(`Unable to read manifest.json: ${error.message}`, 'MANIFEST_UNREADABLE')
  }

  const identifiers = trustedIdentifiers(manifest)
  if (!identifiers) {
    throw new ResyncError('Manifest identity cannot be mapped to trusted runtime identifiers', 'IDENTITY_MISMATCH')
  }

  const previousVersion = manifest?.auth?.runtime_version ?? null
  const values = templateValues(identifiers, manifest?.description, manifest?.auth?.target_domains)
  const runtimeRoot = `scripts/cli/src/${identifiers.packageName}`
  const rewritten = []

  for (const [templateRelativePath, runtimeRelativePath] of IMMUTABLE_RUNTIME_TEMPLATES) {
    const artifactRelativePath = runtimeRelativePath.startsWith('scripts/')
      ? runtimeRelativePath
      : `${runtimeRoot}/${runtimeRelativePath}`
    await writeRendered(skillDir, artifactRelativePath, await renderTemplateFile(templateRelativePath, values))
    rewritten.push(artifactRelativePath)
  }

  const entrypointPath = `scripts/${identifiers.entrypointName}`
  await writeRendered(skillDir, entrypointPath, await renderTemplateFile(ENTRYPOINT_TEMPLATE, values))
  rewritten.push(entrypointPath)

  await purgeExecutionArtifacts(skillDir, identifiers.packageName)
  await syncManifestVersion(skillDir)
  await syncReadyMarker(skillDir)

  const result = {
    skillDir,
    previous_runtime_version: previousVersion,
    runtime_version: AUTH_RUNTIME_VERSION,
    rewritten_files: rewritten
  }

  if (!skipValidation) {
    const validation = await validateSkill(skillDir)
    if (!validation.ok) {
      throw new ResyncError(
        `Resync completed but validation still failed: ${JSON.stringify(validation.issues?.slice(0, 3) ?? [])}`,
        'VALIDATION_FAILED'
      )
    }
    result.validated = true
  }

  return result
}
