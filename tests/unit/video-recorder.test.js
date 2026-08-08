import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
import { VideoRecorder } from '../../src/main/recorder/video-recorder.js'

function createFakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { write: vi.fn() }
  child.kill = vi.fn()
  return child
}

describe('VideoRecorder', () => {
  it('resolves the recorder through the platform executable registry', async () => {
    const child = createFakeChild()
    const resolveBinaryPath = vi.fn(() => '/app/native-tools/bf-window-recorder')
    const recorder = new VideoRecorder({ platform: 'darwin', arch: 'arm64', resolveBinaryPath, spawnProcess: () => child })

    const starting = recorder.start({ chromePid: 1, expectedWindowTitle: 'title', outputPath: '/tmp/output.mp4' })
    expect(resolveBinaryPath).toHaveBeenCalledWith('bf-window-recorder')
    child.stdout.emit('data', Buffer.from('{"type":"started","startEpochMs":100,"window":{"pid":1,"windowId":"a","title":"title"}}\n'))
    await starting
  })

  it('uses the platform registry gate so a future Windows backend needs no common-recorder change', async () => {
    const child = createFakeChild()
    const getPlatformKey = vi.fn(() => 'win32-x64')
    const resolveBinaryPath = vi.fn(() => 'C:\\Browser Forge\\native-tools\\bf-window-recorder.exe')
    const spawnProcess = vi.fn(() => child)
    const recorder = new VideoRecorder({
      platform: 'win32',
      arch: 'x64',
      getPlatformKey,
      resolveBinaryPath,
      spawnProcess
    })

    const starting = recorder.start({ chromePid: 7, expectedWindowTitle: 'title', outputPath: 'C:\\recording.mp4' })
    expect(getPlatformKey).toHaveBeenCalledWith({ platform: 'win32', arch: 'x64' })
    expect(resolveBinaryPath).toHaveBeenCalledWith('bf-window-recorder.exe')
    child.stdout.emit('data', Buffer.from('{"type":"started","startEpochMs":100,"window":{"pid":7,"windowId":"hwnd-7","title":"title"}}\n'))

    await expect(starting).resolves.toMatchObject({ window: { windowId: 'hwnd-7' } })
  })

  it('launches the bundled recorder and resolves only after the first frame is persisted', async () => {
    const child = createFakeChild()
    const spawnProcess = vi.fn(() => child)
    const recorder = new VideoRecorder({
      platform: 'darwin',
      resolveBinaryPath: () => '/app/native-tools/bf-window-recorder',
      spawnProcess
    })

    const starting = recorder.start({
      chromePid: 321,
      expectedWindowTitle: 'Browser Forge Recording · token',
      outputPath: '/tmp/recording.mp4',
      timeoutMs: 10_000
    })

    expect(spawnProcess).toHaveBeenCalledWith('/app/native-tools/bf-window-recorder', [
      '--chrome-pid', '321',
      '--expected-window-title', 'Browser Forge Recording · token',
      '--output', '/tmp/recording.mp4',
      '--fps', '15',
      '--timeout-ms', '10000'
    ], expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }))

    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      type: 'started',
      startEpochMs: 1_786_170_000_123,
      window: { pid: 321, windowId: '77', title: 'Browser Forge Recording · token' }
    })}\n`))

    await expect(starting).resolves.toEqual({
      startEpochMs: 1_786_170_000_123,
      window: { pid: 321, windowId: '77', title: 'Browser Forge Recording · token' }
    })
  })

  it('returns the native finalization result through a graceful stdin stop command', async () => {
    const child = createFakeChild()
    const recorder = new VideoRecorder({
      platform: 'darwin',
      resolveBinaryPath: () => '/bf-window-recorder',
      spawnProcess: () => child
    })

    const starting = recorder.start({ chromePid: 1, expectedWindowTitle: 'title', outputPath: '/tmp/output.mp4' })
    child.stdout.emit('data', Buffer.from('{"type":"started","startEpochMs":100,"window":{"pid":1,"windowId":"a","title":"title"}}\n'))
    await starting

    const stopping = recorder.stop()
    expect(child.stdin.write).toHaveBeenCalledWith('{"type":"stop"}\n')
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      type: 'completed',
      state: 'complete',
      durationMs: 456,
      coveredUntilOffsetMs: 456,
      sourcePath: '/tmp/output.mp4'
    })}\n`))

    await expect(stopping).resolves.toEqual({
      state: 'complete',
      durationMs: 456,
      coveredUntilOffsetMs: 456,
      sourcePath: '/tmp/output.mp4',
      window: { pid: 1, windowId: 'a', title: 'title' }
    })
  })

  it('surfaces structured native errors and does not fall back to an arbitrary screen', async () => {
    const child = createFakeChild()
    const recorder = new VideoRecorder({
      platform: 'darwin',
      resolveBinaryPath: () => '/bf-window-recorder',
      spawnProcess: () => child
    })

    const starting = recorder.start({ chromePid: 1, expectedWindowTitle: 'title', outputPath: '/tmp/output.mp4' })
    child.stdout.emit('data', Buffer.from('{"type":"error","code":"WINDOW_NOT_FOUND","message":"No matching window"}\n'))

    await expect(starting).rejects.toMatchObject({ code: 'WINDOW_NOT_FOUND', message: 'No matching window' })
    await expect(recorder.stop()).resolves.toEqual({ state: 'failed', durationMs: 0, coveredUntilOffsetMs: 0 })
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('has an explicit unsupported platform failure until the Windows backend exists', async () => {
    const recorder = new VideoRecorder({ platform: 'win32' })
    await expect(recorder.start({ chromePid: 1, expectedWindowTitle: 'title', outputPath: '/tmp/output.mp4' }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' })
  })

  it('rejects Intel macOS before attempting to launch the arm64 recorder', async () => {
    const spawnProcess = vi.fn(() => { throw new Error('must not launch') })
    const recorder = new VideoRecorder({ platform: 'darwin', arch: 'x64', spawnProcess })

    await expect(recorder.start({ chromePid: 1, expectedWindowTitle: 'title', outputPath: '/tmp/output.mp4' }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' })
    expect(spawnProcess).not.toHaveBeenCalled()
  })
})

describe('VideoRecorder terminal-state safety', () => {
  it('fails closed when the native recorder reports a mismatched window identity', async () => {
    const child = createFakeChild()
    const recorder = new VideoRecorder({
      platform: 'darwin',
      resolveBinaryPath: () => '/bf-window-recorder',
      spawnProcess: () => child
    })

    const starting = recorder.start({ chromePid: 42, expectedWindowTitle: 'Browser Forge Recording · expected', outputPath: '/tmp/output.mp4' })
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      type: 'started',
      startEpochMs: 1_786_170_000_123,
      window: { pid: 42, windowId: 'wrong-window', title: 'Browser Forge Recording · another-session' }
    })}\n`))

    await expect(starting).rejects.toMatchObject({ code: 'RECORDER_PROTOCOL_ERROR' })
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('returns a failed video material instead of hanging when capture dies after the first frame', async () => {
    const child = createFakeChild()
    const onUnexpectedTerminal = vi.fn()
    const recorder = new VideoRecorder({
      platform: 'darwin',
      resolveBinaryPath: () => '/bf-window-recorder',
      spawnProcess: () => child,
      onUnexpectedTerminal
    })

    const starting = recorder.start({ chromePid: 42, expectedWindowTitle: 'Browser Forge Recording · expected', outputPath: '/tmp/output.mp4' })
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      type: 'started',
      startEpochMs: 1_786_170_000_123,
      window: { pid: 42, windowId: 'window-42', title: 'Browser Forge Recording · expected' }
    })}\n`))
    await starting

    child.stdout.emit('data', Buffer.from('{"type":"error","code":"CAPTURE_STOPPED","message":"capture lost"}\n'))

    const stopped = await Promise.race([
      recorder.stop(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('stop() did not settle after the terminal error')), 100))
    ])

    expect(stopped).toEqual({
      state: 'failed',
      durationMs: 0,
      coveredUntilOffsetMs: 0,
      window: { pid: 42, windowId: 'window-42', title: 'Browser Forge Recording · expected' }
    })
    expect(onUnexpectedTerminal).toHaveBeenCalledWith(stopped)
    expect(child.kill).toHaveBeenCalledTimes(1)
  })


  it('notifies the owner when the native recorder completes as failed before stop is requested', async () => {
    const child = createFakeChild()
    const onUnexpectedTerminal = vi.fn()
    const recorder = new VideoRecorder({
      platform: 'darwin',
      resolveBinaryPath: () => '/bf-window-recorder',
      spawnProcess: () => child,
      onUnexpectedTerminal
    })

    const window = { pid: 42, windowId: 'window-42', title: 'Browser Forge Recording · expected' }
    const starting = recorder.start({ chromePid: 42, expectedWindowTitle: window.title, outputPath: '/tmp/output.mp4' })
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      type: 'started', startEpochMs: 1_786_170_000_123, window
    })}\n`))
    await starting

    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      type: 'completed', state: 'failed', durationMs: 0, coveredUntilOffsetMs: 0, window
    })}\n`))

    await vi.waitFor(() => expect(onUnexpectedTerminal).toHaveBeenCalledWith({
      state: 'failed', durationMs: 0, coveredUntilOffsetMs: 0, window
    }))
    await expect(recorder.stop()).resolves.toEqual({
      state: 'failed', durationMs: 0, coveredUntilOffsetMs: 0, window
    })
  })

  it('fails the video closed and terminates the child when graceful finalization times out', async () => {
    const child = createFakeChild()
    const onUnexpectedTerminal = vi.fn()
    const recorder = new VideoRecorder({
      platform: 'darwin',
      resolveBinaryPath: () => '/bf-window-recorder',
      spawnProcess: () => child,
      stopTimeoutMs: 5,
      onUnexpectedTerminal
    })

    const window = { pid: 42, windowId: 'window-42', title: 'Browser Forge Recording · expected' }
    const starting = recorder.start({ chromePid: 42, expectedWindowTitle: window.title, outputPath: '/tmp/output.mp4' })
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      type: 'started', startEpochMs: 1_786_170_000_123, window
    })}\n`))
    await starting

    await expect(recorder.stop()).resolves.toEqual({
      state: 'failed', durationMs: 0, coveredUntilOffsetMs: 0, window
    })
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(onUnexpectedTerminal).not.toHaveBeenCalled()
  })


  it('never accepts a native source path outside the requested temporary MP4', async () => {
    const child = createFakeChild()
    const recorder = new VideoRecorder({
      platform: 'darwin',
      resolveBinaryPath: () => '/bf-window-recorder',
      spawnProcess: () => child
    })

    const window = { pid: 42, windowId: 'window-42', title: 'Browser Forge Recording · expected' }
    const starting = recorder.start({ chromePid: 42, expectedWindowTitle: window.title, outputPath: '/tmp/output.mp4' })
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      type: 'started', startEpochMs: 1_786_170_000_123, window
    })}\n`))
    await starting

    const stopping = recorder.stop()
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      type: 'completed', state: 'complete', durationMs: 500, coveredUntilOffsetMs: 500,
      sourcePath: '/etc/passwd', window
    })}\n`))

    await expect(stopping).resolves.toEqual({
      state: 'failed', durationMs: 0, coveredUntilOffsetMs: 0, window
    })
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('waits for stdout to drain after exit before deciding the terminal result', async () => {
    const child = createFakeChild()
    const recorder = new VideoRecorder({
      platform: 'darwin',
      resolveBinaryPath: () => '/bf-window-recorder',
      spawnProcess: () => child
    })

    const window = { pid: 42, windowId: 'window-42', title: 'Browser Forge Recording · expected' }
    const starting = recorder.start({ chromePid: 42, expectedWindowTitle: window.title, outputPath: '/tmp/output.mp4' })
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'started', startEpochMs: 100, window })}\n`))
    await starting

    const stopping = recorder.stop()
    child.emit('exit', 0, null)
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      type: 'completed', state: 'complete', durationMs: 500, coveredUntilOffsetMs: 500,
      sourcePath: '/tmp/output.mp4', window
    })}\n`))
    child.stdout.emit('end')
    child.emit('close', 0, null)

    await expect(stopping).resolves.toMatchObject({ state: 'complete', durationMs: 500 })
  })

  it('enforces complete and failed terminal-state invariants', async () => {
    for (const completed of [
      { state: 'complete', durationMs: 500, coveredUntilOffsetMs: 499, sourcePath: '/tmp/output.mp4' },
      { state: 'failed', durationMs: 1, coveredUntilOffsetMs: 0 }
    ]) {
      const child = createFakeChild()
      const recorder = new VideoRecorder({
        platform: 'darwin',
        resolveBinaryPath: () => '/bf-window-recorder',
        spawnProcess: () => child
      })
      const window = { pid: 42, windowId: 'window-42', title: 'Browser Forge Recording · expected' }
      const starting = recorder.start({ chromePid: 42, expectedWindowTitle: window.title, outputPath: '/tmp/output.mp4' })
      child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'started', startEpochMs: 100, window })}\n`))
      await starting

      const stopping = recorder.stop()
      child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'completed', ...completed, window })}\n`))

      await expect(stopping).resolves.toMatchObject({ state: 'failed', durationMs: 0, coveredUntilOffsetMs: 0 })
      expect(child.kill).toHaveBeenCalledTimes(1)
    }
  })

  it('accepts only a validated final video state with the matched window identity', async () => {
    const child = createFakeChild()
    const recorder = new VideoRecorder({
      platform: 'darwin',
      resolveBinaryPath: () => '/bf-window-recorder',
      spawnProcess: () => child
    })

    const starting = recorder.start({ chromePid: 42, expectedWindowTitle: 'Browser Forge Recording · expected', outputPath: '/tmp/output.mp4' })
    const window = { pid: 42, windowId: 'window-42', title: 'Browser Forge Recording · expected' }
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'started', startEpochMs: 1_786_170_000_123, window })}\n`))
    await starting

    const stopping = recorder.stop()
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      type: 'completed',
      state: 'partial',
      durationMs: 500,
      coveredUntilOffsetMs: 501,
      sourcePath: '/tmp/output.mp4',
      window
    })}\n`))

    await expect(stopping).resolves.toEqual({
      state: 'failed',
      durationMs: 0,
      coveredUntilOffsetMs: 0,
      window
    })
  })
})
