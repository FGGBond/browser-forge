import { createHash } from 'node:crypto'

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase())
}

function cleanHost(value) {
  return String(value ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/g, '')
}

function present(value) {
  return String(value ?? '').trim() !== ''
}

function compiledValue(name) {
  let value
  switch (name) {
    case '__BROWSER_FORGE_TELEMETRY_BUILD__':
      value = typeof __BROWSER_FORGE_TELEMETRY_BUILD__ !== 'undefined' ? __BROWSER_FORGE_TELEMETRY_BUILD__ : globalThis[name]
      break
    case '__BROWSER_FORGE_SLS_HOST__':
      value = typeof __BROWSER_FORGE_SLS_HOST__ !== 'undefined' ? __BROWSER_FORGE_SLS_HOST__ : globalThis[name]
      break
    case '__BROWSER_FORGE_SLS_PROJECT__':
      value = typeof __BROWSER_FORGE_SLS_PROJECT__ !== 'undefined' ? __BROWSER_FORGE_SLS_PROJECT__ : globalThis[name]
      break
    case '__BROWSER_FORGE_SLS_LOGSTORE__':
      value = typeof __BROWSER_FORGE_SLS_LOGSTORE__ !== 'undefined' ? __BROWSER_FORGE_SLS_LOGSTORE__ : globalThis[name]
      break
    case '__BROWSER_FORGE_SLS_TOPIC__':
      value = typeof __BROWSER_FORGE_SLS_TOPIC__ !== 'undefined' ? __BROWSER_FORGE_SLS_TOPIC__ : globalThis[name]
      break
    case '__BROWSER_FORGE_SLS_SOURCE__':
      value = typeof __BROWSER_FORGE_SLS_SOURCE__ !== 'undefined' ? __BROWSER_FORGE_SLS_SOURCE__ : globalThis[name]
      break
    default:
      value = globalThis[name]
  }
  return value === undefined || value === null ? undefined : value
}

function firstPresent(...values) {
  for (const value of values) {
    if (present(value)) return value
  }
  return ''
}

function resolveBuildEnabled(env) {
  const compiled = compiledValue('__BROWSER_FORGE_TELEMETRY_BUILD__')
  if (compiled === true || compiled === 'true') return true
  if (compiled === false || compiled === 'false') return false
  return truthy(env.BROWSER_FORGE_TELEMETRY_BUILD)
}

export function hashForTelemetry(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 16)
}

export function resolveTelemetryConfig({ env = process.env, app } = {}) {
  const buildEnabled = resolveBuildEnabled(env)
  const runtimeDisabled = truthy(env.BROWSER_FORGE_TELEMETRY_DISABLED)
  const sls = {
    host: cleanHost(firstPresent(env.BROWSER_FORGE_SLS_HOST, compiledValue('__BROWSER_FORGE_SLS_HOST__'))),
    project: String(firstPresent(env.BROWSER_FORGE_SLS_PROJECT, compiledValue('__BROWSER_FORGE_SLS_PROJECT__'))).trim(),
    logstore: String(firstPresent(env.BROWSER_FORGE_SLS_LOGSTORE, compiledValue('__BROWSER_FORGE_SLS_LOGSTORE__'))).trim(),
    topic: String(firstPresent(env.BROWSER_FORGE_SLS_TOPIC, compiledValue('__BROWSER_FORGE_SLS_TOPIC__'), 'browser-forge')).trim() || 'browser-forge',
    source: String(firstPresent(env.BROWSER_FORGE_SLS_SOURCE, compiledValue('__BROWSER_FORGE_SLS_SOURCE__'), 'browser-forge-electron')).trim() || 'browser-forge-electron'
  }
  const hasSlsTarget = present(sls.host) && present(sls.project) && present(sls.logstore)
  const enabled = buildEnabled && !runtimeDisabled && hasSlsTarget

  return {
    enabled,
    build: buildEnabled ? 'telemetry' : 'private',
    channel: env.BROWSER_FORGE_TELEMETRY_CHANNEL || (buildEnabled ? 'jd-internal' : 'private'),
    sourceCommit: env.BROWSER_FORGE_SOURCE_COMMIT || 'unknown',
    appVersion: app?.getVersion?.() ?? env.npm_package_version ?? '0.0.0',
    sls,
    batchSize: Number(env.BROWSER_FORGE_TELEMETRY_BATCH_SIZE) || 10,
    flushIntervalMs: Number(env.BROWSER_FORGE_TELEMETRY_FLUSH_INTERVAL_MS) || 15000,
    shutdownFlushTimeoutMs: Number(env.BROWSER_FORGE_TELEMETRY_SHUTDOWN_FLUSH_TIMEOUT_MS) || 1500
  }
}

function scalar(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

export function flattenEvent(event) {
  const flattened = {
    event_id: scalar(event.event_id),
    event_name: scalar(event.event_name),
    event_time: scalar(event.event_time),
    schema_version: scalar(event.schema_version),
    app_name: scalar(event.app?.name),
    app_version: scalar(event.app?.version),
    channel: scalar(event.app?.channel),
    source_commit: scalar(event.app?.source_commit),
    erp: scalar(event.user?.erp),
    erp_source: scalar(event.user?.erp_source),
    install_id: scalar(event.user?.install_id),
    app_session_id: scalar(event.user?.app_session_id),
    machine_hash: scalar(event.user?.machine_hash),
    platform: scalar(event.runtime?.platform),
    arch: scalar(event.runtime?.arch),
    electron: scalar(event.runtime?.electron),
    node: scalar(event.runtime?.node)
  }
  for (const [key, value] of Object.entries(event.properties ?? {})) {
    flattened[key] = scalar(value)
  }
  return Object.fromEntries(Object.entries(flattened).filter(([, value]) => value !== ''))
}
