import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createHeadlessTelemetry } from '../../src/main/telemetry/headless.js'

const SLS_ENV = {
  BROWSER_FORGE_TELEMETRY_BUILD: 'true',
  BROWSER_FORGE_SLS_HOST: 'cn-hangzhou.log.aliyuncs.com',
  BROWSER_FORGE_SLS_PROJECT: 'browser-forge-telemetry',
  BROWSER_FORGE_SLS_LOGSTORE: 'browser-forge-events'
}

describe('headless telemetry (skill-generation CLI)', () => {
  it('is a silent noop when telemetry is not built in', async () => {
    const home = await mkdtemp(join(tmpdir(), 'browser-forge-headless-off-'))
    const telemetry = createHeadlessTelemetry({
      env: { BROWSER_FORGE_TELEMETRY_HOME: home }
    })

    expect(telemetry.enabled).toBe(false)
    await telemetry.track('skill_generation_started', { skill_id: 'browser_forge.demo' })
    await telemetry.close()

    await expect(readFile(join(home, 'telemetry', 'events.jsonl'), 'utf8')).rejects.toThrow(/ENOENT/)
  })

  it('queues generation events with erp and skill id when built and configured', async () => {
    const home = await mkdtemp(join(tmpdir(), 'browser-forge-headless-on-'))
    const telemetry = createHeadlessTelemetry({
      env: { ...SLS_ENV, BROWSER_FORGE_TELEMETRY_HOME: home, JD_ERP: 'analyst01' }
    })

    expect(telemetry.enabled).toBe(true)
    await telemetry.track('skill_generation_started', {
      skill_id: 'browser_forge.demo',
      skill_name: 'demo'
    })
    await telemetry.track('skill_generation_succeeded', {
      skill_id: 'browser_forge.demo',
      skill_name: 'demo'
    })

    const queued = (await readFile(join(home, 'telemetry', 'events.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))

    expect(queued.map(event => event.event_name)).toEqual([
      'skill_generation_started',
      'skill_generation_succeeded'
    ])
    for (const event of queued) {
      expect(event.erp).toBe('analyst01')
      expect(event.skill_id).toBe('browser_forge.demo')
    }
    await telemetry.close()
  })

  it('honors the runtime opt-out even in a telemetry build', async () => {
    const home = await mkdtemp(join(tmpdir(), 'browser-forge-headless-optout-'))
    const telemetry = createHeadlessTelemetry({
      env: { ...SLS_ENV, BROWSER_FORGE_TELEMETRY_DISABLED: '1', BROWSER_FORGE_TELEMETRY_HOME: home }
    })

    expect(telemetry.enabled).toBe(false)
    await telemetry.track('skill_generation_started', { skill_id: 'browser_forge.demo' })
    await telemetry.close()

    await expect(readFile(join(home, 'telemetry', 'events.jsonl'), 'utf8')).rejects.toThrow(/ENOENT/)
  })
})
