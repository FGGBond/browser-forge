import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: { build: { outDir: 'out/main' } },
  preload: {
    build: {
      outDir: 'out/preload',
      lib: { entry: 'src/preload/index.js' }
    }
  },
  renderer: {
    build: { outDir: 'out/renderer' },
    resolve: { extensions: ['.jsx', '.js'] }
  }
})
