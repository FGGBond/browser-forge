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

    expect(validateDependencyGraph(manifest)).toContainEqual({
      code: 'UNKNOWN_COMMAND_REFERENCE',
      path: 'commands[0].next_actions[0].command',
      message: 'Unknown command: list-orders'
    })
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

    expect(validateDependencyGraph(manifest)).toContainEqual({
      code: 'UNKNOWN_STEP_REFERENCE',
      path: 'commands[0].steps[0].depends_on[0]',
      message: 'Unknown step: resolve-account'
    })
  })

  it('reports duplicate request step IDs', () => {
    const manifest = structuredClone(validManifest)
    manifest.commands[0].steps.push(
      { id: 'load-order', request: 'GET /orders/1', depends_on: [] },
      { id: 'load-order', request: 'GET /orders/2', depends_on: [] }
    )

    expect(codes(manifest)).toContain('DUPLICATE_STEP_ID')
  })

  it('rejects a dependency declared after the dependent step', () => {
    const manifest = structuredClone(validManifest)
    manifest.commands[0].steps.push(
      { id: 'load-order', request: 'GET /orders/1', depends_on: ['load-account'] },
      { id: 'load-account', request: 'GET /account', depends_on: [] }
    )

    expect(codes(manifest)).toContain('FORWARD_STEP_DEPENDENCY')
  })

  it.each(['help', 'refresh_auth', 'command_spec', 'selected_command', 'described_command'])(
    'rejects the reserved input name %s', name => {
      const manifest = structuredClone(validManifest)
      manifest.commands[0].inputs.push({ name, type: 'string', required: false, sources: [] })

      expect(codes(manifest)).toContain('RESERVED_INPUT_NAME')
    }
  )

  it('reports duplicate input names', () => {
    const manifest = structuredClone(validManifest)
    manifest.commands[0].inputs.push(
      { name: 'order_id', type: 'string', required: false, sources: [] },
      { name: 'order_id', type: 'string', required: false, sources: [] }
    )

    expect(codes(manifest)).toContain('DUPLICATE_INPUT_NAME')
  })

  it('reports a next-action binding that is not a target input', () => {
    const manifest = withCommand({
      id: 'get-order',
      summary: 'Gets an order.',
      side_effect: false,
      idempotent: true,
      inputs: [{ name: 'order_id', type: 'string', required: true, sources: [] }],
      outputs: { schema_ref: '#/$defs/get-order-output' },
      requires: { auth: false, commands: [] },
      next_actions: [],
      steps: []
    })
    manifest.commands[0].next_actions.push({
      command: 'get-order',
      bindings: { unknown_id: '$.data.order_id' }
    })

    expect(codes(manifest)).toContain('UNKNOWN_INPUT_BINDING')
  })

  it('reports workflow command and input binding errors', () => {
    const manifest = withCommand({
      id: 'get-order',
      summary: 'Gets an order.',
      side_effect: false,
      idempotent: true,
      inputs: [{ name: 'order_id', type: 'string', required: true, sources: [] }],
      outputs: { schema_ref: '#/$defs/get-order-output' },
      requires: { auth: false, commands: [] },
      next_actions: [],
      steps: []
    })
    manifest.workflows = [{
      id: 'inspect-order',
      steps: [
        { command: 'get-order', bindings: { wrong_id: '$.steps[0].data.id' } },
        { command: 'missing-command', bindings: {} }
      ]
    }]

    expect(codes(manifest)).toEqual(expect.arrayContaining([
      'UNKNOWN_INPUT_BINDING',
      'UNKNOWN_COMMAND_REFERENCE'
    ]))
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

  it('reports a JSON path excluded by the producing output schema', () => {
    const manifest = withCommand({
      id: 'get-order',
      summary: 'Gets an order.',
      side_effect: false,
      idempotent: true,
      inputs: [{
        name: 'order_id',
        type: 'string',
        required: true,
        sources: [{ command: 'doctor', json_path: '$.data.missing_id' }]
      }],
      outputs: { schema_ref: '#/$defs/get-order-output' },
      requires: { auth: false, commands: ['doctor'] },
      next_actions: [],
      steps: []
    })
    manifest.$defs['doctor-output'] = {
      type: 'object',
      additionalProperties: false,
      properties: { ready: { type: 'boolean' } }
    }

    expect(codes(manifest)).toContain('JSON_PATH_SCHEMA_MISMATCH')
  })

  it.each([
    {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { child: { $ref: '#/$defs/doctor-output' } }
      },
      path: '$.data.output.child.child.missing'
    },
    {
      schema: { type: 'array', items: { type: 'string' } },
      path: '$.data.output.missing'
    },
    {
      schema: {
        anyOf: [
          { type: 'object', additionalProperties: false, properties: { ready: { type: 'boolean' } } },
          { type: 'object', additionalProperties: false, properties: { status: { type: 'string' } } }
        ]
      },
      path: '$.data.output.missing'
    }
  ])('rejects paths excluded by recursive, typed, or composed schema %j', ({ schema, path }) => {
    const manifest = withCommand({
      id: 'get-order',
      summary: 'Gets an order.',
      side_effect: false,
      idempotent: true,
      inputs: [{
        name: 'order_id',
        type: 'string',
        required: true,
        sources: [{ command: 'doctor', json_path: path }]
      }],
      outputs: { schema_ref: '#/$defs/get-order-output' },
      requires: { auth: false, commands: ['doctor'] },
      next_actions: [],
      steps: []
    })
    manifest.$defs['doctor-output'] = schema

    expect(codes(manifest)).toContain('JSON_PATH_SCHEMA_MISMATCH')
  })

  it('ignores schema-invalid command entries without throwing', () => {
    expect(validateDependencyGraph({ commands: [null] })).toEqual([])
  })
})
