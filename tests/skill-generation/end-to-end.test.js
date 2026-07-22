import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { generateSkill } from '../../src/skill-generation/generator.js'

const repositoryRoot = process.cwd()
const validateSkillScript = join(repositoryRoot, 'skills', 'browser-forge', 'scripts', 'validate-skill')

async function createSanitizedRecording(root) {
  const recordingDir = join(root, 'session-orders')
  const tabDir = join(recordingDir, 'tabs', 'tab-orders')
  const screenshotsDir = join(tabDir, 'screenshots')
  await mkdir(screenshotsDir, { recursive: true })
  await Promise.all([
    writeFile(join(recordingDir, 'RECORDING.md'), [
      '# Sanitized order recording',
      '',
      'A test user listed orders and opened one order. All values are synthetic.',
      ''
    ].join('\n')),
    writeFile(join(recordingDir, 'recording.har'), `${JSON.stringify({
      log: {
        version: '1.2',
        creator: { name: 'browser-forge-test', version: '1.0' },
        entries: [
          { request: { method: 'GET', url: 'https://api.example.test/orders', headers: [] }, response: { status: 200 } },
          { request: { method: 'GET', url: 'https://api.example.test/orders/ORDER-001', headers: [] }, response: { status: 200 } }
        ]
      }
    }, null, 2)}\n`),
    writeFile(join(recordingDir, 'timeline.json'), `${JSON.stringify([
      { timestamp: 1_000, type: 'click', target_id: 'tab-orders' },
      { timestamp: 2_000, type: 'click', target_id: 'tab-orders' }
    ], null, 2)}\n`),
    writeFile(join(recordingDir, 'metadata.json'), `${JSON.stringify({
      start_url: 'https://api.example.test/orders',
      duration_ms: 2_000,
      tabs: [{ target_id: 'tab-orders', title: 'Synthetic orders', url: 'https://api.example.test/orders' }]
    }, null, 2)}\n`),
    writeFile(join(tabDir, 'events.json'), `${JSON.stringify([
      { timestamp: 1_000, type: 'click', selector: '[data-test=list-orders]' },
      { timestamp: 2_000, type: 'click', selector: '[data-test=open-order]' }
    ], null, 2)}\n`),
    writeFile(join(screenshotsDir, 'metadata.json'), `${JSON.stringify([
      { timestamp: 1_000, file: '1000.png', reason: 'click' },
      { timestamp: 2_000, file: '2000.png', reason: 'click' }
    ], null, 2)}\n`)
  ])
  return recordingDir
}

function businessCommands() {
  return [
    {
      id: 'list-orders',
      summary: 'List synthetic orders.',
      side_effect: false,
      idempotent: true,
      inputs: [],
      outputs: { schema_ref: '#/$defs/list-orders-output' },
      requires: { auth: false, commands: [] },
      next_actions: [{ command: 'get-order', bindings: { order_id: '$.data.orders[0].id' } }],
      steps: [{ id: 'request-orders', request: 'GET /orders', depends_on: [] }]
    },
    {
      id: 'get-order',
      summary: 'Get one synthetic order.',
      side_effect: false,
      idempotent: true,
      inputs: [{
        name: 'order_id',
        type: 'string',
        required: true,
        sources: [{ command: 'list-orders', json_path: '$.data.orders[0].id' }]
      }],
      outputs: { schema_ref: '#/$defs/get-order-output' },
      requires: { auth: true, commands: ['list-orders'] },
      next_actions: [],
      steps: [{ id: 'request-order', request: 'GET /orders/{order_id}', depends_on: [] }]
    }
  ]
}

function commandDocument(command) {
  const source = command.inputs[0]?.sources[0]
  const next = command.next_actions[0]
  return [
    `# ${command.id}`,
    '',
    command.summary,
    '',
    '## Inputs',
    '',
    source ? `Input source: \`${source.command}\` at \`${source.json_path}\`.` : 'No inputs are required.',
    '',
    '## Dependencies',
    '',
    source ? `Input source: \`${source.command}\` at \`${source.json_path}\`.` : 'No command dependency; invoke directly.',
    '',
    '## Authentication',
    '',
    command.requires.auth ? 'Authentication is required.' : 'Authentication is not required.',
    '',
    '## Output',
    '',
    `Schema: \`${command.outputs.schema_ref}\`.`,
    '',
    '## Next actions',
    '',
    next ? `Run \`${next.command}\` with the documented binding.` : 'No next action is required.',
    '',
    '## Side effects',
    '',
    command.side_effect ? 'This command has side effects.' : 'This command has no side effects.',
    '',
    '## Idempotency',
    '',
    command.idempotent ? 'This command is idempotent.' : 'This command is not idempotent.',
    '',
    '## Examples',
    '',
    `\`scripts/browser_forge-order-tools ${command.id}\``,
    ''
  ].join('\n')
}

