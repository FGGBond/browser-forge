import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { createRecorderHttpServer as defaultCreateRecorderHttpServer } from './recorder/http-server.js'
import { ensureAgentSkillsInstalled as defaultEnsureAgentSkillsInstalled } from './agent-skill-installer.js'
import { createTelemetry as defaultCreateTelemetry } from './telemetry/index.js'
import { hashForTelemetry } from './telemetry/config.js'
import { RecordingLibrary } from './recording-library/index.js'
import { createRequire } from 'module'
import {
  createMainProcessScreenRecordingPermission,
  resetBrowserForgeScreenRecordingPermission as defaultResetScreenRecordingPermission
} from './screen-recording-recovery.js'
import { getNativeToolExecutableName, resolveNativeToolPath } from './recorder/native-tools.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const SCREEN_RECORDING_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'

const RENDERER_BEFORE_CLOSE_SCRIPT = 'window.__browserForgeBeforeClose ? window.__browserForgeBeforeClose() : true'
const DEFAULT_CLOSE_FLUSH_TIMEOUT_MS = 3_000

function isWindowDestroyed(win) {
  return Boolean(win?.isDestroyed?.() || win?.webContents?.isDestroyed?.())
}

function keepWindowVisible(win) {
  if (isWindowDestroyed(win)) return
  win.show?.()
  win.focus?.()
}

async function requestRendererFlush(win, { timeoutMs, allowTimeout, logger }) {
  if (isWindowDestroyed(win)) return true
  const timeoutError = new Error(`Renderer close flush timed out after ${timeoutMs}ms`)
  timeoutError.code = 'RENDERER_FLUSH_TIMEOUT'
  let timer
  try {
    const result = await Promise.race([
      Promise.resolve(win.webContents.executeJavaScript(RENDERER_BEFORE_CLOSE_SCRIPT)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError), timeoutMs) })
    ])
    return result !== false
  } catch (error) {
    logger.error('[browser-forge] renderer close flush failed:', error)
    return allowTimeout && error?.code === 'RENDERER_FLUSH_TIMEOUT'
  } finally {
    clearTimeout(timer)
  }
}

function registerWindowCloseGuard({ win, state, closeFlushTimeoutMs, logger }) {
  let allowClose = false
  let closePending = false
  state.windows.add(win)

  win.on('close', event => {
    if (allowClose || state.forceQuit || isWindowDestroyed(win)) return
    event.preventDefault()
    if (closePending) return
    closePending = true
    void requestRendererFlush(win, {
      timeoutMs: closeFlushTimeoutMs,
      allowTimeout: false,
      logger
    }).then(canClose => {
      if (!canClose) {
        keepWindowVisible(win)
        return
      }
      allowClose = true
      win.close()
    }).finally(() => {
      closePending = false
    })
  })
  win.on('closed', () => state.windows.delete(win))
}

