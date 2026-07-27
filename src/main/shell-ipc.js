export function registerShellIpcHandlers({ ipcMain, dialog }) {
  ipcMain.handle('pick-output-dir', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
}
