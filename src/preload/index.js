import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  pickOutputDir: () => ipcRenderer.invoke('pick-output-dir')
})
