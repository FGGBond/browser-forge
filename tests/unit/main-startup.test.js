import { describe, expect, it, vi } from 'vitest'
import { startApp } from '../../src/main/index.js'

function createElectronStubs() {
  const loadedUrls = []
  const app = {
    isPackaged: false,
    getAppPath: () => '/app/path',
    getPath: (name) => name === 'userData' ? '/user/data' : name === 'exe' ? '/Applications/Browser Forge.app/Contents/MacOS/Browser Forge' : '/tmp',
    getVersion: () => '1.2.3',
    whenReady: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    quit: vi.fn(),
    relaunch: vi.fn()
  }
  class BrowserWindow {
    constructor(options) {
      this.options = options
    }
    loadURL(url) {
      loadedUrls.push(url)
    }
  }
  const recordingLibrary = { initialize: vi.fn(async () => {}) }
  return {
    app,
    BrowserWindow,
    loadedUrls,
    dialog: { showOpenDialog: vi.fn() },
    shell: { showItemInFolder: vi.fn(), openExternal: vi.fn(async () => {}) },
    screenRecordingPermission: { check: vi.fn(), request: vi.fn() },
    createRecordingLibrary: vi.fn(() => recordingLibrary)
  }
}

describe('Electron app startup', () => {
  it('installs agent skills on ready before opening the recorder window', async () => {
    const stubs = createElectronStubs()
    const ensureAgentSkillsInstalled = vi.fn(() => Promise.resolve({ results: [] }))
    const recorderServer = { listen: vi.fn(() => Promise.resolve('http://127.0.0.1:3456')), close: vi.fn() }
    const createRecorderHttpServer = vi.fn(() => recorderServer)

    await startApp({
      ...stubs,
      ensureAgentSkillsInstalled,
      createRecorderHttpServer
    })

    expect(ensureAgentSkillsInstalled).toHaveBeenCalledWith(expect.objectContaining({
      sourceSkillDir: '/app/path/skills/browser-forge',
      runtimeSourceDir: '/app/path/src/skill-generation',
      packageVersion: '1.2.3',
      logFile: '/user/data/skill-installation.json'
    }))
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

  it('initializes the managed library under userData before creating the server', async () => {
    const stubs = createElectronStubs()
    const calls = []
    const recordingLibrary = { initialize: vi.fn(async () => { calls.push('library:initialize') }) }
    const createRecordingLibrary = vi.fn(options => {
      calls.push('library:create')
      return recordingLibrary
    })
    const recorderServer = { listen: vi.fn(async () => 'http://127.0.0.1:6789'), close: vi.fn() }
    const resetScreenRecordingPermission = vi.fn(async () => ({ ok: true }))
    const screenRecordingPermission = { check: vi.fn(), request: vi.fn() }
    const createRecorderHttpServer = vi.fn(options => {
      calls.push('server:create')
      return recorderServer
    })

    await startApp({
      ...stubs,
      createRecordingLibrary,
      createRecorderHttpServer,
      resetScreenRecordingPermission,
      screenRecordingPermission,
      ensureAgentSkillsInstalled: vi.fn(async () => ({ results: [] }))
    })

    expect(createRecordingLibrary).toHaveBeenCalledWith({ root: '/user/data/recordings' })
    expect(calls.indexOf('library:initialize')).toBeLessThan(calls.indexOf('server:create'))
    const options = createRecorderHttpServer.mock.calls[0][0]
    expect(options).toEqual(expect.objectContaining({
      recordingLibrary,
      chooseExportDirectory: expect.any(Function),
      revealPath: expect.any(Function),
      openScreenRecordingSettings: expect.any(Function),
      revealBrowserForgeApp: expect.any(Function),
      screenRecordingPermission,
      resetScreenRecordingPermission: expect.any(Function),
      restartBrowserForge: expect.any(Function)
    }))
    stubs.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/Users/example/Desktop'] })
    await expect(options.chooseExportDirectory()).resolves.toBe('/Users/example/Desktop')
    await options.revealPath('/Users/example/Desktop/export')
    expect(stubs.shell.showItemInFolder).toHaveBeenCalledWith('/Users/example/Desktop/export')
    await options.openScreenRecordingSettings('https://attacker.example')
    expect(stubs.shell.openExternal).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
    await options.revealBrowserForgeApp('/tmp/attacker')
    expect(stubs.shell.showItemInFolder).toHaveBeenCalledWith('/Applications/Browser Forge.app')
    // Main adapters are fixed-purpose; HTTP callers cannot supply service, bundle ID, or restart options.
    expect(options.screenRecordingPermission).toBe(screenRecordingPermission)
    expect(options.resetScreenRecordingPermission).toBe(resetScreenRecordingPermission)
    await options.resetScreenRecordingPermission({ service: 'All', bundleId: 'com.attacker.app' })
    expect(resetScreenRecordingPermission).toHaveBeenCalledWith({ service: 'All', bundleId: 'com.attacker.app' })
    options.restartBrowserForge({ executable: '/tmp/attacker' })
    expect(stubs.app.relaunch).toHaveBeenCalledWith()
    expect(stubs.app.quit).toHaveBeenCalledWith()
  })

  it('does not load the macOS permission addon on an unsupported platform', async () => {
    const stubs = createElectronStubs()
    const { screenRecordingPermission: _screenRecordingPermission, ...withoutPermission } = stubs
    const recorderServer = { listen: vi.fn(async () => 'http://127.0.0.1:7890'), close: vi.fn() }
    const createRecorderHttpServer = vi.fn(() => recorderServer)
    const loadScreenPermissionModule = vi.fn()

    await startApp({
      ...withoutPermission,
      platform: 'win32',
      arch: 'x64',
      loadScreenPermissionModule,
      createRecorderHttpServer,
      ensureAgentSkillsInstalled: vi.fn(async () => ({ results: [] }))
    })

    expect(loadScreenPermissionModule).not.toHaveBeenCalled()
    const permission = createRecorderHttpServer.mock.calls[0][0].screenRecordingPermission
    await expect(permission.check()).resolves.toEqual({
      supported: false,
      status: 'unsupported',
      granted: false,
      restartRequired: false,
      platform: 'win32-x64'
    })
  })


})
