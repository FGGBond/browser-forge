import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

function JavaScriptFiles(root) {
  const files = []
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    if (statSync(path).isDirectory()) files.push(...JavaScriptFiles(path))
    else if (path.endsWith('.js')) files.push(path)
  }
  return files
}

describe('managed recording shell boundary', () => {
  it('keeps the screen-recording settings destination fixed in Electron Main', () => {
    const source = readFileSync('src/main/index.js', 'utf8')

    expect(source).toContain("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
    expect(source).toContain('openScreenRecordingSettings')
    expect(source).not.toMatch(/openScreenRecordingSettings\s*=\s*(?:async\s*)?\(?\s*(?:url|path|destination)/)
  })

  it('contains no legacy output-directory IPC channel', () => {
    const forbidden = ['pick-output-dir', 'pickOutputDir', 'registerShellIpcHandlers']
    const offenders = [...JavaScriptFiles('src/main'), ...JavaScriptFiles('src/preload')]
      .filter(path => forbidden.some(value => readFileSync(path, 'utf8').includes(value)))

    expect(offenders).toEqual([])
  })
})
