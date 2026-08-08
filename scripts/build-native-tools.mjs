import { chmod, copyFile, mkdir, readFile, writeFile } from 'fs/promises'
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = join(root, 'native', 'macos', 'bin')
const skillVideoToolsDir = join(root, 'skills', 'browser-forge', 'assets', 'video-tools')
const tools = [
  {
    name: 'bf-window-recorder',
    source: join(root, 'native', 'macos', 'window-recorder', 'main.swift'),
    frameworks: ['ScreenCaptureKit', 'AVFoundation', 'CoreMedia', 'CoreVideo']
  },
  {
    name: 'bf-video-frame',
    source: join(root, 'native', 'macos', 'video-frame-cli', 'main.swift'),
    frameworks: ['AVFoundation', 'CoreGraphics', 'ImageIO', 'UniformTypeIdentifiers']
  }
]

if (process.platform !== 'darwin') {
  console.log('Skipping macOS native tool build on non-Darwin platform')
  process.exit(0)
}

await mkdir(outputDir, { recursive: true })
for (const tool of tools) {
  const output = join(outputDir, tool.name)
  const result = spawnSync('swiftc', ['-parse-as-library', tool.source, ...tool.frameworks.flatMap(framework => ['-framework', framework]), '-O', '-o', output], {
    cwd: root,
    encoding: 'utf8'
  })
  if (result.status !== 0) {
    process.stderr.write(result.stdout)
    process.stderr.write(result.stderr)
    throw new Error(`swiftc failed while building ${tool.name}`)
  }
  await chmod(output, 0o755)
  console.log(`Built ${output}`)
}

const frameSource = join(outputDir, 'bf-video-frame')
const frameTargetDir = join(skillVideoToolsDir, 'darwin-arm64')
await mkdir(frameTargetDir, { recursive: true })
const frameTarget = join(frameTargetDir, 'bf-video-frame')
await copyFile(frameSource, frameTarget)
await chmod(frameTarget, 0o755)
const frameHash = createHash('sha256').update(await readFile(frameTarget)).digest('hex')
await writeFile(join(skillVideoToolsDir, 'manifest.json'), `${JSON.stringify({ version: 1, tools: { 'darwin-arm64': { 'bf-video-frame': { sha256: frameHash } } } }, null, 2)}\n`)
console.log(`Prepared skill video extractor ${frameTarget}`)
