import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { validateSkill } from '../../src/skill-generation/manifest-validator.js'

const schema = JSON.parse(await readFile(new URL('../../skills/browser-forge/schemas/manifest.schema.json', import.meta.url)))
const validManifest = JSON.parse(await readFile(new URL('./fixtures/valid-manifest.json', import.meta.url)))

const ajv = new Ajv2020({ allErrors: true, strict: true })
addFormats(ajv)
const validate = ajv.compile(schema)

describe('generated skill manifest schema', () => {
  it('accepts the valid manifest fixture', () => {
    expect(validate(validManifest)).toBe(true)
  })

  it.each([
    ['an unsupported spec version', manifest => { manifest.spec_version = '2.0' }],
    ['an invalid CLI entrypoint', manifest => { manifest.cli.entrypoint = 'scripts/invalid-entrypoint' }],
    ['a command without side_effect', manifest => { delete manifest.commands[0].side_effect }],
    ['an unknown auth provider', manifest => { manifest.auth.providers.push('unknown_provider') }]
  ])('rejects %s', (_description, mutate) => {
    const manifest = structuredClone(validManifest)
    mutate(manifest)

    expect(validate(manifest)).toBe(false)
  })
})

describe('validateSkill', () => {
  it('returns schema, graph, and secret findings together', async () => {
    const skillDir = await mkdtemp(join(tmpdir(), 'browser-forge-skill-'))
    const manifest = structuredClone(validManifest)
    manifest.commands[0].next_actions.push({ command: 'list-orders', bindings: {} })
    await writeFile(join(skillDir, 'manifest.json'), JSON.stringify(manifest))
    await writeFile(join(skillDir, 'SKILL.md'), 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def')

    try {
      const result = await validateSkill(skillDir)

      expect(result.ok).toBe(false)
      expect(result.issues.map(issue => issue.code)).toContain('UNKNOWN_COMMAND_REFERENCE')
      expect(result.findings.map(finding => finding.code)).toContain('BEARER_TOKEN')
    } finally {
      await rm(skillDir, { recursive: true, force: true })
    }
  })

  it('preserves schema issues and scans when a parseable manifest has malformed commands', async () => {
    const skillDir = await mkdtemp(join(tmpdir(), 'browser-forge-skill-'))
    const manifest = structuredClone(validManifest)
    manifest.commands = [null]
    await writeFile(join(skillDir, 'manifest.json'), JSON.stringify(manifest))
    await writeFile(join(skillDir, 'SKILL.md'), 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def')

    try {
      const result = await validateSkill(skillDir)

      expect(result.ok).toBe(false)
      expect(result.issues.map(issue => issue.code)).toContain('SCHEMA_VALIDATION_ERROR')
      expect(result.issues.map(issue => issue.code)).not.toContain('INVALID_MANIFEST')
      expect(result.findings.map(finding => finding.code)).toContain('BEARER_TOKEN')
    } finally {
      await rm(skillDir, { recursive: true, force: true })
    }
  })
})
