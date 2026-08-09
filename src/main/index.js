import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { createRecorderHttpServer as defaultCreateRecorderHttpServer } from './recorder/http-server.js'
import { ensureAgentSkillsInstalled as defaultEnsureAgentSkillsInstalled } from './agent-skill-installer.js'
import { createTelemetry as defaultCreateTelemetry } from './telemetry/index.js'
import { hashForTelemetry } from './telemetry/config.js'
import { RecordingLibrary } from './recording-library/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCREEN_RECORDING_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'

export async function createWindow({
  app,
  BrowserWindow,
  createRecorderHttpServer = defaultCreateRecorderHttpServer,
  state,
  telemetry,
  recordingLibrary,
  chooseExportDirectory,
  revealPath,
  openScreenRecordingSettings
}) {
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
    openScreenRecordingSettings
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
  logger = console,
  env = process.env,
  state = { recorderServer: null, isQuitting: false }
} = {}) {
  if (!app || !BrowserWindow || !dialog || !shell) {
    throw new Error('startApp requires Electron app, BrowserWindow, dialog, and shell')
  }

  const activeTelemetry = telemetry ?? createTelemetry({ app, env, logger })

  const readyPromise = app.whenReady().then(async () => {
    const startupStartedAt = Date.now()
    await activeTelemetry.track('app_launched', { telemetry_build: Boolean(activeTelemetry.enabled) })
    const appPath = app.getAppPath()
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

    await createWindow({
      app,
      BrowserWindow,
      createRecorderHttpServer,
      state,
      telemetry: activeTelemetry,
      recordingLibrary,
      chooseExportDirectory,
      revealPath,
      openScreenRecordingSettings
    })
    await activeTelemetry.track('app_launched', { startup_ms: Date.now() - startupStartedAt, phase: 'ready_complete' })
    await installPromise
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', (event) => {
    if (state.isQuitting) return
    event.preventDefault()
    state.isQuitting = true
    Promise.resolve()
      .then(() => activeTelemetry.track('app_quit', { recording_active: Boolean(state.recorderServer?.getSummary?.()?.startedAt) }))
      .then(() => state.recorderServer?.close?.())
      .then(() => activeTelemetry.close?.())
      .catch(error => logger.error('[browser-forge] recorder shutdown failed:', error))
      .finally(() => app.quit())
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
