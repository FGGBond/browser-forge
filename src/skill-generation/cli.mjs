import { fuseSkills } from './fusion.js'
import { generateSkill, GenerationError } from './generator.js'
import { validateSkill } from './manifest-validator.js'

const USAGE = `Usage:
  browser-forge generate --recording-dir DIR --skill-name NAME --description TEXT [--target-domain HOST]... [--target-url URL]... [--auth-strategy STRATEGY] [--output-root DIR]
  browser-forge validate --skill-dir DIR
  browser-forge fuse --name NAME --description TEXT --out DIR --skill DIR --skill DIR [--skill DIR]... [--auth-strategy STRATEGY]`

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function fail(code, message, exitCode) {
  printJson({ ok: false, status: 'error', error: { code, message } })
  process.exitCode = exitCode
}

function parseArguments(args) {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) return { help: true }
  const [command, ...tokens] = args
  if (!['generate', 'validate', 'fuse'].includes(command)) {
    throw new GenerationError(`Unknown command: ${command}`, 'INVALID_ARGUMENT')
  }

  const values = { command, targetDomains: [], targetUrls: [], skillDirs: [] }
  const aliases = {
    '--recording-dir': 'recordingDir',
    '--skill-name': 'skillName',
    '--description': 'description',
    '--target-domain': 'targetDomains',
    '--target-url': 'targetUrls',
    '--output-root': 'outputRoot',
    '--skill-dir': 'skillDir',
    '--auth-strategy': 'authStrategy',
    '--name': 'skillName',
    '--out': 'outputRoot',
    '--skill': 'skillDirs',
  }
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index]
    const key = aliases[flag]
    const value = tokens[index + 1]
    if (!key || value === undefined || value.startsWith('--')) {
      throw new GenerationError(`Expected a value for ${flag ?? 'argument'}`, 'INVALID_ARGUMENT')
    }
    if (key === 'targetDomains' || key === 'targetUrls' || key === 'skillDirs') {
      values[key].push(value)
    } else if (values[key] !== undefined) {
      throw new GenerationError(`Argument specified more than once: ${flag}`, 'INVALID_ARGUMENT')
    } else {
      values[key] = value
    }
  }
  const requiredByCommand = {
    generate: ['recordingDir', 'skillName', 'description'],
    validate: ['skillDir'],
    fuse: ['skillName', 'description', 'outputRoot'],
  }
  const missing = requiredByCommand[command].filter(key => !values[key])
  if (missing.length > 0) throw new GenerationError(`Missing required arguments: ${missing.join(', ')}`, 'INVALID_ARGUMENT')
  if (command === 'fuse' && values.skillDirs.length < 2) {
    throw new GenerationError('fuse requires at least two --skill DIR arguments', 'INVALID_ARGUMENT')
  }
  return values
}

async function main() {
  let args
  try {
    args = parseArguments(process.argv.slice(2))
  } catch (error) {
    fail('INVALID_ARGUMENT', error.message, 2)
    return
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`)
    return
  }

  try {
    if (args.command === 'generate') {
      const result = await generateSkill(args)
      printJson({
        ok: true,
        status: 'generated',
        skill_dir: result.skillDir,
        auth_strategy: result.authStrategy,
        default_headers: Object.keys(result.defaultHeaders ?? {}),
        target_urls: result.targetUrls,
        next_action: 'populate_and_validate',
      })
      return
    }
    if (args.command === 'fuse') {
      const result = await fuseSkills({
        name: args.skillName,
        description: args.description,
        skillDirs: args.skillDirs,
        outputRoot: args.outputRoot,
        authStrategy: args.authStrategy,
      })
      printJson({
        ok: true,
        status: 'fused',
        skill_dir: result.skillDir,
        source_skills: result.sourceNames,
        strategy: result.strategy,
        target_urls: result.targetUrls,
        fused_commands: result.fusedCommands,
      })
      return
    }
    const result = await validateSkill(args.skillDir)
    printJson({ ok: result.ok, status: result.ok ? 'valid' : 'invalid', issues: result.issues, findings: result.findings })
    if (!result.ok) process.exitCode = 1
  } catch (error) {
    if (error instanceof GenerationError && error.code === 'INVALID_ARGUMENT') {
      fail('INVALID_ARGUMENT', error.message, 2)
    } else {
      fail(error.code ?? 'ENVIRONMENT_ERROR', error.message, 3)
    }
  }
}

await main()
