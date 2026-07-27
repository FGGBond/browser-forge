import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'

describe('Electron preload API', () => {
  it('exposes only IPC methods backed by the current shell handlers', () => {
    const source = readFileSync('src/preload/index.js', 'utf8')

    expect(source).toContain('pickOutputDir')
    expect(source).toContain("ipcRenderer.invoke('pick-output-dir')")
    expect(source).not.toContain('findChromePath')
    expect(source).not.toContain('startRecording')
    expect(source).not.toContain('stopRecording')
    expect(source).not.toContain('getTabList')
  })
})
