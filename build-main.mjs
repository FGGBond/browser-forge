// build-main.mjs — builds the Electron main process with esbuild
// electron is explicitly external so it's not resolved from node_modules
import { build } from 'esbuild'
import { builtinModules } from 'module'
import { mkdirSync } from 'fs'

mkdirSync('out/main', { recursive: true })

await build({
  entryPoints: ['src/main/index.js'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: 'out/main/index.js',
  external: [
    'electron',
    ...builtinModules,
    ...builtinModules.map(m => `node:${m}`)
  ],
  format: 'cjs',
  sourcemap: false,
})

console.log('main built')

await build({
  entryPoints: ['src/preload/index.js'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: 'out/preload/index.js',
  external: [
    'electron',
    ...builtinModules,
    ...builtinModules.map(m => `node:${m}`)
  ],
  format: 'cjs',
  sourcemap: false,
})

console.log('preload built')
