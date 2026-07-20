import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { generateSkill } from '../../src/skill-generation/generator.js'

async function createRecording(root) {
  const recordingDir = join(root, 'recording')
  await mkdir(recordingDir)
  await Promise.all([
    writeFile(join(recordingDir, 'RECORDING.md'), '# Recorded session\n'),
    writeFile(join(recordingDir, 'recording.har'), '{"log":{"entries":[]}}\n'),
    writeFile(join(recordingDir, 'timeline.json'), '[]\n'),
    writeFile(join(recordingDir, 'metadata.json'), '{}\n')
  ])
  return recordingDir
}

function businessCommands() {
  return [
    {
      id: 'list-orders',
      summary: 'List the available orders.',
      side_effect: false,
      idempotent: true,
      inputs: [],
      outputs: { schema_ref: '#/$defs/list-orders-output' },
      requires: { auth: true, commands: [] },
      next_actions: [{ command: 'get-order', bindings: { order_id: '$.data.orders[0].id' } }],
      steps: [{ id: 'list-orders', request: 'GET /orders', depends_on: [] }]
    },
    {
      id: 'get-order',
      summary: 'Get one order.',
      side_effect: false,
      idempotent: true,
      inputs: [{
        name: 'order_id',
        type: 'string',
        required: true,
        sources: [{ command: 'list-orders', json_path: '$.data.orders[0].id' }]
      }, {
        name: 'revision',
        type: 'integer',
        required: false,
        sources: []
      }],
      outputs: { schema_ref: '#/$defs/get-order-output' },
      requires: { auth: true, commands: ['list-orders'] },
      next_actions: [{ command: 'list-orders', bindings: {} }],
      steps: [{ id: 'get-order', request: 'GET /orders/{order_id}', depends_on: [] }]
    }
  ]
}

function execute(file, args, cwd) {
  const result = spawnSync(file, args, {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, BROWSER_FORGE_DISABLE_NETWORK: '1' }
  })
  let json = null
  try {
    json = result.stdout.trim() ? JSON.parse(result.stdout) : null
  } catch {
    // Installer and --help output are intentionally human-readable.
  }
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json
  }
}

function expectSingleJsonFailure(result, { command, code = 'INVALID_ARGUMENT' }) {
  expect(result.exitCode, result.stderr).toBe(2)
  expect(result.stderr).toBe('')
  expect(result.stdout.trim().split('\n')).toHaveLength(1)
  expect(result.json).toMatchObject({
    ok: false,
    command,
    status: 'failure',
    error: { code }
  })
}

describe('generated Python CLI', () => {
  it('installs and exposes manifest-driven progressive help and JSON envelopes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browser-forge-generated-cli-'))
    try {
      const result = await generateSkill({
        recordingDir: await createRecording(root),
        skillName: 'order-tools',
        description: 'Manage test orders.',
        targetDomains: ['api.example.test']
      })
      const manifestPath = join(result.skillDir, 'manifest.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      manifest.commands.push(...businessCommands())
      manifest.$defs['list-orders-output'] = { type: 'object' }
      manifest.$defs['get-order-output'] = { type: 'object' }
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

      const install = execute('bash', [join(result.skillDir, 'scripts', 'install.sh'), '--with-test'], result.skillDir)
      expect(install.exitCode, install.stderr).toBe(0)

      const python = join(result.skillDir, 'scripts', '.venv', 'bin', 'python')
      const pythonTests = execute(python, ['-m', 'pytest', '-q', 'tests'], result.skillDir)
      expect(pythonTests.exitCode, pythonTests.stderr).toBe(0)

      const redaction = execute(python, [
        '-c',
        'from browser_forge_order_tools.client import redacting_logger; redacting_logger().warning("Authorization: Bearer visible-secret")'
      ], result.skillDir)
      expect(redaction.exitCode, redaction.stderr).toBe(0)
      expect(redaction.stderr).not.toContain('visible-secret')

      const entrypoint = join(result.skillDir, 'scripts', 'browser_forge-order-tools')
      const run = args => execute(entrypoint, args, result.skillDir)

      const described = run(['describe', 'get-order'])
      expect(described.exitCode, described.stderr).toBe(0)
      expect(described.json.command.id).toBe('get-order')

      const help = run(['get-order', '--help'])
      expect(help.exitCode, help.stderr).toBe(0)
      expect(help.stdout).toContain('Obtain from: list-orders -> $.data.orders[0].id')
      expect(help.stdout).toContain('Dependencies:')
      expect(help.stdout).toContain('Authentication:')
      expect(help.stdout).toContain('Output:')
      expect(help.stdout).toContain('Next actions:')
      expect(help.stdout).toContain('Side effects:')
      expect(help.stdout).toContain('Idempotency:')
      expect(help.stdout).toContain('Examples:')

      const missing = run(['get-order'])
      expectSingleJsonFailure(missing, { command: 'get-order' })

      expectSingleJsonFailure(run([]), { command: null })
      expectSingleJsonFailure(run(['not-a-command']), { command: null })
      expectSingleJsonFailure(run(['get-order', '--order-id', 'order-123', '--revision', 'not-an-integer']), { command: 'get-order' })
      expectSingleJsonFailure(run(['describe', 'get-order', 'unexpected']), { command: null })

      const networkDisabled = run(['get-order', '--order-id', 'order-123'])
      expect(networkDisabled.exitCode).toBe(1)
      expect(networkDisabled.json.error.code).toBe('NETWORK_DISABLED')

      for (const args of [['doctor'], ['auth-status']]) {
        const commandResult = run(args)
        expect(commandResult.exitCode, commandResult.stderr).toBe(0)
        expect(commandResult.json).toMatchObject({ spec_version: '1.0', ok: true, status: 'success' })
      }

      const portableRoot = await mkdtemp(join(tmpdir(), 'browser-forge-portable-cli-'))
      const portableSkill = join(portableRoot, 'order-tools')
      try {
        await cp(result.skillDir, portableSkill, { recursive: true })
        const portableInstall = execute('bash', [join(portableSkill, 'scripts', 'install.sh')], portableSkill)
        expect(portableInstall.exitCode, portableInstall.stderr).toBe(0)

        const portableEntrypoint = join(portableSkill, 'scripts', 'browser_forge-order-tools')
        for (const args of [['doctor'], ['describe', 'get-order']]) {
          const commandResult = execute(portableEntrypoint, args, portableSkill)
          expect(commandResult.exitCode, commandResult.stderr).toBe(0)
          expect(commandResult.json).toMatchObject({ spec_version: '1.0', ok: true, status: 'success' })
        }
      } finally {
        await rm(portableRoot, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 180_000)
})
