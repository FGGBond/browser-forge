import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  findChromePath: () => ipcRenderer.invoke('find-chrome-path'),
  pickOutputDir: () => ipcRenderer.invoke('pick-output-dir'),
  startRecording: (opts) => ipcRenderer.invoke('start-recording', opts),
  stopRecording: () => ipcRenderer.invoke('stop-recording'),
  openFolder: (path) => ipcRenderer.invoke('open-folder', path),
  getTabList: () => ipcRenderer.invoke('get-tab-list')
})
