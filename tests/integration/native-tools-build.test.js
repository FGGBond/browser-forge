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
