import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTelemetry } from './client.js'

// The skill-generation CLI (src/skill-generation/cli.mjs) runs headless — no
// Electron `app`, so it cannot supply app.getPath('userData') or getVersion().
// This shim provides the two members createTelemetry/resolveIdentity read, so
// generation-side events flow through the exact same client, config gate, and
// SLS uploader as the app. When telemetry is not built in (the default private
// build) createTelemetry returns the noop and none of this touches disk.
function headlessApp(env = process.env) {
  const userData = env.BROWSER_FORGE_TELEMETRY_HOME
    || join(tmpdir(), 'browser-forge-cli')
  return {
    getPath(name) {
      if (name === 'userData') return userData
      return userData
    },
    getVersion() {
      return env.npm_package_version ?? '0.0.0'
    }
  }
}

// Build a telemetry instance suitable for a short-lived CLI invocation. Returns
// the shared noop when telemetry is disabled (default), so callers can always
// `await telemetry.track(...)` and `await telemetry.close()` unconditionally.
export function createHeadlessTelemetry({ env = process.env, logger = console, ...telemetryOptions } = {}) {
  return createTelemetry({ app: headlessApp(env), env, logger, ...telemetryOptions })
}
