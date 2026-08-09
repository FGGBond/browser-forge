import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(process.cwd(), 'native/macos/window-recorder/main.swift'), 'utf8')

function section(start, end) {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  expect(startIndex, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0)
  expect(endIndex, `missing source marker: ${end}`).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

describe('window recorder lifecycle source contract', () => {
  it('serializes ScreenCaptureKit errors and lets an error upgrade an in-flight clean stop', () => {
    const failureRequest = section('func requestFailure(', 'private func waitForUniqueWindow')
    const stopTransition = section('private func beginStop(', 'private func captureDidStop')
    const delegate = section('func stream(_ stream: SCStream, didStopWithError', '\n    }\n}')

    expect(failureRequest).toContain('queue.async')
    expect(delegate).toContain('requestFailure(')

    const rememberFailure = stopTransition.indexOf('terminalFailure =')
    const alreadyStoppingGuard = stopTransition.indexOf('guard !stopRequested else { return }')
    expect(rememberFailure).toBeGreaterThanOrEqual(0)
    expect(alreadyStoppingGuard).toBeGreaterThan(rememberFailure)
  })

  it('returns asynchronous stop and writer callbacks to the recorder queue before final state is decided', () => {
    const stopTransition = section('private func beginStop(', 'private func captureDidStop')
    const captureStopped = section('private func captureDidStop', 'private func finalizeWriter')
    const finalizer = section('private func finalizeWriter', 'private func isPlayableVideo')

    expect(stopTransition).toMatch(/stopCapture[\s\S]*queue\.async/)
    expect(captureStopped).toMatch(/finishWriting[\s\S]*queue\.async/)
    expect(finalizer).toContain('terminalFailure == nil')
  })

  it('clears the stdin handler and fails closed when the parent pipe reaches EOF', () => {
    const stdinHandler = section('FileHandle.standardInput.readabilityHandler', 'try await recorder.start()')
    const eofBranch = section('if data.isEmpty', 'guard let line =')

    expect(stdinHandler).toContain('if data.isEmpty')
    expect(eofBranch).toContain('handle.readabilityHandler = nil')
    expect(eofBranch).toContain('requestFailure(')
    expect(eofBranch).toContain('STDIN_CLOSED')
    expect(eofBranch.indexOf('handle.readabilityHandler = nil')).toBeLessThan(eofBranch.indexOf('requestFailure('))
  })

  it('serializes capture startup with stop and EOF requests on the recorder queue', () => {
    const startup = section('func start() async throws', 'private func installAndStartCapture')
    const beginCaptureStart = section('private func beginCaptureStart(', 'private func captureDidStart')
    const captureDidStart = section('private func captureDidStart', 'private func waitForUniqueWindow')
    const stopTransition = section('private func beginStop(', 'private func stopCaptureAndFinalize')

    expect(source).toContain('@unchecked Sendable')
    expect(startup).toContain('installAndStartCapture(')
    expect(startup).not.toMatch(/identity\s*=/)
    expect(startup).not.toMatch(/stream\s*=/)
    expect(beginCaptureStart).toContain('captureStartInFlight = true')
    expect(beginCaptureStart).toMatch(/startCapture\(completionHandler:[\s\S]*queue\.async/)
    expect(stopTransition).toContain('guard !captureStartInFlight else { return }')
    expect(captureDidStart).toContain('stopCaptureAndFinalize()')
  })

  it('falls back only to the unique large on-screen window owned by the dedicated Chrome PID', () => {
    const matcher = section('private func waitForUniqueWindow', 'func stream(_ stream: SCStream')

    expect(matcher).toContain('window.owningApplication?.processID == args.chromePid')
    expect(matcher).toContain('window.title == args.expectedWindowTitle')
    expect(matcher).toContain('let ownedWindows =')
    expect(matcher).toContain('window.frame.width >= 320 && window.frame.height >= 240')
    expect(matcher).toContain('if ownedWindows.count == 1 { return WindowMatch(window: ownedWindows[0], strategy: .uniquePidWindow) }')
    expect(matcher.indexOf('window.title == args.expectedWindowTitle')).toBeLessThan(matcher.indexOf('if ownedWindows.count == 1'))
    expect(source).toContain('case exactTitle = "exact-title"')
    expect(source).toContain('case uniquePidWindow = "unique-pid-window"')
    expect(source).toContain('"requestedTitle": requestedTitle')
    expect(source).toContain('"matchStrategy": matchStrategy.rawValue')
  })

  it('keeps the AppKit recorder alive without recursively entering dispatchMain from async main', () => {
    const mainBody = source.slice(source.indexOf('@main'))

    expect(source).toContain('func waitUntilTermination() async')
    expect(source).toContain('withUnsafeContinuation')
    expect(mainBody).toContain('await recorder.waitUntilTermination()')
    expect(mainBody).not.toContain('dispatchMain()')
  })

  it('typechecks without Swift strict-concurrency data-race warnings', () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'browser-forge-window-recorder-'))
    try {
      const result = spawnSync('swiftc', [
        '-target', 'arm64-apple-macos14.2',
        '-parse-as-library',
        '-strict-concurrency=complete',
        '-warn-concurrency',
        join(process.cwd(), 'native/macos/window-recorder/main.swift'),
        '-framework', 'ScreenCaptureKit',
        '-framework', 'AVFoundation',
        '-framework', 'CoreMedia',
        '-framework', 'CoreVideo',
        '-o', join(outputDir, 'bf-window-recorder')
      ], { encoding: 'utf8' })

      expect(result.status, result.stderr || result.stdout).toBe(0)
      expect(result.stderr).not.toMatch(/SendableClosureCaptures|may introduce data races|potentially data-racing/)
    } finally {
      rmSync(outputDir, { recursive: true, force: true })
    }
  })

})
