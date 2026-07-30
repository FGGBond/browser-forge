export function createNoopTelemetry() {
  return {
    enabled: false,
    async track() {},
    async flush() {},
    async close() {},
    async resolveIdentity() { return null }
  }
}
