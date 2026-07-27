import { describe, expect, it, vi } from 'vitest'
import { startApp } from '../../src/main/index.js'

function createElectronStubs() {
  const loadedUrls = []
  const app = {
    getAppPath: () => '/app/path',
    getPath: (name) => name === 'userData' ? '/user/data' : '/tmp',
    getVersion: () => '1.2.3',
    whenReady: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    quit: vi.fn()
  }
  class BrowserWindow {
    constructor(options) {
      this.options = options
    }
    loadURL(url) {
      loadedUrls.push(url)
    }
  }
  return { app, BrowserWindow, loadedUrls, ipcMain: {}, dialog: {} }
}

describe('Electron app startup', () => {
  it('installs agent skills on ready before opening the recorder window', async () => {
    const stubs = createElectronStubs()
    const ensureAgentSkillsInstalled = vi.fn(() => Promise.resolve({ results: [] }))
    const registerShellIpcHandlers = vi.fn()
    const recorderServer = { listen: vi.fn(() => Promise.resolve('http://127.0.0.1:3456')), close: vi.fn() }

    await startApp({
      ...stubs,
      ensureAgentSkillsInstalled,
      registerShellIpcHandlers,
      createRecorderHttpServer: vi.fn(() => recorderServer)
    })

    expect(ensureAgentSkillsInstalled).toHaveBeenCalledWith(expect.objectContaining({
      sourceSkillDir: '/app/path/skills/browser-forge',
      runtimeSourceDir: '/app/path/src/skill-generation',
      packageVersion: '1.2.3',
      logFile: '/user/data/skill-installation.json'
    }))
    expect(registerShellIpcHandlers).toHaveBeenCalledWith({ ipcMain: stubs.ipcMain, dialog: stubs.dialog })
    expect(stubs.loadedUrls).toEqual(['http://127.0.0.1:3456/?shell=electron'])
  })

  it('continues opening the recorder window when skill installation fails', async () => {
    const stubs = createElectronStubs()
    const errors = []
    const recorderServer = { listen: vi.fn(() => Promise.resolve('http://127.0.0.1:4567')), close: vi.fn() }

    await startApp({
      ...stubs,
      ensureAgentSkillsInstalled: vi.fn(() => Promise.reject(new Error('permission denied'))),
      registerShellIpcHandlers: vi.fn(),
      createRecorderHttpServer: vi.fn(() => recorderServer),
      logger: { error: (...args) => errors.push(args) }
    })

    expect(stubs.loadedUrls).toEqual(['http://127.0.0.1:4567/?shell=electron'])
    expect(errors.flat().join(' ')).toContain('skill installation failed')
  })
})
