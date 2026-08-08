import { describe, expect, it, vi } from 'vitest'
import { startApp } from '../../src/main/index.js'

function createElectronStubs() {
  const loadedUrls = []
  const app = {
    isPackaged: false,
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
    const createRecorderHttpServer = vi.fn(() => recorderServer)

    await startApp({
      ...stubs,
      ensureAgentSkillsInstalled,
      registerShellIpcHandlers,
      createRecorderHttpServer
    })

    expect(ensureAgentSkillsInstalled).toHaveBeenCalledWith(expect.objectContaining({
      sourceSkillDir: '/app/path/skills/browser-forge',
      runtimeSourceDir: '/app/path/src/skill-generation',
      packageVersion: '1.2.3',
      logFile: '/user/data/skill-installation.json'
    }))
    expect(registerShellIpcHandlers).toHaveBeenCalledWith({ ipcMain: stubs.ipcMain, dialog: stubs.dialog })
    expect(createRecorderHttpServer).toHaveBeenCalledWith(expect.objectContaining({
      nativeToolPathOptions: expect.objectContaining({ packaged: false, projectRoot: '/app/path' })
    }))
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

  it('tracks app startup and skill installation lifecycle when telemetry is injected', async () => {
    const stubs = createElectronStubs()
    const events = []
    const telemetry = {
      track: vi.fn((eventName, properties = {}) => {
        events.push([eventName, properties])
        return Promise.resolve()
      }),
      close: vi.fn(() => Promise.resolve())
    }
    const recorderServer = { listen: vi.fn(() => Promise.resolve('http://127.0.0.1:5678')), close: vi.fn() }

    await startApp({
      ...stubs,
      telemetry,
      ensureAgentSkillsInstalled: vi.fn(() => Promise.resolve({ results: [{ agent: 'codex', status: 'installed' }] })),
      registerShellIpcHandlers: vi.fn(),
      createRecorderHttpServer: vi.fn(() => recorderServer)
    })

    expect(events.map(([name]) => name)).toEqual(expect.arrayContaining([
      'app_launched',
      'skill_install_started',
      'skill_install_succeeded',
      'app_window_created'
    ]))
    expect(events.find(([name]) => name === 'skill_install_succeeded')?.[1]).toMatchObject({ installed_count: 1 })
  })

})
