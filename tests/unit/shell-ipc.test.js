import { describe, expect, it, vi } from 'vitest'
import { registerShellIpcHandlers } from '../../src/main/shell-ipc.js'

describe('registerShellIpcHandlers', () => {
  it('registers a native output directory picker for the Electron shell', async () => {
    const handlers = new Map()
    const ipcMain = {
      handle: vi.fn((channel, handler) => handlers.set(channel, handler))
    }
    const dialog = {
      showOpenDialog: vi.fn(async () => ({
        canceled: false,
        filePaths: ['/Users/example/Desktop/browser-forge-output']
      }))
    }

    registerShellIpcHandlers({ ipcMain, dialog })

    expect(ipcMain.handle).toHaveBeenCalledWith('pick-output-dir', expect.any(Function))
    await expect(handlers.get('pick-output-dir')()).resolves.toBe('/Users/example/Desktop/browser-forge-output')
    expect(dialog.showOpenDialog).toHaveBeenCalledWith({ properties: ['openDirectory'] })
  })

  it('returns null when the native picker is canceled', async () => {
    const handlers = new Map()
    const ipcMain = {
      handle: vi.fn((channel, handler) => handlers.set(channel, handler))
    }
    const dialog = {
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] }))
    }

    registerShellIpcHandlers({ ipcMain, dialog })

    await expect(handlers.get('pick-output-dir')()).resolves.toBeNull()
  })
})
