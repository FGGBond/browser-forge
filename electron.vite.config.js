import { defineConfig } from 'electron-vite'

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
      rollupOptions: { external: ['electron'] }
    }
  },
  renderer: {
    build: { outDir: 'out/renderer' },
    resolve: { extensions: ['.jsx', '.js'] }
  }
})
