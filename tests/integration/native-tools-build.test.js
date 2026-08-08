import { execFileSync } from 'child_process'
import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

describe.runIf(process.platform === 'darwin')('macOS native video tools', () => {
  it('compiles bundled ScreenCaptureKit and AVFoundation executables with swiftc', () => {
    execFileSync('node', ['scripts/build-native-tools.mjs'], { encoding: 'utf8' })
    for (const tool of ['bf-window-recorder', 'bf-video-frame']) {
      const path = join(process.cwd(), 'native/macos/bin', tool)
      expect(existsSync(path)).toBe(true)
      expect(statSync(path).mode & 0o111).not.toBe(0)
    }
  }, 60_000)
})
