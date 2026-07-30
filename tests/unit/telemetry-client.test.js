import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createTelemetry } from '../../src/main/telemetry/client.js'

function fakeApp(userData, version = '0.1.0') {
  return {
    getPath(name) {
      if (name !== 'userData') throw new Error(`unexpected path: ${name}`)
      return userData
    },
    getVersion() { return version }
  }
}

describe('telemetry client', () => {
  it('does not resolve ERP or create queue files when disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browser-forge-telemetry-disabled-'))
    let identityResolved = false
    const telemetry = createTelemetry({
      app: fakeApp(root),
      env: {},
      identityResolver: async () => {
        identityResolved = true
        return {}
      }
    })

    await telemetry.track('app_launched', { startup_ms: 1 })
    await telemetry.flush()

    expect(identityResolved).toBe(false)
    await expect(readFile(join(root, 'telemetry', 'events.jsonl'), 'utf8')).rejects.toThrow(/ENOENT/)
  })

  it('queues flattened events and flushes them to SLS WebTracking', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browser-forge-telemetry-enabled-'))
    const sent = []
    const telemetry = createTelemetry({
      app: fakeApp(root),
      env: {
        BROWSER_FORGE_TELEMETRY_BUILD: 'true',
        BROWSER_FORGE_SLS_HOST: 'cn-hangzhou.log.aliyuncs.com',
        BROWSER_FORGE_SLS_PROJECT: 'browser-forge-telemetry',
        BROWSER_FORGE_SLS_LOGSTORE: 'browser-forge-events',
        BROWSER_FORGE_SOURCE_COMMIT: 'abc123'
      },
      clock: () => new Date('2026-07-28T00:00:00.000Z'),
      uuid: () => 'event-1',
      identityResolver: async () => ({
        erp: 'zhangsan',
        erp_source: 'env',
        install_id: 'install-1',
        app_session_id: 'session-1',
        machine_hash: 'machine'
      }),
      slsTrackerFactory: options => ({
        sendBatchLogs(logs) {
          sent.push({ options, logs })
        }
      })
    })

    await telemetry.track('generated_skill_used', { skill_id: 'jd.order-tools', command_id: 'doctor', ok: true })
    const queue = await readFile(join(root, 'telemetry', 'events.jsonl'), 'utf8')
    expect(queue).toContain('generated_skill_used')
    expect(queue).toContain('zhangsan')

    await telemetry.flush()

    expect(sent).toHaveLength(1)
    expect(sent[0].options).toMatchObject({
      host: 'cn-hangzhou.log.aliyuncs.com',
      project: 'browser-forge-telemetry',
      logstore: 'browser-forge-events'
    })
    expect(sent[0].logs[0]).toMatchObject({
      event_id: 'event-1',
      event_name: 'generated_skill_used',
      erp: 'zhangsan',
      source_commit: 'abc123',
      skill_id: 'jd.order-tools',
      command_id: 'doctor',
      ok: 'true'
    })
    expect(await readFile(join(root, 'telemetry', 'events.jsonl'), 'utf8')).toBe('')
  })
})
