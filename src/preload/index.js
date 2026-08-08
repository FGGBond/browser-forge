import { contextBridge } from 'electron'

// The production UI uses the local HTTP API. Keep a capability-free bridge so
// Electron's preload bundle remains explicit without exposing filesystem IPC.
contextBridge.exposeInMainWorld('electronAPI', Object.freeze({}))
