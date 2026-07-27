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
    expect(packageJson.scripts.build).toBe('electron-vite build')
    expect(packageJson.scripts['package:mac']).toBe('npm run build && electron-forge package --platform=darwin')
    expect(packageJson.scripts['make:mac']).toBe('npm run build && electron-forge make --platform=darwin')
  })

  it('loads a Forge config with macOS DMG and ZIP makers', () => {
    expect(existsSync('forge.config.cjs')).toBe(true)
    const forgeConfig = require('../../forge.config.cjs')
    expect(forgeConfig.outDir).toBe('dist')
    expect(forgeConfig.packagerConfig.name).toBe('Browser Forge')
    expect(forgeConfig.packagerConfig.executableName).toBe('Browser Forge')
    expect(forgeConfig.packagerConfig.appBundleId).toBe('com.browserforge.app')
    expect(forgeConfig.makers.map((maker) => maker.name)).toEqual([
      '@electron-forge/maker-dmg',
      '@electron-forge/maker-zip'
    ])
  })

  it('uses the CommonJS preload bundle emitted for Electron preload', () => {
    const mainSource = readFileSync('src/main/index.js', 'utf8')
    expect(mainSource).toContain("../preload/index.cjs")

    const viteConfig = readFileSync('electron.vite.config.js', 'utf8')
    expect(viteConfig).toContain("formats: ['cjs']")
    expect(viteConfig).toContain("entryFileNames: 'index.cjs'")
  })

  it('uses the React plugin for production renderer JSX builds', () => {
    const viteConfig = readFileSync('electron.vite.config.js', 'utf8')
    expect(viteConfig).toContain("import react from '@vitejs/plugin-react'")
    expect(viteConfig).toContain('plugins: [react()]')
  })
})

  it('keeps inert concepts and legacy renderer files out of packaged apps', () => {
    const forgeConfig = require('../../forge.config.cjs')
    const ignored = (path) => forgeConfig.packagerConfig.ignore.some((pattern) => pattern.test(path))

    expect(ignored('/design/icon-concepts/example.png')).toBe(true)
    expect(ignored('/assets/icon-concepts/example.png')).toBe(true)
    expect(ignored('/src/renderer/index.html')).toBe(true)
    expect(ignored('/docs/superpowers/plans/integration-plan.md')).toBe(true)
  })
