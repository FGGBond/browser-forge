import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { arch, platform } from 'node:os'
import { resolveTelemetryConfig, flattenEvent } from './config.js'
import { createNoopTelemetry } from './noop.js'
import { resolveIdentity as defaultResolveIdentity } from './identity.js'

const KNOWN_EVENTS = new Set([
  'app_launched',
  'app_window_created',
  'app_quit',
  'app_error',
  'identity_resolved',
  'chrome_path_detected',
  'output_dir_selected',
  'setup_start_clicked',
  'recording_start_requested',
  'chrome_launch_started',
  'chrome_launch_succeeded',
  'chrome_launch_failed',
  'recording_started',
  'recording_summary_tick',
  'recording_stopped',
  'recording_stop_failed',
  'recording_abandoned',
  'recorded_tab_seen',
  'recorded_navigation',
  'recorded_user_action_summary',
  'recorded_network_summary',
  'recorded_console_summary',
  'skill_install_started',
  'skill_install_succeeded',
  'skill_install_failed',
  'skill_generation_started',
  'skill_generation_validation_failed',
  'skill_generation_succeeded',
  'skill_generation_failed',
  'generated_skill_used'
])

function sanitizeProperties(properties = {}) {
  const denied = /cookie|token|authorization|password|secret|set-cookie/i
  return Object.fromEntries(Object.entries(properties).filter(([key]) => !denied.test(key)))
}

function stringifyLog(log) {
  return Object.fromEntries(Object.entries(log).map(([key, value]) => [key, String(value)]))
}

function defaultSlsTrackerFactory(options) {
  const baseUrl = options.host.startsWith('http://') || options.host.startsWith('https://')
    ? `${options.host}/logstores/${options.logstore}/track?APIVersion=0.6.0`
    : `https://${options.project}.${options.host}/logstores/${options.logstore}/track?APIVersion=0.6.0`
  return {
    async sendBatchLogs(logs) {
      const payload = {
        __logs__: logs.map(stringifyLog),
        __topic__: options.topic,
        __source__: options.source,
        __tags__: options.tags
      }
      const response = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      if (!response.ok) throw new Error(`SLS WebTracking upload failed: ${response.status}`)
    }
  }
}

export function createTelemetry({
  app,
  env = process.env,
  logger = console,
  slsTrackerFactory = defaultSlsTrackerFactory,
  identityResolver = defaultResolveIdentity,
  clock = () => new Date(),
  uuid = randomUUID
} = {}) {
  const config = resolveTelemetryConfig({ env, app })
  if (!config.enabled) return createNoopTelemetry()

  const queuePath = join(app.getPath('userData'), 'telemetry', 'events.jsonl')
  let identityPromise = null
  let trackerPromise = null

  async function identity() {
    identityPromise ||= Promise.resolve(identityResolver({ app, env, uuid })).catch(error => {
      logger.warn?.('[browser-forge] telemetry identity failed:', error)
      return { erp: 'unknown', erp_source: 'unknown', install_id: 'unknown', app_session_id: uuid(), machine_hash: 'unknown' }
    })
    return identityPromise
  }

  async function tracker() {
    trackerPromise ||= Promise.resolve(slsTrackerFactory({
      host: config.sls.host,
      project: config.sls.project,
      logstore: config.sls.logstore,
      time: Math.ceil(config.flushIntervalMs / 1000),
      count: config.batchSize,
      topic: config.sls.topic,
      source: config.sls.source,
      tags: { app: 'browser-forge', channel: config.channel }
    }))
    return trackerPromise
  }

  async function enqueue(log) {
    await mkdir(dirname(queuePath), { recursive: true })
    await appendFile(queuePath, `${JSON.stringify(log)}\n`)
  }

  async function track(eventName, properties = {}) {
    if (!KNOWN_EVENTS.has(eventName)) return
    const user = await identity()
    const event = {
      event_id: uuid(),
      event_name: eventName,
      event_time: clock().toISOString(),
      schema_version: 1,
      app: { name: 'browser-forge', version: config.appVersion, channel: config.channel, source_commit: config.sourceCommit },
      user,
      runtime: { platform: platform(), arch: arch(), electron: process.versions.electron, node: process.versions.node },
      properties: sanitizeProperties(properties)
    }
    await enqueue(flattenEvent(event))
  }

  async function flush() {
    let text = ''
    try { text = await readFile(queuePath, 'utf8') } catch { return }
    const logs = text.split('\n').filter(Boolean).map(line => JSON.parse(line)).slice(0, config.batchSize)
    if (logs.length === 0) return
    const sls = await tracker()
    if (typeof sls.sendBatchLogs === 'function') await sls.sendBatchLogs(logs)
    else if (typeof sls.sendBatchLogsImmediate === 'function') await sls.sendBatchLogsImmediate(logs)
    else for (const log of logs) await sls.send?.(log)
    const remaining = text.split('\n').filter(Boolean).slice(logs.length).join('\n')
    await writeFile(queuePath, remaining ? `${remaining}\n` : '')
  }

  // Periodic flush to ensure events don't sit in queue indefinitely
  const flushInterval = setInterval(async () => {
    try { await flush() } catch (err) { logger.warn?.('[browser-forge] telemetry periodic flush failed:', err) }
  }, config.flushIntervalMs)
  // Don't let the periodic timer keep a short-lived process (e.g. the headless
  // skill-generation CLI) alive; the long-running Electron app is unaffected.
  flushInterval.unref?.()

  async function close() {
    clearInterval(flushInterval)
    await flush().catch(error => logger.warn?.('[browser-forge] telemetry flush failed:', error))
  }

  return { enabled: true, track, flush, close, resolveIdentity: identity }
}
