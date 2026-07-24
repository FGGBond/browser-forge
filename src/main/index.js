import electronModule from 'electron'
const { app, BrowserWindow } = electronModule['module.exports'] || electronModule.default || electronModule
import { join } from 'path'
import { registerIpcHandlers } from './ipc-handlers.js'

function createWindow() {
  const win = new BrowserWindow({
    width: 480,
    height: 600,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true
    }
  })
  if (process.env.NODE_ENV === 'development') {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerIpcHandlers()
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
