import electronModule from 'electron'
const { app, BrowserWindow } = electronModule['module.exports'] || electronModule.default || electronModule
import { join } from 'path'
import { homedir } from 'os'
import { createRequire } from 'module'
import { registerIpcHandlers } from './ipc-handlers.js'
import { installSkill } from './skill-installer.js'

const require = createRequire(import.meta.url)
const pkg = require('../../package.json')

function createWindow() {
  const win = new BrowserWindow({
    width: 480,
    height: 600,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true
    }
  })
  if (process.env.NODE_ENV === 'development') {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  const srcDir = join(__dirname, '../../skill')
  const dstDir = join(homedir(), '.claude', 'plugins', 'user', 'browser-forge')
  const result = await installSkill({ srcDir, dstDir, version: pkg.version })
  if (result.action !== 'skipped') {
    console.log(`[browser-forge] skill ${result.action}: v${result.version} → ${dstDir}`)
  }

  registerIpcHandlers()
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
