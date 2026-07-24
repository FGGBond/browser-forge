import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
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
