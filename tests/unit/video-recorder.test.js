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
  })

  it('has an explicit unsupported platform failure until the Windows backend exists', async () => {
    const recorder = new VideoRecorder({ platform: 'win32' })
    await expect(recorder.start({ chromePid: 1, expectedWindowTitle: 'title', outputPath: '/tmp/output.mp4' }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' })
  })
})
