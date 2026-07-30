import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('packaging telemetry variants', () => {
  it('exposes separate private and JD telemetry build scripts', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8'))

    expect(pkg.scripts['build:private']).toContain('BROWSER_FORGE_TELEMETRY_BUILD=false')
    expect(pkg.scripts['build:telemetry']).toContain('BROWSER_FORGE_TELEMETRY_BUILD=true')
    expect(pkg.scripts['build:telemetry']).toContain('BROWSER_FORGE_SLS_HOST=cn-hangzhou.log.aliyuncs.com')
    expect(pkg.scripts['build:telemetry']).toContain('BROWSER_FORGE_SLS_PROJECT=browser-forge')
    expect(pkg.scripts['build:telemetry']).toContain('BROWSER_FORGE_SLS_LOGSTORE=main-trace')
    expect(pkg.scripts['make:mac:private']).toContain('build:private')
    expect(pkg.scripts['make:mac:telemetry']).toContain('build:telemetry')
  })
})
