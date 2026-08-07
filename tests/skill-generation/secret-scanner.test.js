import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanText, scanTree } from '../../src/skill-generation/secret-scanner.js'

const tempRoots = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('scanText', () => {
  it('finds a bearer JWT without returning it', () => {
    const findings = scanText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def', 'x.txt')

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ code: 'BEARER_TOKEN', path: 'x.txt', line: 1, column: 16 })
    expect(findings[0].preview).not.toContain('eyJhbGciOiJIUzI1NiJ9.abc.def')
  })

  it('finds a JD session cookie assignment', () => {
    expect(scanText('me_token=real-looking-long-value-123456', 'x.txt')).toHaveLength(1)
  })

  it.each([
    'sso.jd.com=short-real-value',
    'ssa.orders-app=short-real-value',
    'ssa.orders_app=short-real-value'
  ])('finds a named JD SSO cookie outside a Cookie header: %s', value => {
    expect(scanText(value, 'x.txt')).toMatchObject([{ code: 'JD_SESSION_COOKIE' }])
  })

  it('allows explicit redacted placeholders', () => {
    expect(scanText('me_token=<REDACTED>', 'x.txt')).toEqual([])
  })

  it('allows a documented SSO field name', () => {
    expect(scanText('The field name is `sso.jd.com`.', 'SKILL.md')).toEqual([])
  })

  it('finds a standalone high-entropy value', () => {
    expect(scanText('generated: K7mQ2vX9pL4rT8yN1cW6dH3sF5bJ0aZ', 'x.txt')).toHaveLength(1)
  })

  it('allows the fixed BROWSER_FORGE_INSTALL_OFFLINE template constant', () => {
    expect(scanText('- `BROWSER_FORGE_INSTALL_OFFLINE=1` enables offline install', 'references/environment.md')).toEqual([])
  })

  it('still flags a high-entropy token that only resembles the allowed constant', () => {
    expect(scanText('BROWSER_FORGE_INSTALL_OFFLINE_9f3ac2b7d0e1', 'x.txt')).toHaveLength(1)
  })
})

describe('scanTree', () => {
  it('scans source, fixtures, JSON, Markdown, and logs while skipping cache and git directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browser-forge-secret-scan-'))
    tempRoots.push(root)
    await Promise.all([
      mkdir(join(root, '.venv'), { recursive: true }),
      mkdir(join(root, '__pycache__'), { recursive: true }),
      mkdir(join(root, '.git'), { recursive: true }),
      mkdir(join(root, 'tests', 'fixtures'), { recursive: true })
    ])
    await Promise.all([
      writeFile(join(root, 'client.py'), 'Authorization: Bearer aaa.bbb.ccc'),
      writeFile(join(root, 'tests', 'fixtures', 'session.txt'), 'cookie=sessionid=fixture-secret-value-123456'),
      writeFile(join(root, 'manifest.json'), '{"token":"K7mQ2vX9pL4rT8yN1cW6dH3sF5bJ0aZ"}'),
      writeFile(join(root, 'SKILL.md'), 'X-Api-Key: api-key-secret-value-123456'),
      writeFile(join(root, 'generate.log'), 'me_token=log-secret-value-123456'),
      writeFile(join(root, '.venv', 'ignored.py'), 'Authorization: Bearer ignored.ignored.ignored'),
      writeFile(join(root, '__pycache__', 'ignored.pyc'), 'me_token=ignored-secret-value-123456'),
      writeFile(join(root, '.git', 'config'), 'Authorization: Bearer ignored.ignored.ignored')
    ])

    const findings = await scanTree(root)
    const paths = findings.map(finding => finding.path)

    expect(paths).toEqual(expect.arrayContaining([
      'client.py',
      'tests/fixtures/session.txt',
      'manifest.json',
      'SKILL.md',
      'generate.log'
    ]))
    expect(paths.some(path => path.startsWith('.venv/') || path.startsWith('__pycache__/') || path.startsWith('.git/'))).toBe(false)
  })
})