async function populateSkill(skillDir) {
  const manifestPath = join(skillDir, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const commands = businessCommands()
  manifest.commands.push(...commands)
  manifest.workflows = [{
    id: 'inspect-order',
    steps: [
      { command: 'list-orders', bindings: {} },
      { command: 'get-order', bindings: { order_id: '$.steps[0].data.orders[0].id' } }
    ]
  }]
  manifest.$defs['list-orders-output'] = { type: 'object' }
  manifest.$defs['get-order-output'] = { type: 'object' }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  await writeFile(join(skillDir, 'SKILL.md'), [
    '# order-tools',
    '',
    'Use `scripts/browser_forge-order-tools` for the sanitized order API.',
    '',
    '## Commands',
    '',
    '- `doctor` — check prerequisites.',
    '- `auth-status` — inspect redacted authentication state.',
    '- `describe` — inspect the machine-readable contract.',
    '- `list-orders` — list orders. See [details](references/commands/list-orders.md).',
    '- `get-order` — get an order. See [details](references/commands/get-order.md).',
    '',
    '## References',
    '',
    '- [Workflows](references/workflows.md)',
    '- [Knowledge](references/knowledge.md)',
    '- [Authentication](references/authentication.md)',
    '- [list-orders](references/commands/list-orders.md)',
    '- [get-order](references/commands/get-order.md)',
    ''
  ].join('\n'))
  await rm(join(skillDir, 'references', 'commands', 'example.md'))
  await Promise.all(commands.map(command => writeFile(
    join(skillDir, 'references', 'commands', `${command.id}.md`),
    commandDocument(command)
  )))
  await writeFile(join(skillDir, 'references', 'workflows.md'), [
    '# Workflows',
    '',
    '## inspect-order',
    '',
    '1. Run `list-orders`.',
    '2. Bind `$.data.orders[0].id` to `get-order --order-id`.',
    ''
  ].join('\n'))
  return manifestPath
}

function execute(file, args, cwd, extraEnvironment = {}) {
  const result = spawnSync(file, args, {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, BROWSER_FORGE_DISABLE_NETWORK: '1', ...extraEnvironment }
  })
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr }
}

function parseSingleJson(result) {
  const lines = result.stdout.trim().split('\n')
  expect(lines).toHaveLength(1)
  return JSON.parse(lines[0])
}

function validateThroughWrapper(skillDir) {
  const result = execute('bash', [validateSkillScript, '--skill-dir', skillDir], repositoryRoot)
  return { ...result, json: parseSingleJson(result) }
}

async function expectReadyFailure(skillDir, expectedCode) {
  const validation = validateThroughWrapper(skillDir)
  expect(validation.exitCode).toBe(1)
  expect(validation.json.ok).toBe(false)
  const codes = validation.json.issues.map(issue => issue.code)
  expect(codes).toContain(expectedCode)
  expect(codes).toContain('READY_GATE_FAILED')
}

