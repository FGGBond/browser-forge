import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { homedir } from 'node:os'

const SKILL_NAME = 'browser-forge'
const MARKER_FILE = '.browser-forge-install.json'
const RUNTIME_DEPENDENCIES = ['ajv', 'ajv-formats']
const require = createRequire(import.meta.url)

export function getDefaultAgentSkillTargets({ homeDir = homedir(), env = process.env } = {}) {
  const codexRoot = env.CODEX_HOME
    ? join(env.CODEX_HOME, 'skills')
    : join(homeDir, '.codex', 'skills')
  const roots = [
    ['codex', codexRoot],
    ['agents', join(homeDir, '.agents', 'skills')],
    ['claude', join(homeDir, '.claude', 'skills')]
  ]

  return roots.map(([agent, rootDir]) => ({
    agent,
    rootDir,
    skillDir: join(rootDir, SKILL_NAME)
  }))
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function readMarker(skillDir) {
  try {
    const marker = JSON.parse(await readFile(join(skillDir, MARKER_FILE), 'utf8'))
    return marker?.managedBy === 'browser-forge' && marker?.skillName === SKILL_NAME ? marker : null
  } catch {
    return null
  }
}

async function listFiles(rootDir) {
  const files = []
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(current, entry.name)
      const rel = relative(rootDir, path)
      if (entry.name === MARKER_FILE) continue
      if (entry.isDirectory()) {
        await visit(path)
      } else if (entry.isFile()) {
        files.push(rel)
      }
    }
  }
  await visit(rootDir)
  return files.sort()
}

async function hashDirectory(rootDir) {
  const hash = createHash('sha256')
  for (const rel of await listFiles(rootDir)) {
    hash.update(rel)
    hash.update('\0')
    hash.update(await readFile(join(rootDir, rel)))
    hash.update('\0')
  }
  return `sha256:${hash.digest('hex')}`
}


async function copyDirectoryRecursive(sourceDir, targetDir) {
  const sourceStats = await stat(sourceDir)
  if (!sourceStats.isDirectory()) {
    throw new Error(`${sourceDir} is not a directory`)
  }

  await mkdir(targetDir, { recursive: true })
  const entries = await readdir(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name)
    const targetPath = join(targetDir, entry.name)
    if (entry.isDirectory()) {
      await copyDirectoryRecursive(sourcePath, targetPath)
    } else if (entry.isFile()) {
      await mkdir(dirname(targetPath), { recursive: true })
      try {
        await copyFile(sourcePath, targetPath)
      } catch {
        await writeFile(targetPath, await readFile(sourcePath))
      }
      try {
        const fileStats = await stat(sourcePath)
        await chmod(targetPath, fileStats.mode)
      } catch {
        // Best-effort mode preservation. Some virtual filesystems, including
        // Electron asar, may not expose chmod-compatible metadata.
      }
    }
  }
}

async function copyPackageWithDependencies(packageName, targetNodeModules, copied = new Set()) {
  if (copied.has(packageName)) return
  copied.add(packageName)

  const packageJsonPath = require.resolve(`${packageName}/package.json`)
  const packageRoot = dirname(packageJsonPath)
  const targetRoot = join(targetNodeModules, packageName)
  await mkdir(dirname(targetRoot), { recursive: true })
  await rm(targetRoot, { recursive: true, force: true })
  await copyDirectoryRecursive(packageRoot, targetRoot)

  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))
  const dependencyNames = [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {}),
    ...Object.keys(packageJson.peerDependencies ?? {})
  ]
  for (const dependency of dependencyNames) {
    try {
      require.resolve(`${dependency}/package.json`)
      await copyPackageWithDependencies(dependency, targetNodeModules, copied)
    } catch {
      // Optional or peer dependency not present in Browser Forge's runtime install.
    }
  }
}

