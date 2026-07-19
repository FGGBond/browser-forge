import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { validateDependencyGraph } from '../../src/skill-generation/dependency-graph.js'

const validManifest = JSON.parse(await readFile(new URL('./fixtures/valid-manifest.json', import.meta.url)))

function withCommand(command) {
  const manifest = structuredClone(validManifest)
  manifest.commands.push(command)
  return manifest
}

function codes(manifest) {
  return validateDependencyGraph(manifest).map(issue => issue.code)
}

describe('validateDependencyGraph', () => {
  it('accepts the valid manifest fixture', () => {
    expect(validateDependencyGraph(validManifest)).toEqual([])
  })

  it('reports an unknown next action command', () => {
    const manifest = structuredClone(validManifest)
    manifest.commands[0].next_actions.push({ command: 'list-orders', bindings: {} })

    expect(codes(manifest)).toContain('UNKNOWN_COMMAND_REFERENCE')
  })

  it('reports an unknown input source command', () => {
    const manifest = structuredClone(validManifest)
    manifest.commands[0].inputs.push({
      name: 'order_id',
      type: 'string',
      required: true,
      sources: [{ command: 'list-orders', json_path: '$.data.order_id' }]
    })

    expect(codes(manifest)).toContain('UNKNOWN_COMMAND_REFERENCE')
  })

  it('reports an unknown step dependency', () => {
    const manifest = structuredClone(validManifest)
    manifest.commands[0].steps.push({
      id: 'load-order',
      request: 'GET /orders/{order_id}',
      depends_on: ['resolve-account']
    })

    expect(codes(manifest)).toContain('UNKNOWN_STEP_REFERENCE')
  })

  it('reports a command prerequisite cycle', () => {
    const manifest = withCommand({
      id: 'list-orders',
      summary: 'Lists orders.',
      side_effect: false,
      idempotent: true,
      inputs: [],
      outputs: { schema_ref: '#/$defs/list-orders-output' },
      requires: { auth: false, commands: ['get-order'] },
      next_actions: [],
      steps: []
    })
    manifest.commands.push({
      id: 'get-order',
      summary: 'Gets an order.',
      side_effect: false,
      idempotent: true,
      inputs: [],
      outputs: { schema_ref: '#/$defs/get-order-output' },
      requires: { auth: false, commands: ['list-orders'] },
      next_actions: [],
      steps: []
    })

    expect(codes(manifest)).toContain('COMMAND_DEPENDENCY_CYCLE')
  })

  it('reports a request step cycle', () => {
    const manifest = structuredClone(validManifest)
    manifest.commands[0].steps.push(
      { id: 'resolve-account', request: 'GET /account', depends_on: ['load-order'] },
      { id: 'load-order', request: 'GET /orders/{order_id}', depends_on: ['resolve-account'] }
    )

    expect(codes(manifest)).toContain('STEP_DEPENDENCY_CYCLE')
  })

  it('reports an invalid v1 input JSON path', () => {
    const manifest = structuredClone(validManifest)
    manifest.commands[0].inputs.push({
      name: 'order_id',
      type: 'string',
      required: true,
      sources: [{ command: 'doctor', json_path: '$..order_id' }]
    })

    expect(codes(manifest)).toContain('INVALID_JSON_PATH')
  })
})
