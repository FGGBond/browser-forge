import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

function telemetryBuildDefines() {
  return {
    '__BROWSER_FORGE_TELEMETRY_BUILD__': JSON.stringify(['1', 'true', 'yes', 'on'].includes(String(process.env.BROWSER_FORGE_TELEMETRY_BUILD ?? '').trim().toLowerCase())),
    '__BROWSER_FORGE_SLS_HOST__': JSON.stringify(process.env.BROWSER_FORGE_SLS_HOST || ''),
    '__BROWSER_FORGE_SLS_PROJECT__': JSON.stringify(process.env.BROWSER_FORGE_SLS_PROJECT || ''),
    '__BROWSER_FORGE_SLS_LOGSTORE__': JSON.stringify(process.env.BROWSER_FORGE_SLS_LOGSTORE || ''),
    '__BROWSER_FORGE_SLS_TOPIC__': JSON.stringify(process.env.BROWSER_FORGE_SLS_TOPIC || 'browser-forge'),
    '__BROWSER_FORGE_SLS_SOURCE__': JSON.stringify(process.env.BROWSER_FORGE_SLS_SOURCE || 'browser-forge-electron')
  }
}

export default defineConfig({
  main: {
    define: telemetryBuildDefines(),
    build: {
      outDir: 'out/main',
      target: 'node22',
      lib: { entry: 'src/main/index.js' },
      rollupOptions: { external: ['electron'] }
    }
  },
  preload: {
    build: {
      outDir: 'out/preload',
      target: 'node22',
      lib: { entry: 'src/preload/index.js' },
      rollupOptions: {
        external: ['electron'],
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs'
        }
      },
      formats: ['cjs']
    }
  },
  renderer: {
    plugins: [react()],
    build: { outDir: 'out/renderer' },
    resolve: { extensions: ['.jsx', '.js'] }
  }
})
