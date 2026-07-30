import { readFile } from 'fs/promises'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const TEMPLATE_ROOT = 'skills/browser-forge/assets/skill-template/scripts/cli/src/browser_forge_generated'

describe('generated skill telemetry template', () => {
  it('ships a usage telemetry module and instruments every CLI command', async () => {
    const telemetry = await readFile(join(TEMPLATE_ROOT, 'telemetry.py'), 'utf8')
    const cli = await readFile(join(TEMPLATE_ROOT, 'cli.py'), 'utf8')

    expect(telemetry).toContain('class UsageTelemetry')
    expect(telemetry).toMatch(/BROWSER_FORGE_" "SLS_HOST/)
    expect(telemetry).toMatch(/generated_" "skill_used/)
    expect(cli).toContain('UsageTelemetry')
    expect(cli).toContain('telemetry.track_command')
  })
})
