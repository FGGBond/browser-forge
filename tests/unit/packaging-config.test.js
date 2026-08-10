import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

describe('macOS packaging configuration', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))

  it('points Electron at the built main process entrypoint', () => {
    expect(packageJson.main).toBe('out/main/index.js')
  })

  it('exposes repeatable build and macOS packaging scripts', () => {
    expect(packageJson.scripts.build).toBe('npm run build-native-tools && electron-vite build')
    expect(packageJson.scripts['build-native-tools']).toBe('node scripts/build-native-tools.mjs')
    expect(packageJson.scripts['package:mac']).toBe('npm run build && electron-forge package --platform=darwin --arch=arm64')
    expect(packageJson.scripts['package:mac:private']).toContain('electron-forge package --platform=darwin --arch=arm64')
    expect(packageJson.scripts['package:mac:telemetry']).toContain('electron-forge package --platform=darwin --arch=arm64')
    expect(packageJson.scripts['make:mac']).toBe('npm run build && electron-forge make --platform=darwin --arch=arm64')
    expect(packageJson.scripts['make:mac:private']).toContain('electron-forge make --platform=darwin --arch=arm64')
    expect(packageJson.scripts['make:mac:telemetry']).toContain('electron-forge make --platform=darwin --arch=arm64')
    expect(packageJson.scripts['install:mac:local']).toBe('node scripts/install-mac-local.mjs')
  })

  it('loads a Forge config with macOS DMG and ZIP makers', () => {
    expect(existsSync('forge.config.cjs')).toBe(true)
    const forgeConfig = require('../../forge.config.cjs')
    expect(forgeConfig.outDir).toBe('dist')
    expect(forgeConfig.packagerConfig.name).toBe('Browser Forge')
    expect(forgeConfig.packagerConfig.executableName).toBe('Browser Forge')
    expect(forgeConfig.packagerConfig.appBundleId).toBe('com.browserforge.app')
    expect(forgeConfig.packagerConfig.icon).toBe('native-tools/BrowserForge.icns')
    expect(forgeConfig.packagerConfig.extraResource).toEqual(['native-tools'])
    expect(forgeConfig.hooks?.postPackage).toBeTypeOf('function')
    expect(forgeConfig.makers.map((maker) => maker.name)).toEqual([
      '@electron-forge/maker-dmg',
      '@electron-forge/maker-zip'
    ])
  })

  it('keeps the main and CommonJS preload Electron Vite builds', () => {
    const mainSource = readFileSync('src/main/index.js', 'utf8')
    expect(mainSource).toContain("../preload/index.cjs")

    const viteConfig = readFileSync('electron.vite.config.js', 'utf8')
    expect(viteConfig).toContain('main: {')
    expect(viteConfig).toContain('preload: {')
    expect(viteConfig).toContain("formats: ['cjs']")
    expect(viteConfig).toContain("entryFileNames: 'index.cjs'")
  })

  it('serves the production UI from ui/ through the recorder HTTP server', () => {
    expect(existsSync('ui/index.html')).toBe(true)

    const mainSource = readFileSync('src/main/index.js', 'utf8')
    const httpServerSource = readFileSync('src/main/recorder/http-server.js', 'utf8')
    expect(mainSource).toContain("uiRoot: join(app.getAppPath(), 'ui')")
    expect(mainSource).toContain("win.loadURL(`${url}/?shell=electron`)")
    expect(httpServerSource).toContain('app.use(express.static(uiRoot))')
  })

  it('has no inactive React renderer source or Electron Vite renderer build', () => {
    expect(existsSync('src/renderer')).toBe(false)

    const viteConfig = readFileSync('electron.vite.config.js', 'utf8')
    expect(viteConfig).not.toContain("@vitejs/plugin-react")
    expect(viteConfig).not.toContain('react()')
    expect(viteConfig).not.toMatch(/\brenderer\s*:/)
  })

  it('has no React renderer runtime or plugin dependencies', () => {
    expect(packageJson.dependencies).not.toHaveProperty('react')
    expect(packageJson.dependencies).not.toHaveProperty('react-dom')
    expect(packageJson.devDependencies).not.toHaveProperty('@vitejs/plugin-react')

    const packageLock = readFileSync('package-lock.json', 'utf8')
    expect(packageLock).not.toContain('node_modules/react"')
    expect(packageLock).not.toContain('node_modules/react-dom"')
    expect(packageLock).not.toContain('node_modules/react-refresh"')
    expect(packageLock).not.toContain('node_modules/@vitejs/plugin-react"')
  })

  it('keeps inert concepts and stale renderer output out of packaged apps', () => {
    const forgeConfig = require('../../forge.config.cjs')
    const ignored = (path) => forgeConfig.packagerConfig.ignore.some((pattern) => pattern.test(path))

    expect(ignored('/design/icon-concepts/example.png')).toBe(true)
    expect(ignored('/assets/icon-concepts/example.png')).toBe(true)
    expect(ignored('/docs/superpowers/plans/integration-plan.md')).toBe(true)
    expect(ignored('/out/renderer/index.html')).toBe(true)
    expect(ignored('/out/renderer/assets/stale.js')).toBe(true)
    expect(ignored('/out/main/index.js')).toBe(false)
    expect(ignored('/ui/index.html')).toBe(false)
    expect(ignored('/src/renderer/index.html')).toBe(false)
  })
})
