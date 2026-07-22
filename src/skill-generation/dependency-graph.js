const JSON_PATH_V1 = /^\$(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\*\]|\[\d+\])*$/
const RESERVED_INPUT_NAMES = new Set([
  'command_spec',
  'described_command',
  'help',
  'refresh_auth',
  'selected_command'
])

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function stringIds(values) {
  return values.flatMap(value => typeof asObject(value).id === 'string' ? [value.id] : [])
}

function findCycles(nodes, edgesFor, createIssue) {
  const visiting = new Set()
  const visited = new Set()
  const issues = []

  function visit(node) {
    if (visited.has(node)) return
    visiting.add(node)
    for (const edge of edgesFor(node) ?? []) {
      if (visiting.has(edge.target)) {
        issues.push(createIssue(edge, node))
      } else {
        visit(edge.target)
      }
    }
    visiting.delete(node)
    visited.add(node)
  }

  for (const node of nodes) visit(node)
  return issues
}

function unknownCommandIssue(path, command) {
  return { code: 'UNKNOWN_COMMAND_REFERENCE', path, message: `Unknown command: ${command}` }
}

function resolvePointer(root, reference) {
  if (typeof reference !== 'string' || !reference.startsWith('#/')) return undefined
  const tokens = reference.slice(2).split('/').map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'))
  let value = root
  for (const token of tokens) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, token)) return undefined
    value = value[token]
  }
  return value
}

function schemaAllowsPath(root, rawSchema, jsonPath) {
  let schema = rawSchema
  const tokens = [...jsonPath.matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)|\[(\*|\d+)\]/g)]
    .map(match => match[1] ?? match[2])
  if (tokens[0] === 'data') tokens.shift()
  if (tokens[0] === 'output') tokens.shift()
  let dereferenceDepth = 0
  for (const token of tokens) {
    while (schema && typeof schema === 'object' && typeof schema.$ref === 'string') {
      if (dereferenceDepth++ > 100) return false
      schema = resolvePointer(root, schema.$ref)
    }
    if (schema === false || schema === undefined || schema === null) return false
    if (schema === true || typeof schema !== 'object' || Array.isArray(schema)) return true
    if (Array.isArray(schema.anyOf)) return schema.anyOf.some(candidate => schemaAllowsPath(root, candidate, `$.${tokens.join('.')}`))
    if (Array.isArray(schema.oneOf)) return schema.oneOf.some(candidate => schemaAllowsPath(root, candidate, `$.${tokens.join('.')}`))
    if (Array.isArray(schema.allOf)) return schema.allOf.every(candidate => schemaAllowsPath(root, candidate, `$.${tokens.join('.')}`))
    if (/^\d+$/.test(token) || token === '*') {
      if (schema.type && schema.type !== 'array') return false
      if (schema.items === false) return false
      if (!schema.items || Array.isArray(schema.items)) return true
      schema = schema.items
      continue
    }
    if (schema.type === 'array') return false
    if (schema.properties && Object.hasOwn(schema.properties, token)) {
      schema = schema.properties[token]
      continue
    }
    if (schema.additionalProperties === false) return false
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      schema = schema.additionalProperties
      continue
    }
    return true
  }
  return schema !== false
}

function pathSchemaIssue(path, jsonPath, producingCommand) {
  return {
    code: 'JSON_PATH_SCHEMA_MISMATCH',
    path,
    message: `JSON Path is excluded by ${producingCommand}'s output schema: ${jsonPath}`
  }
}

