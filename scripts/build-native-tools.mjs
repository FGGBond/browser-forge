import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { dirname, join, resolve } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { mergeVideoToolsManifest } from './video-tools-manifest.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const macOSTarget = 'arm64-apple-macos14.2'
// Electron Packager copies extraResource values by basename only. Build the
// standalone frame tool and the complete Recorder Helper App into this root.
const outputDir = process.env.BROWSER_FORGE_NATIVE_TOOLS_OUTPUT_DIR
  ? resolve(process.env.BROWSER_FORGE_NATIVE_TOOLS_OUTPUT_DIR)
  : join(root, 'native-tools')
const recorderAppName = 'Browser Forge Recorder.app'
const recorderExecutableName = 'Browser Forge Recorder'
const recorderAppDir = join(outputDir, recorderAppName)
const recorderExecutable = join(recorderAppDir, 'Contents', 'MacOS', recorderExecutableName)
const recorderResources = join(recorderAppDir, 'Contents', 'Resources')
const recorderIcon = join(recorderResources, 'BrowserForgeRecorder.icns')
const appIcon = join(outputDir, 'BrowserForge.icns')
const screenPermissionAddon = join(outputDir, 'bf-screen-permission.node')
const skillVideoToolsDir = process.env.BROWSER_FORGE_SKILL_VIDEO_TOOLS_DIR
  ? resolve(process.env.BROWSER_FORGE_SKILL_VIDEO_TOOLS_DIR)
  : join(root, 'skills', 'browser-forge', 'assets', 'video-tools')
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

if (process.platform !== 'darwin') {
  console.log('Skipping macOS native tool build on non-Darwin platform')
  process.exit(0)
}

await mkdir(outputDir, { recursive: true })
await rm(join(outputDir, 'bf-window-recorder'), { force: true })
await rm(recorderAppDir, { recursive: true, force: true })
await mkdir(dirname(recorderExecutable), { recursive: true })
await mkdir(recorderResources, { recursive: true })

compileSwift({
  name: recorderExecutableName,
  source: join(root, 'native', 'macos', 'window-recorder', 'main.swift'),
  frameworks: ['AppKit', 'ScreenCaptureKit', 'AVFoundation', 'CoreGraphics', 'CoreMedia', 'CoreVideo'],
  output: recorderExecutable
})
await writeFile(join(recorderAppDir, 'Contents', 'Info.plist'), recorderInfoPlist(packageJson.version))
await rm(appIcon, { force: true })
await createIcns({
  source: join(root, 'design', 'icon-concepts', 'drawn', 'browser-forge-drawn-01-capture-lens.png'),
  output: appIcon
})
await copyFile(appIcon, recorderIcon)
signBundle(recorderAppDir)
console.log(`Built ${recorderAppDir}`)

compileNodeAddon({
  name: 'bf-screen-permission.node',
  source: join(root, 'native', 'macos', 'screen-permission-addon', 'main.c'),
  output: screenPermissionAddon
})
console.log(`Built ${screenPermissionAddon}`)

const frameSource = join(outputDir, 'bf-video-frame')
compileSwift({
  name: 'bf-video-frame',
  source: join(root, 'native', 'macos', 'video-frame-cli', 'main.swift'),
  frameworks: ['AVFoundation', 'CoreGraphics', 'ImageIO', 'UniformTypeIdentifiers'],
  output: frameSource
})
console.log(`Built ${frameSource}`)

const frameTargetDir = join(skillVideoToolsDir, 'darwin-arm64')
await mkdir(frameTargetDir, { recursive: true })
const frameTarget = join(frameTargetDir, 'bf-video-frame')
await copyFile(frameSource, frameTarget)
await chmod(frameTarget, 0o755)
const frameHash = createHash('sha256').update(await readFile(frameTarget)).digest('hex')
const videoToolsManifestPath = join(skillVideoToolsDir, 'manifest.json')
let existingVideoToolsManifest = null
try {
  existingVideoToolsManifest = JSON.parse(await readFile(videoToolsManifestPath, 'utf8'))
} catch (error) {
  if (error.code !== 'ENOENT') throw new Error(`Unable to read existing video-tools manifest: ${error.message}`)
}
const videoToolsManifest = mergeVideoToolsManifest(existingVideoToolsManifest, 'darwin-arm64', {
  'bf-video-frame': { sha256: frameHash }
})
await writeFile(videoToolsManifestPath, `${JSON.stringify(videoToolsManifest, null, 2)}\n`)
console.log(`Prepared skill video extractor ${frameTarget}`)

function compileSwift({ name, source, frameworks, output }) {
  const result = spawnSync('swiftc', ['-target', macOSTarget, '-parse-as-library', source, ...frameworks.flatMap(framework => ['-framework', framework]), '-O', '-o', output], {
    cwd: root,
    encoding: 'utf8'
  })
  if (result.status !== 0) {
    process.stderr.write(result.stdout)
    process.stderr.write(result.stderr)
    throw new Error(`swiftc failed while building ${name}`)
  }
  const chmodResult = spawnSync('chmod', ['755', output], { encoding: 'utf8' })
  if (chmodResult.status !== 0) throw new Error(`Unable to mark ${name} executable: ${chmodResult.stderr}`)
}

function compileNodeAddon({ name, source, output }) {
  const nodeIncludeDir = process.env.NODE_INCLUDE_DIR || join(dirname(dirname(process.execPath)), 'include', 'node')
  const result = spawnSync('clang', [
    '-target', macOSTarget,
    '-bundle',
    '-undefined', 'dynamic_lookup',
    '-I', nodeIncludeDir,
    source,
    '-framework', 'CoreGraphics',
    '-O2',
    '-o', output
  ], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) {
    process.stderr.write(result.stdout)
    process.stderr.write(result.stderr)
    throw new Error(`clang failed while building ${name}`)
  }
  const chmodResult = spawnSync('chmod', ['755', output], { encoding: 'utf8' })
  if (chmodResult.status !== 0) throw new Error(`Unable to mark ${name} executable: ${chmodResult.stderr}`)
}

async function createIcns({ source, output }) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'browser-forge-recorder-icon-'))
  const iconset = join(tempRoot, 'BrowserForgeRecorder.iconset')
  await mkdir(iconset)
  try {
    const variants = [
      ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
      ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
      ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
      ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
      ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024]
    ]
    for (const [name, size] of variants) {
      const result = spawnSync('sips', ['-z', String(size), String(size), source, '--out', join(iconset, name)], { encoding: 'utf8' })
      if (result.status !== 0) throw new Error(`sips failed while creating ${name}: ${result.stderr}`)
    }
    const result = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', output], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`iconutil failed: ${result.stderr}`)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

function signBundle(path) {
  const result = spawnSync('codesign', ['--force', '--deep', '--sign', '-', path], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`codesign failed for ${path}: ${result.stderr}`)
}

function recorderInfoPlist(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Browser Forge Recorder</string>
  <key>CFBundleExecutable</key><string>${recorderExecutableName}</string>
  <key>CFBundleIconFile</key><string>BrowserForgeRecorder</string>
  <key>CFBundleIdentifier</key><string>com.browserforge.app.recorder</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Browser Forge Recorder</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>14.2</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`
}
