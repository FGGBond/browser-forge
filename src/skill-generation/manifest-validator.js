import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { validateDependencyGraph } from './dependency-graph.js'
import { scanTree } from './secret-scanner.js'

const schema = JSON.parse(await readFile(new URL('../../skills/browser-forge/schemas/manifest.schema.json', import.meta.url)))
const ajv = new Ajv2020({ allErrors: true, strict: true })
addFormats(ajv)
const validateSchema = ajv.compile(schema)

function schemaIssues(errors) {
  return (errors ?? []).map(error => ({
    code: 'SCHEMA_VALIDATION_ERROR',
    path: `manifest.json${error.instancePath}`,
    message: error.message ?? 'Manifest schema validation failed'
  }))
}

export async function validateSkill(skillDir) {
  let manifest = null
  let issues = []
  try {
    manifest = JSON.parse(await readFile(join(skillDir, 'manifest.json'), 'utf8'))
    if (!validateSchema(manifest)) issues.push(...schemaIssues(validateSchema.errors))
    issues.push(...validateDependencyGraph(manifest))
  } catch (error) {
    issues.push({ code: 'INVALID_MANIFEST', path: 'manifest.json', message: error.message })
  }

  let findings = []
  try {
    findings = await scanTree(skillDir)
  } catch (error) {
    issues.push({ code: 'SKILL_SCAN_ERROR', path: '.', message: error.message })
  }

  return { ok: issues.length === 0 && findings.length === 0, issues, findings, manifest }
}
