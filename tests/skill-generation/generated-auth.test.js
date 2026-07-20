import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { generateSkill } from '../../src/skill-generation/generator.js'
import { scanTree } from '../../src/skill-generation/secret-scanner.js'

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

function execute(file, args, cwd) {
  return spawnSync(file, args, {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, BROWSER_FORGE_DISABLE_NETWORK: '1' }
  })
}

describe('generated browser cookie authentication', () => {
  it('installs and passes cookie, browser provider, cache, and redaction tests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browser-forge-generated-auth-'))
    try {
      const result = await generateSkill({
        recordingDir: await createRecording(root),
        skillName: 'Order Tools',
        description: 'Manage test orders.',
        targetDomains: ['api.example.test']
      })

      expect(await scanTree(result.skillDir)).toEqual([])

      const install = execute('bash', [join(result.skillDir, 'scripts', 'install.sh'), '--with-test'], result.skillDir)
      expect(install.status, install.stderr).toBe(0)

      const python = join(result.skillDir, 'scripts', '.venv', 'bin', 'python')
      const tests = execute(python, ['-m', 'pytest', '-q', 'tests/test_auth_selection.py'], result.skillDir)
      expect(tests.status, `${tests.stdout}\n${tests.stderr}`).toBe(0)

      const source = await readFile(join(
        result.skillDir,
        'scripts',
        'cli',
        'src',
        'browser_forge_order_tools',
        'auth',
        'browser_cookies.py'
      ), 'utf8')
      expect(source).not.toMatch(/^\s*import browser_cookie3/m)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 180_000)
})
