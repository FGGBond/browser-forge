import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

describe.runIf(process.platform === 'darwin')('macOS native video tools', () => {
  let isolatedBuildRoot
  let nativeToolsDir
  let helperApp

  beforeAll(() => {
    isolatedBuildRoot = mkdtempSync(join(tmpdir(), 'browser-forge-native-tools-test-'))
    nativeToolsDir = join(isolatedBuildRoot, 'native-tools')
    helperApp = join(nativeToolsDir, 'Browser Forge Recorder.app')
    const skillVideoToolsDir = join(isolatedBuildRoot, 'skill-video-tools')
    execFileSync('node', ['scripts/build-native-tools.mjs'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BROWSER_FORGE_NATIVE_TOOLS_OUTPUT_DIR: nativeToolsDir,
        BROWSER_FORGE_SKILL_VIDEO_TOOLS_DIR: skillVideoToolsDir
      }
    })
  }, 120_000)

  afterAll(() => {
    rmSync(isolatedBuildRoot, { recursive: true, force: true })
  })

  it('builds the recorder as a signed macOS Helper App and keeps frame extraction standalone', () => {
    const recorder = join(helperApp, 'Contents', 'MacOS', 'Browser Forge Recorder')
    const infoPlist = join(helperApp, 'Contents', 'Info.plist')
    const icon = join(helperApp, 'Contents', 'Resources', 'BrowserForgeRecorder.icns')
    const frame = join(nativeToolsDir, 'bf-video-frame')
    const permissionAddon = join(nativeToolsDir, 'bf-screen-permission.node')

    for (const tool of [recorder, frame, permissionAddon]) {
      expect(existsSync(tool)).toBe(true)
      expect(statSync(tool).mode & 0o111).not.toBe(0)
      expect(execFileSync('lipo', ['-info', tool], { encoding: 'utf8' })).toContain('architecture: arm64')
      expect(execFileSync('otool', ['-l', tool], { encoding: 'utf8' })).toMatch(/\bminos 14\.2\b/)
    }
    const addonResult = JSON.parse(execFileSync(process.execPath, ['-e', `const addon = require(${JSON.stringify(permissionAddon)}); process.stdout.write(JSON.stringify({ check: typeof addon.check, request: typeof addon.request, granted: addon.check() }))`], { encoding: 'utf8' }))
    expect(addonResult).toEqual({ check: 'function', request: 'function', granted: expect.any(Boolean) })
    expect(existsSync(infoPlist)).toBe(true)
    expect(existsSync(icon)).toBe(true)
    expect(execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', infoPlist], { encoding: 'utf8' }).trim()).toBe('com.browserforge.app.recorder')
    expect(execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', infoPlist], { encoding: 'utf8' }).trim()).toBe('Browser Forge Recorder')
    expect(execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundlePackageType', infoPlist], { encoding: 'utf8' }).trim()).toBe('APPL')
    expect(() => execFileSync('codesign', ['--verify', '--deep', '--strict', helperApp], { encoding: 'utf8', stdio: 'pipe' })).not.toThrow()
    expect(existsSync(join(nativeToolsDir, 'bf-window-recorder'))).toBe(false)
  }, 120_000)

  it('bootstraps AppKit on the main actor before constructing a ScreenCaptureKit window filter', () => {
    const recorder = join(helperApp, 'Contents', 'MacOS', 'Browser Forge Recorder')
    const source = readFileSync(join(process.cwd(), 'native/macos/window-recorder/main.swift'), 'utf8')
    const filterIndex = source.indexOf('SCContentFilter(desktopIndependentWindow: target)')

    expect(source).toContain('import AppKit')
    expect(source).toContain('NSApplication.shared')
    expect(source).toContain('@MainActor')
    expect(source.indexOf('NSApplication.shared')).toBeLessThan(filterIndex)
    expect(execFileSync('otool', ['-L', recorder], { encoding: 'utf8' })).toContain('/System/Library/Frameworks/AppKit.framework')
  })

  it('exposes a non-interactive screen-recording permission check protocol from the Helper App identity', () => {
    const tool = join(helperApp, 'Contents', 'MacOS', 'Browser Forge Recorder')
    const result = JSON.parse(execFileSync(tool, ['--check-permission'], { encoding: 'utf8' }).trim())

    expect(result).toEqual(expect.objectContaining({
      type: 'screen-recording-permission',
      action: 'check',
      status: expect.stringMatching(/^(granted|not-granted)$/),
      granted: expect.any(Boolean),
      restartRequired: false
    }))
  })

  it('implements permission request states with CoreGraphics before recorder argument parsing', () => {
    const source = readFileSync(join(process.cwd(), 'native/macos/window-recorder/main.swift'), 'utf8')

    expect(source).toContain('import CoreGraphics')
    expect(source).toContain('CGPreflightScreenCaptureAccess()')
    expect(source).toContain('CGRequestScreenCaptureAccess()')
    expect(source).toContain('case "--check-permission"')
    expect(source).toContain('case "--request-permission"')
    expect(source).toContain('"restart-required"')
    const requestBranch = source.slice(source.indexOf('case "--request-permission"'), source.indexOf('default:', source.indexOf('case "--request-permission"')))
    expect(requestBranch).toContain('if requestAccepted')
    expect(requestBranch).not.toContain('let granted = CGPreflightScreenCaptureAccess()')
    expect(source.indexOf('runPermissionCommand')).toBeLessThan(source.indexOf('let args = try RecorderArguments()'))
  })

  it('commits the video epoch only after the first append and finalizes captured prefixes as partial', () => {
    const source = readFileSync(join(process.cwd(), 'native/macos/window-recorder/main.swift'), 'utf8')
    const outputHandler = source.slice(
      source.indexOf('func stream(_ stream: SCStream, didOutputSampleBuffer'),
      source.indexOf('private func beginWriter')
    )

    expect(outputHandler.indexOf('writerInput.append(sampleBuffer)')).toBeGreaterThanOrEqual(0)
    expect(outputHandler.indexOf('firstPTS = pts')).toBeGreaterThan(outputHandler.indexOf('writerInput.append(sampleBuffer)'))
    expect(source).toContain('beginStop(failure: error)')
    expect(source).toContain('if playable && terminalFailure == nil')
  })
})
