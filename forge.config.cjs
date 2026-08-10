const { existsSync, readdirSync } = require('fs')
const { join } = require('path')
const { homedir } = require('os')
const { devDependencies } = require('./package.json')
const { packageRecorderHelpers } = require('./scripts/package-native-helpers.cjs')

function findElectronZipDir() {
  if (process.env.ELECTRON_ZIP_DIR) return process.env.ELECTRON_ZIP_DIR

  const electronVersion = devDependencies.electron?.replace(/^\D+/, '')
  if (!electronVersion) return undefined

  const filename = `electron-v${electronVersion}-${process.platform}-${process.arch}.zip`
  const cacheRoots = [
    join(homedir(), 'Library/Caches/electron'),
    join(homedir(), '.cache/electron')
  ]

  for (const cacheRoot of cacheRoots) {
    if (!existsSync(cacheRoot)) continue

    for (const entry of readdirSync(cacheRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidateDir = join(cacheRoot, entry.name)
      if (existsSync(join(candidateDir, filename))) return candidateDir
    }
  }

  return undefined
}

const electronZipDir = findElectronZipDir()

module.exports = {
  outDir: 'dist',
  hooks: {
    postPackage: async (_forgeConfig, packageResult) => packageRecorderHelpers(packageResult)
  },
  packagerConfig: {
    name: 'Browser Forge',
    executableName: 'Browser Forge',
    appBundleId: 'com.browserforge.app',
    icon: 'native-tools/BrowserForge.icns',
    asar: true,
    // @electron/packager accepts resource paths (not { from, to } mappings).
    // The build script emits this folder with the required final basename.
    extraResource: ['native-tools'],
    ...(electronZipDir ? { electronZipDir } : {}),
    ignore: [
      /^\/\.git($|\/)/,
      // .claude holds Claude Code state; leftover git worktrees live under
      // .claude/worktrees and are full checkouts (their own node_modules), so
      // packaging them bloats the app by hundreds of MB of pure cruft.
      /^\/\.claude($|\/)/,
      // dist is the build output itself — never re-package a prior build.
      /^\/dist($|\/)/,
      /^\/\.superpowers($|\/)/,
      /^\/docs\/superpowers($|\/)/,
      /^\/tests($|\/)/,
      /^\/design($|\/)/,
      /^\/assets\/icon-concepts($|\/)/,
      /^\/recorder\.mjs$/,
      /^\/build-main\.mjs$/
    ]
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {
        name: 'Browser Forge',
        title: 'Browser Forge'
      }
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin']
    }
  ]
}
