import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

async function findVenvPython(skillDir) {
  const candidates = [
    join(skillDir, 'scripts', '.venv', 'bin', 'python'),
    join(skillDir, 'scripts', '.venv', 'Scripts', 'python.exe')
  ]
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Try the next platform-specific virtualenv layout.
    }
  }
  throw new Error(`Generated virtualenv Python was not found: ${candidates.join(', ')}`)
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

      const python = await findVenvPython(result.skillDir)
      const dependency = execute(python, ['-c', 'import browser_cookie3; print(browser_cookie3.__name__)'], result.skillDir)
      expect(dependency.status, dependency.stderr).toBe(0)
      expect(dependency.stdout.trim()).toBe('browser_cookie3')

      const pyproject = await readFile(join(result.skillDir, 'scripts', 'cli', 'pyproject.toml'), 'utf8')
      expect(pyproject).toContain('"browser-cookie3>=0.19.1"')
      expect(pyproject).toContain('"cryptography>=')

      const manifest = JSON.parse(await readFile(join(result.skillDir, 'manifest.json'), 'utf8'))
      expect(manifest.auth.providers).toEqual(['browser_cookie'])

      const tests = execute(python, ['-m', 'pytest', '-q', 'tests/test_auth_selection.py'], result.skillDir)
      expect(tests.status, `${tests.stdout}\n${tests.stderr}`).toBe(0)
      const captured = `${tests.stdout}\n${tests.stderr}`
      for (const placeholder of [
        '<REDACTED>',
        '<ME-TOKEN-SECRET>',
        '<AUTH-CODE-SECRET>',
        '<GETCODE-FLOW-SECRET>',
        '<SSO-TICKET-SECRET>',
        '<TARGET-SESSION-SECRET>',
        '<ANALYTICS-SECRET>',
        '<DEVICE-EID-SECRET>',
        '<DEVICE-UUID-SECRET>',
        '<DEVICE-ACCOUNT-SECRET>',
        '<TEAM-ID-SECRET>',
        '<HOSTILE-COOKIE-SECRET>',
        '<EXPIRED-COOKIE-SECRET>',
        '<BAD-PATH-COOKIE-SECRET>',
        '<ENCRYPTED-COOKIE-SECRET>',
        '<MALFORMED-SECRET>',
        '<BROWSER>',
        '<FRESH-BROWSER-SECRET>',
        '<STALE-CACHED-SECRET>',
        '<RUNTIME-COOKIE>'
      ]) expect(captured).not.toContain(placeholder)

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