async function copyRuntimeDependencies(runtimeTarget) {
  const targetNodeModules = join(runtimeTarget, 'node_modules')
  await mkdir(targetNodeModules, { recursive: true })
  const copied = new Set()
  for (const dependency of RUNTIME_DEPENDENCIES) {
    await copyPackageWithDependencies(dependency, targetNodeModules, copied)
  }
}

async function copySkillToStaging({ sourceSkillDir, runtimeSourceDir, stagingDir }) {
  await copyDirectoryRecursive(sourceSkillDir, stagingDir)
  const runtimeTarget = join(stagingDir, 'scripts', 'runtime')
  await rm(runtimeTarget, { recursive: true, force: true })
  await mkdir(dirname(runtimeTarget), { recursive: true })
  await copyDirectoryRecursive(runtimeSourceDir, runtimeTarget)
  await copyRuntimeDependencies(runtimeTarget)
}

async function installTarget({
  target,
  sourceSkillDir,
  runtimeSourceDir,
  packageVersion,
  sourceCommit,
  now
}) {
  const exists = await pathExists(target.skillDir)
  const marker = exists ? await readMarker(target.skillDir) : null
  if (exists && !marker) {
    return {
      agent: target.agent,
      target: target.skillDir,
      status: 'skipped-conflict',
      reason: `Existing ${SKILL_NAME} skill is not managed by Browser Forge`
    }
  }

  await mkdir(target.rootDir, { recursive: true })
  const stagingDir = join(target.rootDir, `.${SKILL_NAME}.installing-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await rm(stagingDir, { recursive: true, force: true })
  await copySkillToStaging({ sourceSkillDir, runtimeSourceDir, stagingDir })
  const contentHash = await hashDirectory(stagingDir)

  if (marker?.contentHash === contentHash && marker?.version === packageVersion) {
    await rm(stagingDir, { recursive: true, force: true })
    return {
      agent: target.agent,
      target: target.skillDir,
      status: 'current',
      contentHash
    }
  }

  const markerContent = {
    managedBy: 'browser-forge',
    skillName: SKILL_NAME,
    version: packageVersion,
    sourceCommit,
    installedAt: now().toISOString(),
    contentHash,
    targetAgent: target.agent
  }
  await writeFile(join(stagingDir, MARKER_FILE), `${JSON.stringify(markerContent, null, 2)}\n`)

  const previousDir = join(target.rootDir, `.${SKILL_NAME}.previous-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  try {
    if (exists) await rename(target.skillDir, previousDir)
    await rename(stagingDir, target.skillDir)
    await rm(previousDir, { recursive: true, force: true })
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true })
    if (await pathExists(previousDir) && !await pathExists(target.skillDir)) {
      await rename(previousDir, target.skillDir).catch(() => {})
    }
    throw error
  }

  await stat(join(target.skillDir, 'SKILL.md'))
  return {
    agent: target.agent,
    target: target.skillDir,
    status: exists ? 'updated' : 'installed',
    contentHash
  }
}

export async function ensureAgentSkillsInstalled({
  homeDir = homedir(),
  env = process.env,
  targets = getDefaultAgentSkillTargets({ homeDir, env }),
  sourceSkillDir,
  runtimeSourceDir,
  packageVersion = '0.0.0',
  sourceCommit = 'unknown',
  now = () => new Date(),
  logFile
} = {}) {
  const checkedAt = now().toISOString()
  const results = []

  for (const target of targets) {
    try {
      results.push(await installTarget({
        target,
        sourceSkillDir,
        runtimeSourceDir,
        packageVersion,
        sourceCommit,
        now
      }))
    } catch (error) {
      results.push({
        agent: target.agent,
        target: target.skillDir,
        status: 'failed',
        error: error.message
      })
    }
  }

  const report = { checkedAt, results }
  if (logFile) {
    await mkdir(dirname(logFile), { recursive: true })
    await writeFile(logFile, `${JSON.stringify(report, null, 2)}\n`)
  }
  return report
}

export const AGENT_SKILL_INSTALLER_MARKER = MARKER_FILE
export const AGENT_SKILL_NAME = SKILL_NAME
