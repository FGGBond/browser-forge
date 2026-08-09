import { afterEach, describe, expect, it, vi } from 'vitest'
import { access, mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { installMacOSRecorderHelper, packageRecorderHelpers } from '../../scripts/package-native-helpers.cjs'

let root

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = null
})

describe('macOS Recorder Helper packaging', () => {
  it('moves the Helper out of Resources, preserves frame extraction, and signs the complete app tree', async () => {
    root = await mkdtemp(join(tmpdir(), 'bf-helper-package-'))
    const outputPath = join(root, 'Browser Forge-darwin-arm64')
    const appPath = join(outputPath, 'Browser Forge.app')
    const resourceTools = join(appPath, 'Contents', 'Resources', 'native-tools')
    const stagedHelper = join(resourceTools, 'Browser Forge Recorder.app')
    const stagedExecutable = join(stagedHelper, 'Contents', 'MacOS', 'Browser Forge Recorder')
    await mkdir(join(stagedHelper, 'Contents', 'MacOS'), { recursive: true })
    await writeFile(stagedExecutable, 'helper')
    await writeFile(join(resourceTools, 'bf-video-frame'), 'frame')
    const runCommand = vi.fn(async () => {})

    const result = await installMacOSRecorderHelper({ outputPath, runCommand, signIdentity: '-' })
    const installedHelper = join(appPath, 'Contents', 'Helpers', 'Browser Forge Recorder.app')

    expect(result).toEqual({ appPath, helperAppPath: installedHelper })
    await expect(access(join(installedHelper, 'Contents', 'MacOS', 'Browser Forge Recorder'))).resolves.toBeUndefined()
    await expect(access(stagedHelper)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(resourceTools, 'bf-video-frame'))).resolves.toBeUndefined()
    expect(runCommand.mock.calls).toEqual([
      ['codesign', ['--force', '--deep', '--sign', '-', installedHelper]],
      ['codesign', ['--force', '--deep', '--sign', '-', appPath]],
      ['codesign', ['--verify', '--deep', '--strict', appPath]]
    ])
  })

  it('processes only darwin package outputs through the Forge postPackage hook', async () => {
    const installHelper = vi.fn(async () => {})
    await packageRecorderHelpers({ platform: 'win32', outputPaths: ['/tmp/windows'] }, { installHelper })
    expect(installHelper).not.toHaveBeenCalled()

    await packageRecorderHelpers({ platform: 'darwin', outputPaths: ['/tmp/a', '/tmp/b'] }, { installHelper })
    expect(installHelper.mock.calls).toEqual([
      [{ outputPath: '/tmp/a' }],
      [{ outputPath: '/tmp/b' }]
    ])
  })
})
