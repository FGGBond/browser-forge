import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { createRecorderHttpServer as defaultCreateRecorderHttpServer } from './recorder/http-server.js'
import { registerShellIpcHandlers as defaultRegisterShellIpcHandlers } from './shell-ipc.js'
import { ensureAgentSkillsInstalled as defaultEnsureAgentSkillsInstalled } from './agent-skill-installer.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export async function createWindow({
  app,
  BrowserWindow,
  createRecorderHttpServer = defaultCreateRecorderHttpServer,
  state
}) {
  state.recorderServer = createRecorderHttpServer({
    uiRoot: join(app.getAppPath(), 'ui')
  })
  const url = await state.recorderServer.listen()
  const win = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 760,
    minHeight: 560,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true
    }
  })
  win.loadURL(`${url}/?shell=electron`)
  return win
}

export function startApp({
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  createRecorderHttpServer = defaultCreateRecorderHttpServer,
  registerShellIpcHandlers = defaultRegisterShellIpcHandlers,
  ensureAgentSkillsInstalled = defaultEnsureAgentSkillsInstalled,
  logger = console,
  env = process.env,
  state = { recorderServer: null, isQuitting: false }
} = {}) {
  if (!app || !BrowserWindow || !ipcMain || !dialog) {
    throw new Error('startApp requires Electron app, BrowserWindow, ipcMain, and dialog')
  }

  const readyPromise = app.whenReady().then(async () => {
    const appPath = app.getAppPath()
    const installPromise = Promise.resolve().then(() => ensureAgentSkillsInstalled({
      sourceSkillDir: join(appPath, 'skills', 'browser-forge'),
      runtimeSourceDir: join(appPath, 'src', 'skill-generation'),
      packageVersion: app.getVersion?.() ?? '0.0.0',
      sourceCommit: env.BROWSER_FORGE_SOURCE_COMMIT || 'unknown',
      logFile: join(app.getPath('userData'), 'skill-installation.json')
    })).catch(error => {
      logger.error('[browser-forge] skill installation failed:', error)
    })

    registerShellIpcHandlers({ ipcMain, dialog })
    await createWindow({ app, BrowserWindow, createRecorderHttpServer, state })
    await installPromise
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', (event) => {
    if (state.isQuitting) return
    event.preventDefault()
    state.isQuitting = true
    Promise.resolve(state.recorderServer?.close?.())
      .catch(error => logger.error('[browser-forge] recorder shutdown failed:', error))
      .finally(() => app.quit())
  })

  return readyPromise
}

async function bootstrapElectronApp() {
  const electronModule = await import('electron')
  const electronExports = electronModule['module.exports'] || electronModule.default || electronModule
  const { app, BrowserWindow, ipcMain, dialog } = electronExports
  startApp({ app, BrowserWindow, ipcMain, dialog })
}

if (process.versions.electron && !process.env.VITEST_POOL_ID && !process.env.VITEST && process.env.NODE_ENV !== 'test') {
  bootstrapElectronApp().catch(error => console.error('[browser-forge] app bootstrap failed:', error))
}