export function validateDependencyGraph(manifest) {
  const commands = asArray(manifest?.commands)
  const commandIds = new Set(stringIds(commands))
  const commandsById = new Map(commands.flatMap(rawCommand => {
    const command = asObject(rawCommand)
    return typeof command.id === 'string' ? [[command.id, command]] : []
  }))
  const commandEdges = new Map([...commandIds].map(commandId => [commandId, []]))
  const issues = []

  for (const [commandIndex, rawCommand] of commands.entries()) {
    const command = asObject(rawCommand)
    const commandPath = `commands[${commandIndex}]`
    const prerequisiteEdges = commandEdges.get(command.id)
    const seenInputNames = new Set()
    for (const [inputIndex, rawInput] of asArray(command.inputs).entries()) {
      const input = asObject(rawInput)
      const inputPath = `${commandPath}.inputs[${inputIndex}].name`
      if (RESERVED_INPUT_NAMES.has(input.name)) {
        issues.push({
          code: 'RESERVED_INPUT_NAME',
          path: inputPath,
          message: `Input name is reserved by the CLI: ${input.name}`
        })
      }
      if (seenInputNames.has(input.name)) {
        issues.push({
          code: 'DUPLICATE_INPUT_NAME',
          path: inputPath,
          message: `Input names must be unique within ${command.id}: ${input.name}`
        })
      }
      if (typeof input.name === 'string') seenInputNames.add(input.name)
    }
    const references = [
      ...asArray(asObject(command.requires).commands).map((target, index) => ({
        target,
        path: `${commandPath}.requires.commands[${index}]`,
        prerequisite: true
      })),
      ...asArray(command.inputs).flatMap((rawInput, inputIndex) =>
        asArray(asObject(rawInput).sources).map((rawSource, sourceIndex) => ({
          target: asObject(rawSource).command,
          path: `${commandPath}.inputs[${inputIndex}].sources[${sourceIndex}].command`,
          prerequisite: true
        }))
      ),
      ...asArray(command.next_actions).map((rawAction, actionIndex) => ({
        target: asObject(rawAction).command,
        path: `${commandPath}.next_actions[${actionIndex}].command`,
        prerequisite: false
      }))
    ]

    for (const reference of references) {
      if (!commandIds.has(reference.target)) {
        issues.push(unknownCommandIssue(reference.path, reference.target))
      } else if (reference.prerequisite && prerequisiteEdges) {
        prerequisiteEdges.push(reference)
      }
    }

    for (const [actionIndex, rawAction] of asArray(command.next_actions).entries()) {
      const action = asObject(rawAction)
      const targetInputs = new Set(asArray(commandsById.get(action.command)?.inputs).map(input => asObject(input).name))
      for (const binding of Object.keys(asObject(action.bindings))) {
        if (!targetInputs.has(binding)) {
          issues.push({
            code: 'UNKNOWN_INPUT_BINDING',
            path: `${commandPath}.next_actions[${actionIndex}].bindings.${binding}`,
            message: `Unknown input binding for ${action.command}: ${binding}`
          })
        }
      }
    }

    for (const [inputIndex, rawInput] of asArray(command.inputs).entries()) {
      for (const [sourceIndex, rawSource] of asArray(asObject(rawInput).sources).entries()) {
        const source = asObject(rawSource)
        const path = `${commandPath}.inputs[${inputIndex}].sources[${sourceIndex}].json_path`
        if (!JSON_PATH_V1.test(source.json_path)) {
          issues.push({
            code: 'INVALID_JSON_PATH',
            path,
            message: `Invalid JSON Path: ${source.json_path}`
          })
        } else {
          const producer = commandsById.get(source.command)
          const producerSchema = resolvePointer(manifest, producer?.outputs?.schema_ref)
          if (producer && producerSchema !== undefined && !schemaAllowsPath(manifest, producerSchema, source.json_path)) {
            issues.push(pathSchemaIssue(path, source.json_path, source.command))
          }
        }
      }
    }

    for (const [actionIndex, rawAction] of asArray(command.next_actions).entries()) {
      const action = asObject(rawAction)
      for (const [binding, jsonPath] of Object.entries(asObject(action.bindings))) {
        const path = `${commandPath}.next_actions[${actionIndex}].bindings.${binding}`
        if (!JSON_PATH_V1.test(jsonPath)) {
          issues.push({
            code: 'INVALID_JSON_PATH',
            path,
            message: `Invalid JSON Path: ${jsonPath}`
          })
        } else {
          const producerSchema = resolvePointer(manifest, command.outputs?.schema_ref)
          if (producerSchema !== undefined && !schemaAllowsPath(manifest, producerSchema, jsonPath)) {
            issues.push(pathSchemaIssue(path, jsonPath, command.id))
          }
        }
      }
    }

    const steps = asArray(command.steps)
    const stepIds = new Set(stringIds(steps))
    const stepEdges = new Map([...stepIds].map(stepId => [stepId, []]))
    const seenStepIds = new Set()
    for (const [stepIndex, rawStep] of steps.entries()) {
      const step = asObject(rawStep)
      if (seenStepIds.has(step.id)) {
        issues.push({
          code: 'DUPLICATE_STEP_ID',
          path: `${commandPath}.steps[${stepIndex}].id`,
          message: `Step ids must be unique within ${command.id}: ${step.id}`
        })
      }
      for (const [dependencyIndex, dependency] of asArray(step.depends_on).entries()) {
        const path = `${commandPath}.steps[${stepIndex}].depends_on[${dependencyIndex}]`
        if (!stepIds.has(dependency)) {
          issues.push({ code: 'UNKNOWN_STEP_REFERENCE', path, message: `Unknown step: ${dependency}` })
        } else {
          if (!seenStepIds.has(dependency)) {
            issues.push({
              code: 'FORWARD_STEP_DEPENDENCY',
              path,
              message: `Step dependencies must refer to an earlier step: ${dependency}`
            })
          }
          stepEdges.get(step.id)?.push({ target: dependency, path })
        }
      }
      if (typeof step.id === 'string') seenStepIds.add(step.id)
    }
    issues.push(...findCycles(
      [...stepIds],
      stepId => stepEdges.get(stepId),
      (edge, stepId) => ({
        code: 'STEP_DEPENDENCY_CYCLE',
        path: edge.path,
        message: `Step dependency cycle in ${command.id}: ${stepId} -> ${edge.target}`
      })
    ))
  }

  for (const [workflowIndex, rawWorkflow] of asArray(manifest?.workflows).entries()) {
    const workflow = asObject(rawWorkflow)
    for (const [stepIndex, rawStep] of asArray(workflow.steps).entries()) {
      const step = asObject(rawStep)
      const stepPath = `workflows[${workflowIndex}].steps[${stepIndex}]`
      if (!commandIds.has(step.command)) {
        issues.push(unknownCommandIssue(`${stepPath}.command`, step.command))
      }
      const targetInputs = new Set(asArray(commandsById.get(step.command)?.inputs).map(input => asObject(input).name))
      for (const [binding, jsonPath] of Object.entries(asObject(step.bindings))) {
        if (!targetInputs.has(binding)) {
          issues.push({
            code: 'UNKNOWN_INPUT_BINDING',
            path: `${stepPath}.bindings.${binding}`,
            message: `Unknown input binding for ${step.command}: ${binding}`
          })
        }
        if (!JSON_PATH_V1.test(jsonPath)) {
          issues.push({
            code: 'INVALID_JSON_PATH',
            path: `${stepPath}.bindings.${binding}`,
            message: `Invalid JSON Path: ${jsonPath}`
          })
        }
      }
    }
  }

  issues.push(...findCycles(
    [...commandIds],
    commandId => commandEdges.get(commandId),
    (edge, commandId) => ({
      code: 'COMMAND_DEPENDENCY_CYCLE',
      path: edge.path,
      message: `Command dependency cycle: ${commandId} -> ${edge.target}`
    })
  ))

  return issues
}
