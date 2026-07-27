import electronModule from 'electron'
const { app, BrowserWindow, ipcMain, dialog } = electronModule['module.exports'] || electronModule.default || electronModule
import { join } from 'path'
import { createRecorderHttpServer } from './recorder/http-server.js'
import { registerShellIpcHandlers } from './shell-ipc.js'

let recorderServer = null
let isQuitting = false

async function createWindow() {
  recorderServer = createRecorderHttpServer({
    uiRoot: join(app.getAppPath(), 'ui')
  })
  const url = await recorderServer.listen()
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
}

app.whenReady().then(() => {
  registerShellIpcHandlers({ ipcMain, dialog })
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (isQuitting) return
  event.preventDefault()
  isQuitting = true
  Promise.resolve(recorderServer?.close?.())
    .catch(error => console.error('[browser-forge] recorder shutdown failed:', error))
    .finally(() => app.quit())
})
