import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'

describe('Electron preload API', () => {
  it('does not expose a recording output-directory picker', () => {
    const source = readFileSync('src/preload/index.js', 'utf8')

    expect(source).not.toContain('pickOutputDir')
    expect(source).not.toContain('pick-output-dir')
    expect(source).not.toContain('ipcRenderer')
    expect(source).toContain("contextBridge.exposeInMainWorld('electronAPI', Object.freeze({}))")
  })
})
