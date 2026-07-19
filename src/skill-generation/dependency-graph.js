const JSON_PATH_V1 = /^\$(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\*\]|\[\d+\])*$/

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

export function validateDependencyGraph(manifest) {
  const commands = asArray(manifest?.commands)
  const commandIds = new Set(stringIds(commands))
  const commandEdges = new Map([...commandIds].map(commandId => [commandId, []]))
  const issues = []

  for (const [commandIndex, rawCommand] of commands.entries()) {
    const command = asObject(rawCommand)
    const commandPath = `commands[${commandIndex}]`
    const prerequisiteEdges = commandEdges.get(command.id)
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

    for (const [inputIndex, rawInput] of asArray(command.inputs).entries()) {
      for (const [sourceIndex, rawSource] of asArray(asObject(rawInput).sources).entries()) {
        const source = asObject(rawSource)
        if (!JSON_PATH_V1.test(source.json_path)) {
          issues.push({
            code: 'INVALID_JSON_PATH',
            path: `${commandPath}.inputs[${inputIndex}].sources[${sourceIndex}].json_path`,
            message: `Invalid JSON Path: ${source.json_path}`
          })
        }
      }
    }

    for (const [actionIndex, rawAction] of asArray(command.next_actions).entries()) {
      const action = asObject(rawAction)
      for (const [binding, jsonPath] of Object.entries(asObject(action.bindings))) {
        if (!JSON_PATH_V1.test(jsonPath)) {
          issues.push({
            code: 'INVALID_JSON_PATH',
            path: `${commandPath}.next_actions[${actionIndex}].bindings.${binding}`,
            message: `Invalid JSON Path: ${jsonPath}`
          })
        }
      }
    }

    const steps = asArray(command.steps)
    const stepIds = new Set(stringIds(steps))
    const stepEdges = new Map([...stepIds].map(stepId => [stepId, []]))
    for (const [stepIndex, rawStep] of steps.entries()) {
      const step = asObject(rawStep)
      for (const [dependencyIndex, dependency] of asArray(step.depends_on).entries()) {
        const path = `${commandPath}.steps[${stepIndex}].depends_on[${dependencyIndex}]`
        if (!stepIds.has(dependency)) {
          issues.push({ code: 'UNKNOWN_STEP_REFERENCE', path, message: `Unknown step: ${dependency}` })
        } else {
          stepEdges.get(step.id)?.push({ target: dependency, path })
        }
      }
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
