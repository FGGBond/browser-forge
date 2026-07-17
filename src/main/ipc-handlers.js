// src/main/ipc-handlers.js
import { ipcMain, shell, dialog } from 'electron'
import { findChromePath, launchChrome } from './chrome-launcher.js'
import { RecordingSession } from './recorder/index.js'
import { join } from 'path'
import { homedir } from 'os'

let chromeProcess = null
let activeSession = null

export function registerIpcHandlers() {
  ipcMain.handle('find-chrome-path', () => findChromePath())

  ipcMain.handle('pick-output-dir', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('start-recording', async (_, { chromePath, outputDir, port = 9222 }) => {
    chromeProcess = launchChrome({ execPath: chromePath, port, userDataDir: join(homedir(), '.browser-forge', 'chrome-profile') })
    await new Promise(r => setTimeout(r, 1500))
    activeSession = new RecordingSession({ port, outputDir })
    await activeSession.start()
    return { ok: true }
  })

  ipcMain.handle('stop-recording', async () => {
    if (!activeSession) return { ok: false, error: 'No active session' }
    const sessionDir = await activeSession.stop()
    activeSession = null
    chromeProcess?.kill()
    chromeProcess = null
    return { ok: true, sessionDir }
  })

  ipcMain.handle('open-folder', (_, folderPath) => {
    shell.openPath(folderPath)
  })

  ipcMain.handle('get-tab-list', () => {
    return activeSession?._cdp.getTargets() ?? []
  })
}
