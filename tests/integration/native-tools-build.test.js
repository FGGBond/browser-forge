import { execFileSync } from 'child_process'
import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

describe.runIf(process.platform === 'darwin')('macOS native video tools', () => {
  it('compiles bundled ScreenCaptureKit and AVFoundation executables with swiftc', () => {
    execFileSync('node', ['scripts/build-native-tools.mjs'], { encoding: 'utf8' })
    for (const tool of ['bf-window-recorder', 'bf-video-frame']) {
      const path = join(process.cwd(), 'native-tools', tool)
      expect(existsSync(path)).toBe(true)
      expect(statSync(path).mode & 0o111).not.toBe(0)
      expect(execFileSync('lipo', ['-info', path], { encoding: 'utf8' })).toContain('architecture: arm64')
      expect(execFileSync('otool', ['-l', path], { encoding: 'utf8' })).toMatch(/\bminos 14\.2\b/)
    }
  }, 120_000)

  it('exposes a non-interactive screen-recording permission check protocol', () => {
    const tool = join(process.cwd(), 'native-tools', 'bf-window-recorder')
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
