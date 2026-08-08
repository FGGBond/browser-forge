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
  it('contains no legacy output-directory IPC channel', () => {
    const forbidden = ['pick-output-dir', 'pickOutputDir', 'registerShellIpcHandlers']
    const offenders = [...JavaScriptFiles('src/main'), ...JavaScriptFiles('src/preload')]
      .filter(path => forbidden.some(value => readFileSync(path, 'utf8').includes(value)))

    expect(offenders).toEqual([])
  })
})
