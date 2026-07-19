const JSON_PATH_V1 = /^\$(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\*\]|\[\d+\])*$/

function findCycles(nodes, edgesFor, createIssue) {
  const visiting = new Set()
  const visited = new Set()
  const issues = []

  function visit(node) {
    if (visited.has(node)) return
    visiting.add(node)
    for (const edge of edgesFor(node)) {
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
  const commands = Array.isArray(manifest?.commands) ? manifest.commands : []
  const commandIds = new Set(commands.map(command => command.id))
  const commandEdges = new Map(commands.map(command => [command.id, []]))
  const issues = []

  for (const [commandIndex, command] of commands.entries()) {
    const commandPath = `commands[${commandIndex}]`
    const prerequisiteEdges = commandEdges.get(command.id)
    const references = [
      ...(command.requires?.commands ?? []).map((target, index) => ({
        target,
        path: `${commandPath}.requires.commands[${index}]`,
        prerequisite: true
      })),
      ...(command.inputs ?? []).flatMap((input, inputIndex) =>
        (input.sources ?? []).map((source, sourceIndex) => ({
          target: source.command,
          path: `${commandPath}.inputs[${inputIndex}].sources[${sourceIndex}].command`,
          prerequisite: true,
          source
        }))
      ),
      ...(command.next_actions ?? []).map((action, actionIndex) => ({
        target: action.command,
        path: `${commandPath}.next_actions[${actionIndex}].command`,
        prerequisite: false,
        action,
        actionIndex
      }))
    ]

    for (const reference of references) {
      if (!commandIds.has(reference.target)) {
        issues.push(unknownCommandIssue(reference.path, reference.target))
      } else if (reference.prerequisite) {
        prerequisiteEdges.push(reference)
      }
    }

    for (const [inputIndex, input] of (command.inputs ?? []).entries()) {
      for (const [sourceIndex, source] of (input.sources ?? []).entries()) {
        if (!JSON_PATH_V1.test(source.json_path)) {
          issues.push({
            code: 'INVALID_JSON_PATH',
            path: `${commandPath}.inputs[${inputIndex}].sources[${sourceIndex}].json_path`,
            message: `Invalid JSON Path: ${source.json_path}`
          })
        }
      }
    }

    for (const [actionIndex, action] of (command.next_actions ?? []).entries()) {
      for (const [binding, jsonPath] of Object.entries(action.bindings ?? {})) {
        if (!JSON_PATH_V1.test(jsonPath)) {
          issues.push({
            code: 'INVALID_JSON_PATH',
            path: `${commandPath}.next_actions[${actionIndex}].bindings.${binding}`,
            message: `Invalid JSON Path: ${jsonPath}`
          })
        }
      }
    }

    const steps = command.steps ?? []
    const stepIds = new Set(steps.map(step => step.id))
    const stepEdges = new Map(steps.map(step => [step.id, []]))
    for (const [stepIndex, step] of steps.entries()) {
      for (const [dependencyIndex, dependency] of (step.depends_on ?? []).entries()) {
        const path = `${commandPath}.steps[${stepIndex}].depends_on[${dependencyIndex}]`
        if (!stepIds.has(dependency)) {
          issues.push({ code: 'UNKNOWN_STEP_REFERENCE', path, message: `Unknown step: ${dependency}` })
        } else {
          stepEdges.get(step.id).push({ target: dependency, path })
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
