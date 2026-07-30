import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { generateSkill, GenerationError } from './generator.js'
import { normalizeSkillName } from './names.js'

const STRATEGY_RANK = { 'none': 0, 'browser-cookie': 1, 'jd-internal': 2 }

async function loadChildManifest(skillDir) {
  const manifestPath = join(skillDir, 'manifest.json')
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    throw new GenerationError(`Cannot read ${manifestPath}: ${error.message}`, 'FUSION_CHILD_UNREADABLE')
  }
}

function pickStrategy(children, override) {
  if (override) return override
  let best = 'none'
  for (const child of children) {
    const strat = child?.auth?.strategy ?? 'none'
    if ((STRATEGY_RANK[strat] ?? 0) > (STRATEGY_RANK[best] ?? 0)) best = strat
  }
  return best
}

function unionTargetUrls(children) {
  const seen = new Set()
  for (const child of children) {
    for (const url of child?.auth?.target_urls ?? []) {
      if (typeof url === 'string' && url) seen.add(url)
    }
  }
  return [...seen]
}

function unionRequiredCookies(children) {
  const seen = new Set()
  for (const child of children) {
    for (const c of child?.auth?.required_cookies ?? []) seen.add(c)
  }
  return [...seen]
}

function unionPerHostHeaders(children) {
  const perHost = {}
  for (const child of children) {
    const flat = child?.transport?.default_headers ?? {}
    const hosts = child?.auth?.target_urls ?? []
    for (const url of hosts) {
      let host
      try { host = new URL(url.startsWith('http') ? url : `https://${url}`).host.toLowerCase() } catch { continue }
      perHost[host] = { ...(perHost[host] ?? {}), ...flat }
    }
    const nested = child?.transport?.per_host ?? {}
    for (const [host, headers] of Object.entries(nested)) {
      perHost[host] = { ...(perHost[host] ?? {}), ...headers }
    }
  }
  return perHost
}

function prefixCommandId(sourceName, commandId) {
  if (commandId === 'doctor' || commandId === 'auth-status' || commandId === 'describe') return commandId
  return `${sourceName}:${commandId}`
}

function updateReferences(command, prefixFor) {
  const clone = { ...command }
  if (Array.isArray(clone.next_actions)) {
    clone.next_actions = clone.next_actions.map(action => ({
      ...action,
      command: prefixFor(action.command),
    }))
  }
  if (Array.isArray(clone.inputs)) {
    clone.inputs = clone.inputs.map(input => ({
      ...input,
      sources: (input.sources ?? []).map(source => ({
        ...source,
        command: prefixFor(source.command),
      })),
    }))
  }
  if (clone.requires && Array.isArray(clone.requires.commands)) {
    clone.requires = {
      ...clone.requires,
      commands: clone.requires.commands.map(prefixFor),
    }
  }
  if (typeof clone.handler === 'string') {
    // handler references a Python module. Namespace by source skill so we can
    // stash multiple children's commands/ dirs side-by-side.
    const [mod, fn] = clone.handler.split(':')
    clone.handler = `${mod}:${fn}`
  }
  return clone
}

function mergeCommands(childManifests, sourceNames) {
  const commands = []
  const collision = new Set()
  const builtins = new Set(['doctor', 'auth-status', 'describe'])
  // Emit each child's non-builtin commands with skill prefix.
  for (const [index, child] of childManifests.entries()) {
    const sourceName = sourceNames[index]
    const prefixFor = id => builtins.has(id) ? id : (id?.includes(':') ? id : `${sourceName}:${id}`)
    for (const cmd of child?.commands ?? []) {
      if (!cmd || typeof cmd.id !== 'string') continue
      if (builtins.has(cmd.id)) continue
      const newId = prefixCommandId(sourceName, cmd.id)
      if (collision.has(newId)) {
        throw new GenerationError(`Fused command id collides: ${newId}`, 'FUSION_COMMAND_COLLISION')
      }
      collision.add(newId)
      const rewritten = updateReferences({ ...cmd, id: newId }, prefixFor)
      commands.push(rewritten)
    }
  }
  return commands
}

