export function createState(initialValue) {
  let value = structuredClone(initialValue)
  const listeners = new Set()
  return {
    get value() { return value },
    update(patch) {
      value = { ...value, ...(typeof patch === 'function' ? patch(value) : patch) }
      for (const listener of listeners) listener(value)
      return value
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