export async function createWindow({
  app,
  BrowserWindow,
  createRecorderHttpServer = defaultCreateRecorderHttpServer,
  state,
  telemetry,
  recordingLibrary,
  chooseExportDirectory,
  revealPath,
  openScreenRecordingSettings,
  screenRecordingPermission,
  resetScreenRecordingPermission,
  revealBrowserForgeApp,
  restartBrowserForge,
  closeFlushTimeoutMs = DEFAULT_CLOSE_FLUSH_TIMEOUT_MS,
  logger = console
}) {
  state.windows = state.windows instanceof Set ? state.windows : new Set()
  state.recorderServer = createRecorderHttpServer({
    uiRoot: join(app.getAppPath(), 'ui'),
    nativeToolPathOptions: {
      packaged: Boolean(app.isPackaged),
      resourcesPath: process.resourcesPath,
      projectRoot: app.getAppPath()
    },
    telemetry,
    recordingLibrary,
    chooseExportDirectory,
    revealPath,
    openScreenRecordingSettings,
    screenRecordingPermission,
    resetScreenRecordingPermission,
    revealBrowserForgeApp,
    restartBrowserForge
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
  registerWindowCloseGuard({ win, state, closeFlushTimeoutMs, logger })
  win.loadURL(`${url}/?shell=electron`)
  await telemetry?.track?.('app_window_created', { width: 1080, height: 760 })
  return win
}

export function startApp({
  app,
  BrowserWindow,
  dialog,
  shell,
  createRecorderHttpServer = defaultCreateRecorderHttpServer,
  ensureAgentSkillsInstalled = defaultEnsureAgentSkillsInstalled,
  createRecordingLibrary = options => new RecordingLibrary(options),
  createTelemetry = defaultCreateTelemetry,
  telemetry,
  screenRecordingPermission,
  resetScreenRecordingPermission = defaultResetScreenRecordingPermission,
  loadScreenPermissionModule = path => require(path),
  platform = process.platform,
  arch = process.arch,
  logger = console,
  env = process.env,
  closeFlushTimeoutMs = DEFAULT_CLOSE_FLUSH_TIMEOUT_MS,
  state = { recorderServer: null, isQuitting: false }
} = {}) {
  if (!app || !BrowserWindow || !dialog || !shell) {
    throw new Error('startApp requires Electron app, BrowserWindow, dialog, and shell')
  }

  const activeTelemetry = telemetry ?? createTelemetry({ app, env, logger })
  state.windows = state.windows instanceof Set ? state.windows : new Set()
  state.isQuitting = Boolean(state.isQuitting)
  state.forceQuit = Boolean(state.forceQuit)
  state.quitInProgress = Boolean(state.quitInProgress)

  const readyPromise = app.whenReady().then(async () => {
    const startupStartedAt = Date.now()
    await activeTelemetry.track('app_launched', { telemetry_build: Boolean(activeTelemetry.enabled) })
    const appPath = app.getAppPath()
    const nativeToolPathOptions = {
      packaged: Boolean(app.isPackaged),
      resourcesPath: process.resourcesPath,
      projectRoot: appPath
    }
    const nativePermissionModule = !screenRecordingPermission && platform === 'darwin'
      ? loadScreenPermissionModule(resolveNativeToolPath({
          ...nativeToolPathOptions,
          platform,
          arch,
          toolName: getNativeToolExecutableName({ tool: 'screenPermission', platform, arch })
        }))
      : undefined
    const activeScreenRecordingPermission = screenRecordingPermission ?? createMainProcessScreenRecordingPermission({
      nativeModule: nativePermissionModule,
      platform,
      arch
    })
    const installPromise = Promise.resolve().then(async () => {
      await activeTelemetry.track('skill_install_started', { package_version: app.getVersion?.() ?? '0.0.0' })
      const report = await ensureAgentSkillsInstalled({
        sourceSkillDir: join(appPath, 'skills', 'browser-forge'),
        runtimeSourceDir: join(appPath, 'src', 'skill-generation'),
        packageVersion: app.getVersion?.() ?? '0.0.0',
        sourceCommit: env.BROWSER_FORGE_SOURCE_COMMIT || 'unknown',
        logFile: join(app.getPath('userData'), 'skill-installation.json')
      })
      const results = Array.isArray(report?.results) ? report.results : []
      await activeTelemetry.track('skill_install_succeeded', {
        target_count: results.length,
        installed_count: results.filter(result => ['installed', 'updated'].includes(result.status)).length,
        skipped_count: results.filter(result => String(result.status).startsWith('skipped')).length,
        failed_count: results.filter(result => result.status === 'failed').length
      })
      return report
    }).catch(async error => {
      await activeTelemetry.track('skill_install_failed', { error_code: error.code ?? 'ENVIRONMENT_ERROR', message_hash: hashForTelemetry(error.message) })
      logger.error('[browser-forge] skill installation failed:', error)
    })

    const recordingLibrary = createRecordingLibrary({ root: join(app.getPath('userData'), 'recordings') })
    await recordingLibrary.initialize()
    state.recordingLibrary = recordingLibrary
    const chooseExportDirectory = async () => {
      const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
      return result.canceled ? null : result.filePaths[0]
    }
    const revealPath = path => shell.showItemInFolder(path)
    const openScreenRecordingSettings = () => shell.openExternal(SCREEN_RECORDING_SETTINGS_URL)
    const browserForgeAppPath = dirname(dirname(dirname(app.getPath('exe'))))
    const revealBrowserForgeApp = () => shell.showItemInFolder(browserForgeAppPath)
    const restartBrowserForge = () => {
      app.relaunch()
      app.quit()
    }

    await createWindow({
      app,
      BrowserWindow,
      createRecorderHttpServer,
      state,
      telemetry: activeTelemetry,
      recordingLibrary,
      chooseExportDirectory,
      revealPath,
      openScreenRecordingSettings,
      screenRecordingPermission: activeScreenRecordingPermission,
      resetScreenRecordingPermission,
      revealBrowserForgeApp,
      restartBrowserForge,
      closeFlushTimeoutMs,
      logger
    })
    await activeTelemetry.track('app_launched', { startup_ms: Date.now() - startupStartedAt, phase: 'ready_complete' })
    await installPromise
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', (event) => {
    if (state.forceQuit) return
    event.preventDefault()
    if (state.quitInProgress) return
    state.quitInProgress = true

    void Promise.all([...state.windows].map(win => requestRendererFlush(win, {
      timeoutMs: closeFlushTimeoutMs,
      allowTimeout: true,
      logger
    }))).then(async results => {
      if (results.some(result => !result)) {
        for (const win of state.windows) keepWindowVisible(win)
        state.quitInProgress = false
        return
      }

      state.isQuitting = true
      try {
        await activeTelemetry.track('app_quit', { recording_active: Boolean(state.recorderServer?.getSummary?.()?.startedAt) })
        await state.recorderServer?.close?.()
        await activeTelemetry.close?.()
      } catch (error) {
        logger.error('[browser-forge] recorder shutdown failed:', error)
      } finally {
        state.forceQuit = true
        app.quit()
      }
    }).catch(error => {
      state.quitInProgress = false
      logger.error('[browser-forge] app quit flush failed:', error)
      for (const win of state.windows) keepWindowVisible(win)
    })
  })

  return readyPromise
}

async function bootstrapElectronApp() {
  const electronModule = await import('electron')
  const electronExports = electronModule['module.exports'] || electronModule.default || electronModule
  const { app, BrowserWindow, dialog, shell } = electronExports
  startApp({ app, BrowserWindow, dialog, shell })
}

if (process.versions.electron && !process.env.VITEST_POOL_ID && !process.env.VITEST && process.env.NODE_ENV !== 'test') {
  bootstrapElectronApp().catch(error => console.error('[browser-forge] app bootstrap failed:', error))
}