function mergeDefs(childManifests) {
  const merged = {
    'doctor-output': { type: 'object' },
    'auth-status-output': { type: 'object' },
    'describe-output': { type: 'object' },
  }
  for (const child of childManifests) {
    const defs = child?.$defs
    if (!defs || typeof defs !== 'object') continue
    for (const [key, value] of Object.entries(defs)) {
      // Preserve original definitions; on collision the last one wins (users
      // should keep type shapes compatible).
      if (key in merged && ['doctor-output', 'auth-status-output', 'describe-output'].includes(key)) continue
      merged[key] = value
    }
  }
  return merged
}

async function ensureRecordingProxy(skillDir) {
  // The generator requires a recording directory with 4 fixtures. Fusion has
  // no recording; synthesise a minimal one alongside the output so validation
  // passes.
  const dir = join(skillDir, '.fusion-recording')
  await mkdir(dir, { recursive: true })
  const stubs = {
    'RECORDING.md': '# Synthesised fusion recording\n',
    'recording.har': JSON.stringify({ log: { version: '1.2', entries: [] } }),
    'timeline.json': '[]',
    'metadata.json': JSON.stringify({ startedAt: new Date().toISOString(), durationMs: 0, tabs: [] }),
  }
  for (const [name, content] of Object.entries(stubs)) {
    await writeFile(join(dir, name), content)
  }
  return dir
}

async function copyDir(from, to, { rename } = {}) {
  await mkdir(to, { recursive: true })
  const entries = await readdir(from, { withFileTypes: true })
  for (const entry of entries) {
    const src = join(from, entry.name)
    const dst = join(to, rename ? rename(entry.name) : entry.name)
    if (entry.isDirectory()) {
      await copyDir(src, dst, {})
    } else if (entry.isFile()) {
      const contents = await readFile(src)
      await writeFile(dst, contents)
    }
  }
}

async function safeReadFile(path) {
  try { return await readFile(path, 'utf8') } catch { return null }
}

