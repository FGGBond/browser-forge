import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

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
