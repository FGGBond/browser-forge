import { describe, expect, it } from 'vitest'
import { resolveTelemetryConfig, flattenEvent, hashForTelemetry } from '../../src/main/telemetry/config.js'

describe('telemetry config', () => {
  it('keeps telemetry disabled unless the build and SLS target are configured', () => {
    expect(resolveTelemetryConfig({ env: {} }).enabled).toBe(false)
    expect(resolveTelemetryConfig({ env: { BROWSER_FORGE_TELEMETRY_BUILD: 'true' } }).enabled).toBe(false)
    expect(resolveTelemetryConfig({ env: {
      BROWSER_FORGE_TELEMETRY_BUILD: 'true',
      BROWSER_FORGE_SLS_HOST: 'cn-hangzhou.log.aliyuncs.com',
      BROWSER_FORGE_SLS_PROJECT: 'browser-forge-telemetry',
      BROWSER_FORGE_SLS_LOGSTORE: 'browser-forge-events'
    } }).enabled).toBe(true)
    expect(resolveTelemetryConfig({ env: {
      BROWSER_FORGE_TELEMETRY_BUILD: 'true',
      BROWSER_FORGE_TELEMETRY_DISABLED: '1',
      BROWSER_FORGE_SLS_HOST: 'cn-hangzhou.log.aliyuncs.com',
      BROWSER_FORGE_SLS_PROJECT: 'browser-forge-telemetry',
      BROWSER_FORGE_SLS_LOGSTORE: 'browser-forge-events'
    } }).enabled).toBe(false)
  })

  it('normalizes SLS WebTracking options for the JD-internal channel', () => {
    const config = resolveTelemetryConfig({ env: {
      BROWSER_FORGE_TELEMETRY_BUILD: 'true',
      BROWSER_FORGE_SLS_HOST: 'https://cn-hangzhou.log.aliyuncs.com/',
      BROWSER_FORGE_SLS_PROJECT: 'browser-forge-telemetry',
      BROWSER_FORGE_SLS_LOGSTORE: 'browser-forge-events',
      BROWSER_FORGE_SOURCE_COMMIT: 'abc1234'
    } })

    expect(config).toMatchObject({
      enabled: true,
      channel: 'jd-internal',
      sourceCommit: 'abc1234',
      sls: {
        host: 'cn-hangzhou.log.aliyuncs.com',
        project: 'browser-forge-telemetry',
        logstore: 'browser-forge-events',
        topic: 'browser-forge',
        source: 'browser-forge-electron'
      }
    })
  })


  it('honors compile-time private and telemetry variants', () => {
    globalThis.__BROWSER_FORGE_TELEMETRY_BUILD__ = false
    expect(resolveTelemetryConfig({ env: {
      BROWSER_FORGE_TELEMETRY_BUILD: 'true',
      BROWSER_FORGE_SLS_HOST: 'cn-hangzhou.log.aliyuncs.com',
      BROWSER_FORGE_SLS_PROJECT: 'browser-forge-telemetry',
      BROWSER_FORGE_SLS_LOGSTORE: 'browser-forge-events'
    } }).enabled).toBe(false)

    globalThis.__BROWSER_FORGE_TELEMETRY_BUILD__ = true
    globalThis.__BROWSER_FORGE_SLS_HOST__ = 'cn-hangzhou.log.aliyuncs.com'
    globalThis.__BROWSER_FORGE_SLS_PROJECT__ = 'browser-forge-telemetry'
    globalThis.__BROWSER_FORGE_SLS_LOGSTORE__ = 'browser-forge-events'
    expect(resolveTelemetryConfig({ env: {} })).toMatchObject({
      enabled: true,
      build: 'telemetry',
      sls: {
        host: 'cn-hangzhou.log.aliyuncs.com',
        project: 'browser-forge-telemetry',
        logstore: 'browser-forge-events'
      }
    })

    delete globalThis.__BROWSER_FORGE_TELEMETRY_BUILD__
    delete globalThis.__BROWSER_FORGE_SLS_HOST__
    delete globalThis.__BROWSER_FORGE_SLS_PROJECT__
    delete globalThis.__BROWSER_FORGE_SLS_LOGSTORE__
  })

  it('hashes error details before they are used as telemetry message hashes', () => {
    const hash = hashForTelemetry('Chrome failed with local path /Users/name/secret-profile')

    expect(hash).toMatch(/^[a-f0-9]{16}$/)
    expect(hash).not.toContain('Chrome failed')
    expect(hash).not.toBe('Chrome failed with local path /Users/name/secret-profile')
  })

  it('flattens event envelope into query-friendly key-value fields', () => {
    const flattened = flattenEvent({
      event_id: 'event-1',
      event_name: 'generated_skill_used',
      event_time: '2026-07-28T00:00:00.000Z',
      schema_version: 1,
      app: { name: 'browser-forge', version: '0.1.0', channel: 'jd-internal', source_commit: 'abc' },
      user: { erp: 'zhangsan', erp_source: 'env', install_id: 'install-1', app_session_id: 'session-1', machine_hash: 'machine' },
      runtime: { platform: 'darwin', arch: 'arm64' },
      properties: { skill_id: 'jd.order-tools', command_id: 'doctor', ok: true, duration_ms: 12 }
    })

    expect(flattened).toEqual(expect.objectContaining({
      event_id: 'event-1',
      event_name: 'generated_skill_used',
      erp: 'zhangsan',
      app_version: '0.1.0',
      channel: 'jd-internal',
      source_commit: 'abc',
      skill_id: 'jd.order-tools',
      command_id: 'doctor',
      ok: 'true',
      duration_ms: '12'
    }))
    expect(flattened.properties).toBeUndefined()
    expect(flattened.user).toBeUndefined()
  })
})