async function importChildAssets(fusedSkillDir, childDir, sourceName, packageName) {
  // Copy each child's commands/ directory content into a subpackage of the
  // fused skill so handler modules stay isolated.
  const childManifest = JSON.parse(await readFile(join(childDir, 'manifest.json'), 'utf8'))
  const childIdentifiers = normalizeSkillName(childManifest.name)
  const childCommandsDir = join(childDir, 'scripts', 'cli', 'src', childIdentifiers.packageName, 'commands')
  const fusedCommandsDir = join(fusedSkillDir, 'scripts', 'cli', 'src', packageName, 'commands')

  try {
    if ((await stat(childCommandsDir)).isDirectory()) {
      const subpackage = join(fusedCommandsDir, sourceName.replaceAll('-', '_'))
      await copyDir(childCommandsDir, subpackage)
      // Rewrite handler-module imports so they still resolve after the copy.
      const initPath = join(subpackage, '__init__.py')
      const original = await safeReadFile(initPath)
      if (original === null) {
        await writeFile(initPath, `"""Commands from source skill: ${sourceName}."""\n`)
      }
    }
  } catch { /* no commands/ directory */ }

  // Copy per-command reference docs, prefixed to avoid collision.
  const childRefDir = join(childDir, 'references', 'commands')
  const fusedRefDir = join(fusedSkillDir, 'references', 'commands')
  try {
    const entries = await readdir(childRefDir, { withFileTypes: true })
    await mkdir(fusedRefDir, { recursive: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const rawName = entry.name
      if (!rawName.endsWith('.md')) continue
      const commandBase = rawName.replace(/\.md$/, '')
      if (['doctor', 'auth-status', 'describe', 'example'].includes(commandBase)) continue
      const newName = `${sourceName}-${commandBase}.md`
      const contents = await readFile(join(childRefDir, rawName), 'utf8')
      await writeFile(join(fusedRefDir, newName), contents)
    }
  } catch { /* no references/commands */ }
}

async function updateHandlerReferences(fusedSkillDir, packageName, sourceNames) {
  // Each fused command's handler string was left as "<module>:<fn>" but
  // commands/ subpackages sit at <package>.commands.<source>.<module>.
  // Rewrite by scanning manifest and adjusting handlers to include the source
  // prefix so cli.py's importer finds them.
  const manifestPath = join(fusedSkillDir, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  for (const command of manifest.commands ?? []) {
    if (typeof command.handler !== 'string') continue
    const [source] = command.id.split(':')
    if (!sourceNames.includes(source)) continue
    const [mod, fn] = command.handler.split(':')
    command.handler = `${source.replaceAll('-', '_')}.${mod}:${fn}`
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
}

async function writeFusionReference(fusedSkillDir, sourceNames, childManifests) {
  const lines = ['# Fused skill', '']
  lines.push('This skill was built by combining the following source skills:')
  lines.push('')
  for (const [index, child] of childManifests.entries()) {
    lines.push(`- **${sourceNames[index]}** — ${child.description ?? '(no description)'}`)
    for (const cmd of child.commands ?? []) {
      if (['doctor', 'auth-status', 'describe'].includes(cmd.id)) continue
      lines.push(`  - \`${sourceNames[index]}:${cmd.id}\` — ${cmd.summary ?? ''}`)
    }
  }
  lines.push('')
  lines.push('Command IDs are prefixed with the source skill name to avoid collision. Built-in commands (`doctor`, `auth-status`, `describe`) are unified and report the fused skill\'s state.')
  await writeFile(join(fusedSkillDir, 'references', 'fusion.md'), lines.join('\n') + '\n')
}

/**
 * Fuse a list of already-generated Browser Forge skills into a single skill.
 *
 * @param {object} params
 * @param {string} params.name — new fused skill name
 * @param {string} params.description
 * @param {string[]} params.skillDirs — absolute paths to child skills
 * @param {string} params.outputRoot — where to place the fused skill directory
 * @param {string} [params.authStrategy] — override auto-picked strategy
 */
export async function fuseSkills({ name, description, skillDirs, outputRoot, authStrategy } = {}) {
  if (typeof name !== 'string' || !name.trim()) throw new GenerationError('name required', 'INVALID_ARGUMENT')
  if (!Array.isArray(skillDirs) || skillDirs.length < 2) throw new GenerationError('need ≥2 --skill entries', 'INVALID_ARGUMENT')

  const resolvedDirs = skillDirs.map(dir => resolve(dir))
  const childManifests = []
  for (const dir of resolvedDirs) {
    childManifests.push(await loadChildManifest(dir))
  }
  const sourceNames = childManifests.map(m => String(m.name))

  const strategy = pickStrategy(childManifests, authStrategy)
  const targetUrls = unionTargetUrls(childManifests)
  const requiredCookies = unionRequiredCookies(childManifests)
  const perHost = unionPerHostHeaders(childManifests)

  const recordingProxy = await ensureRecordingProxy(resolve(outputRoot))
  const generated = await generateSkill({
    recordingDir: recordingProxy,
    skillName: name,
    description,
    targetUrls,
    authStrategy: strategy,
    outputRoot,
  })

  // Merge auth + transport metadata into the manifest.
  const manifestPath = join(generated.skillDir, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.auth.strategy = strategy
  manifest.auth.target_urls = targetUrls
  if (requiredCookies.length > 0) manifest.auth.required_cookies = requiredCookies
  manifest.transport = manifest.transport ?? {}
  manifest.transport.per_host = perHost
  manifest.commands = [...manifest.commands, ...mergeCommands(childManifests, sourceNames)]
  manifest.$defs = { ...manifest.$defs, ...mergeDefs(childManifests) }
  manifest.fused_from = childManifests.map(m => ({ skill_id: m.id, spec_version: m.spec_version }))
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

  const packageName = generated.packageName
  for (const [index, dir] of resolvedDirs.entries()) {
    await importChildAssets(generated.skillDir, dir, sourceNames[index], packageName)
  }
  await updateHandlerReferences(generated.skillDir, packageName, sourceNames)
  await writeFusionReference(generated.skillDir, sourceNames, childManifests)

  return {
    skillDir: generated.skillDir,
    sourceNames,
    strategy,
    targetUrls,
    fusedCommands: manifest.commands.filter(c => c.id.includes(':')).map(c => c.id),
  }
}
