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
  const issues = []
  let manifestText
  try {
    manifestText = await readFile(join(skillDir, 'manifest.json'), 'utf8')
  } catch (error) {
    issues.push({ code: 'MANIFEST_READ_ERROR', path: 'manifest.json', message: error.message })
  }

  if (manifestText !== undefined) {
    try {
      manifest = JSON.parse(manifestText)
    } catch (error) {
      issues.push({ code: 'MANIFEST_PARSE_ERROR', path: 'manifest.json', message: error.message })
    }
  }

  if (manifestText !== undefined && !issues.some(issue => issue.code === 'MANIFEST_PARSE_ERROR')) {
    try {
      if (!validateSchema(manifest)) issues.push(...schemaIssues(validateSchema.errors))
    } catch (error) {
      issues.push({ code: 'SCHEMA_VALIDATION_ERROR', path: 'manifest.json', message: error.message })
    }
    try {
      issues.push(...validateDependencyGraph(manifest))
    } catch (error) {
      issues.push({ code: 'DEPENDENCY_GRAPH_VALIDATION_ERROR', path: 'manifest.json', message: error.message })
    }
  }

  let findings = []
  try {
    findings = await scanTree(skillDir)
  } catch (error) {
    issues.push({ code: 'SKILL_SCAN_ERROR', path: '.', message: error.message })
  }

  return { ok: issues.length === 0 && findings.length === 0, issues, findings, manifest }
}
