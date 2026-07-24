import { generateSkill, GenerationError } from './generator.js'
import { validateSkill } from './manifest-validator.js'

const USAGE = `Usage:
  browser-forge generate --recording-dir DIR --skill-name NAME --description TEXT [--target-domain HOST]... [--output-root DIR]
  browser-forge validate --skill-dir DIR`

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
  if (!['generate', 'validate'].includes(command)) throw new GenerationError(`Unknown command: ${command}`, 'INVALID_ARGUMENT')

  const values = { command, targetDomains: [] }
  const aliases = {
    '--recording-dir': 'recordingDir',
    '--skill-name': 'skillName',
    '--description': 'description',
    '--target-domain': 'targetDomains',
    '--output-root': 'outputRoot',
    '--skill-dir': 'skillDir'
  }
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index]
    const key = aliases[flag]
    const value = tokens[index + 1]
    if (!key || value === undefined || value.startsWith('--')) throw new GenerationError(`Expected a value for ${flag ?? 'argument'}`, 'INVALID_ARGUMENT')
    if (key === 'targetDomains') values.targetDomains.push(value)
    else if (values[key] !== undefined) throw new GenerationError(`Argument specified more than once: ${flag}`, 'INVALID_ARGUMENT')
    else values[key] = value
  }
  const required = command === 'generate'
    ? ['recordingDir', 'skillName', 'description']
    : ['skillDir']
  const missing = required.filter(key => !values[key])
  if (missing.length > 0) throw new GenerationError(`Missing required arguments: ${missing.join(', ')}`, 'INVALID_ARGUMENT')
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
      printJson({ ok: true, status: 'generated', skill_dir: result.skillDir, next_action: 'populate_and_validate' })
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