describe('generated skill independence and readiness', () => {
  it('gates ready status and runs a sanitized generated skill without the repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browser-forge-e2e-'))
    const standaloneRoot = await mkdtemp(join(tmpdir(), 'generated-skill-only-'))
    try {
      const generated = await generateSkill({
        recordingDir: await createSanitizedRecording(root),
        skillName: 'order-tools',
        description: 'Inspect synthetic test orders.',
        targetDomains: ['api.example.test']
      })
      const manifestPath = await populateSkill(generated.skillDir)

      expect(JSON.parse(await readFile(manifestPath, 'utf8')).required_features).toEqual([
        'manifest-command-parity',
        'progressive-help',
        'json-envelope',
        'offline-network-guard',
        'standalone-auth-runtime'
      ])

      const draftValidation = validateThroughWrapper(generated.skillDir)
      expect(draftValidation.exitCode, draftValidation.stderr).toBe(0)
      expect(draftValidation.json).toMatchObject({ ok: true, status: 'valid' })
      expect(JSON.parse(await readFile(manifestPath, 'utf8')).status).toBe('draft')

      const readyManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      readyManifest.status = 'ready'
      await writeFile(manifestPath, `${JSON.stringify(readyManifest, null, 2)}\n`)
      const readyValidation = validateThroughWrapper(generated.skillDir)
      expect(readyValidation.exitCode, readyValidation.stdout || readyValidation.stderr).toBe(0)
      expect(readyValidation.json).toMatchObject({ ok: true, status: 'valid' })

      const skillDocumentPath = join(generated.skillDir, 'SKILL.md')
      const originalSkillDocument = await readFile(skillDocumentPath, 'utf8')
      await writeFile(skillDocumentPath, originalSkillDocument.replace('- `get-order`', '- `lookup-order`'))
      await expectReadyFailure(generated.skillDir, 'SKILL_COMMAND_MISMATCH')
      await writeFile(skillDocumentPath, originalSkillDocument)

      const getOrderDocPath = join(generated.skillDir, 'references', 'commands', 'get-order.md')
      const originalGetOrderDoc = await readFile(getOrderDocPath, 'utf8')
      await rm(getOrderDocPath)
      await expectReadyFailure(generated.skillDir, 'COMMAND_DOC_MISSING')
      await writeFile(getOrderDocPath, originalGetOrderDoc)

      await writeFile(getOrderDocPath, originalGetOrderDoc.replace('## Output', '## Result'))
      await expectReadyFailure(generated.skillDir, 'HELP_CONTRACT_MISSING')
      await writeFile(getOrderDocPath, originalGetOrderDoc)

      delete readyManifest.commands.find(command => command.id === 'get-order').inputs[0].sources[0].json_path
      await writeFile(manifestPath, `${JSON.stringify(readyManifest, null, 2)}\n`)
      await expectReadyFailure(generated.skillDir, 'HELP_CONTRACT_MISSING')
      readyManifest.commands.find(command => command.id === 'get-order').inputs[0].sources[0].json_path = '$.data.orders[0].id'
      await writeFile(manifestPath, `${JSON.stringify(readyManifest, null, 2)}\n`)

      const generatedCliPath = join(
        generated.skillDir,
        'scripts',
        'cli',
        'src',
        'browser_forge_order_tools',
        'cli.py'
      )
      const originalGeneratedCli = await readFile(generatedCliPath, 'utf8')
      await writeFile(generatedCliPath, originalGeneratedCli.replace(
        'def _epilog(command: dict[str, Any], manifest: dict[str, Any]) -> str:\n    requires = command.get("requires", {})',
        'def _epilog(command: dict[str, Any], manifest: dict[str, Any]) -> str:\n    if command.get("id") == "get-order":\n        return "Incomplete command help."\n    requires = command.get("requires", {})'
      ))
      await expectReadyFailure(generated.skillDir, 'RUNTIME_INTEGRITY_FAILED')
      await writeFile(generatedCliPath, originalGeneratedCli)

      const installerPath = join(generated.skillDir, 'scripts', 'install.sh')
      const originalInstaller = await readFile(installerPath, 'utf8')
      await writeFile(installerPath, `${originalInstaller}\n# untrusted installer target\n`)
      await expectReadyFailure(generated.skillDir, 'RUNTIME_INTEGRITY_FAILED')
      await writeFile(installerPath, originalInstaller)
      await chmod(installerPath, 0o755)

      const pyprojectPath = join(generated.skillDir, 'scripts', 'cli', 'pyproject.toml')
      const originalPyproject = await readFile(pyprojectPath, 'utf8')
      await writeFile(pyprojectPath, originalPyproject.replace('version = "0.1.0"', 'version = "9.9.9"'))
      await expectReadyFailure(generated.skillDir, 'RUNTIME_INTEGRITY_FAILED')
      await writeFile(pyprojectPath, originalPyproject)

      const runtimeInitPath = join(
        generated.skillDir,
        'scripts',
        'cli',
        'src',
        'browser_forge_order_tools',
        '__init__.py'
      )
      const originalRuntimeInit = await readFile(runtimeInitPath, 'utf8')
      const executionSentinel = join(root, 'validator-executed-untrusted-artifact')
      await writeFile(runtimeInitPath, [
        'from pathlib import Path',
        `Path(${JSON.stringify(executionSentinel)}).write_text("validator executed artifact", encoding="utf-8")`,
        '# Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def',
        originalRuntimeInit
      ].join('\n'))
      const maliciousValidation = validateThroughWrapper(generated.skillDir)
      expect(maliciousValidation.exitCode).toBe(1)
      expect(maliciousValidation.json.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
        'RUNTIME_INTEGRITY_FAILED',
        'READY_GATE_FAILED'
      ]))
      expect(maliciousValidation.json.findings.map(finding => finding.code)).toContain('BEARER_TOKEN')
      await expect(access(executionSentinel)).rejects.toThrow()
      await writeFile(runtimeInitPath, originalRuntimeInit)

      const siteCustomizePath = join(
        generated.skillDir,
        'scripts',
        'cli',
        'src',
        'sitecustomize.py'
      )
      await writeFile(siteCustomizePath, [
        'from pathlib import Path',
        `Path(${JSON.stringify(executionSentinel)}).write_text("validator executed sitecustomize", encoding="utf-8")`,
        ''
      ].join('\n'))
      await expectReadyFailure(generated.skillDir, 'RUNTIME_INTEGRITY_FAILED')
      await expect(access(executionSentinel)).rejects.toThrow()
      await rm(siteCustomizePath)

      const commandExtensionPath = join(
        generated.skillDir,
        'scripts',
        'cli',
        'src',
        'browser_forge_order_tools',
        'commands',
        '__init__.py'
      )
      const originalCommandExtension = await readFile(commandExtensionPath, 'utf8')
      await writeFile(commandExtensionPath, `${originalCommandExtension}\n# populated business-command extension\n`)
      expect(validateThroughWrapper(generated.skillDir)).toMatchObject({ exitCode: 0, json: { ok: true } })
      await writeFile(commandExtensionPath, originalCommandExtension)

      const readyMarkerPath = join(generated.skillDir, '.browser-forge-ready')
      const originalReadyMarker = await readFile(readyMarkerPath, 'utf8')
      readyManifest.auth.runtime_version = '9.9.9'
      await writeFile(manifestPath, `${JSON.stringify(readyManifest, null, 2)}\n`)
      await writeFile(readyMarkerPath, `${JSON.stringify({
        completed: true,
        spec_version: '1.0',
        auth_runtime_version: '9.9.9',
        builtin_commands: ['doctor', 'auth-status', 'describe']
      })}\n`)
      await expectReadyFailure(generated.skillDir, 'AUTH_VERSION_MISMATCH')
      readyManifest.auth.runtime_version = '1.0.0'
      await writeFile(readyMarkerPath, originalReadyMarker)

      readyManifest.commands = readyManifest.commands.filter(command => command.id !== 'describe')
      await writeFile(manifestPath, `${JSON.stringify(readyManifest, null, 2)}\n`)
      await writeFile(readyMarkerPath, `${JSON.stringify({
        completed: true,
        spec_version: '1.0',
        auth_runtime_version: '1.0.0',
        builtin_commands: []
      })}\n`)
      await expectReadyFailure(generated.skillDir, 'BUILTIN_COMMAND_MISSING')
      await writeFile(readyMarkerPath, originalReadyMarker)
      readyManifest.commands.splice(2, 0, {
        id: 'describe',
        summary: 'Describes the generated command contract.',
        side_effect: false,
        idempotent: true,
        inputs: [],
        outputs: { schema_ref: '#/$defs/describe-output' },
        requires: { auth: false, commands: [] },
        next_actions: [],
        steps: []
      })
      await writeFile(manifestPath, `${JSON.stringify(readyManifest, null, 2)}\n`)

      const entrypoint = join(generated.skillDir, readyManifest.cli.entrypoint)
      const originalEntrypoint = await readFile(entrypoint, 'utf8')
      await chmod(entrypoint, 0o644)
      await expectReadyFailure(generated.skillDir, 'ENTRYPOINT_INVALID')
      await chmod(entrypoint, 0o755)

      await writeFile(entrypoint, originalEntrypoint.replace(
        'PACKAGE_NAME="browser_forge_order_tools"',
        'PACKAGE_NAME="browser_forge_wrong_package"'
      ))
      await expectReadyFailure(generated.skillDir, 'ENTRYPOINT_INVALID')
      await writeFile(entrypoint, `#!/bin/sh\nexit 0\n${originalEntrypoint}`)
      await expectReadyFailure(generated.skillDir, 'ENTRYPOINT_INVALID')
      await writeFile(entrypoint, `${originalEntrypoint}\nexec python3 -m browser_forge_extra "$@"\n`)
      await expectReadyFailure(generated.skillDir, 'ENTRYPOINT_INVALID')
      await writeFile(entrypoint, originalEntrypoint)
      await chmod(entrypoint, 0o755)

      await rm(entrypoint)
      await expectReadyFailure(generated.skillDir, 'ENTRYPOINT_INVALID')
      await writeFile(entrypoint, originalEntrypoint)
      await chmod(entrypoint, 0o755)

      readyManifest.cli.entrypoint = 'scripts/browser_forge-other'
      await writeFile(manifestPath, `${JSON.stringify(readyManifest, null, 2)}\n`)
      await expectReadyFailure(generated.skillDir, 'ENTRYPOINT_INVALID')
      readyManifest.cli.entrypoint = 'scripts/browser_forge-order-tools'
      await writeFile(manifestPath, `${JSON.stringify(readyManifest, null, 2)}\n`)

      const standaloneSkill = join(standaloneRoot, 'order-tools')
      await cp(generated.skillDir, standaloneSkill, { recursive: true })
      expect(await readdir(standaloneRoot)).toEqual(['order-tools'])
      await expect(access(join(standaloneRoot, 'src'))).rejects.toThrow()
      await expect(access(join(standaloneSkill, 'recording.har'))).rejects.toThrow()
      expect(await readFile(join(standaloneSkill, 'SKILL.md'), 'utf8')).not.toContain(repositoryRoot)

      const install = execute(
        'bash',
        [join(standaloneSkill, 'scripts', 'install.sh'), '--offline'],
        standaloneSkill,
        {
          PIP_NO_INDEX: '1',
          PIP_INDEX_URL: 'http://127.0.0.1:9/simple',
          PIP_EXTRA_INDEX_URL: '',
          PIP_RETRIES: '0',
          PIP_TIMEOUT: '1'
        }
      )
      expect(install.exitCode, install.stderr).toBe(0)
      const standaloneEntrypoint = join(standaloneSkill, 'scripts', 'browser_forge-order-tools')
      for (const args of [['doctor'], ['auth-status'], ['describe']]) {
        const command = execute(standaloneEntrypoint, args, standaloneSkill)
        expect(command.exitCode, command.stderr).toBe(0)
        expect(parseSingleJson(command)).toMatchObject({ spec_version: '1.0', ok: true })
      }

      const requiredHelpSections = [
        'Dependencies:',
        'Authentication:',
        'Output:',
        'Next actions:',
        'Side effects:',
        'Idempotency:',
        'Examples:'
      ]
      for (const command of readyManifest.commands) {
        const help = execute(standaloneEntrypoint, [command.id, '--help'], standaloneSkill)
        expect(help.exitCode, `${command.id}: ${help.stderr}`).toBe(0)
        for (const section of requiredHelpSections) expect(help.stdout).toContain(section)
        if (command.id === 'get-order') {
          expect(help.stdout).toContain('Obtain from: list-orders -> $.data.orders[0].id')
        }
      }

      const networkDisabled = execute(standaloneEntrypoint, ['list-orders'], standaloneSkill)
      expect(networkDisabled.exitCode).toBe(1)
      expect(parseSingleJson(networkDisabled)).toMatchObject({
        spec_version: '1.0',
        ok: false,
        error: { code: 'NETWORK_DISABLED' }
      })

      const fixtureDir = join(standaloneSkill, 'tests', 'fixtures')
      await mkdir(fixtureDir, { recursive: true })
      await writeFile(join(fixtureDir, 'captured.txt'), 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def\n')
      await expectReadyFailure(standaloneSkill, 'READY_GATE_FAILED')
      const leakedValidation = validateThroughWrapper(standaloneSkill)
      expect(leakedValidation.json.findings.map(finding => finding.code)).toContain('BEARER_TOKEN')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(standaloneRoot, { recursive: true, force: true })
    }
  }, 180_000)
})
