import { spawn as defaultSpawn } from 'child_process'
import { resolveNativeToolPath } from './native-tools.js'

export class VideoRecorder {
  constructor({
    platform = process.platform,
    resolveBinaryPath = toolName => resolveNativeToolPath({ toolName, platform }),
    spawnProcess = defaultSpawn,
    fps = 15
  } = {}) {
    this.platform = platform
    this.resolveBinaryPath = resolveBinaryPath
    this.spawnProcess = spawnProcess
    this.fps = fps
    this._child = null
    this._startPromise = null
    this._stopPromise = null
    this._started = null
    this._lineBuffer = ''
    this._settleStart = null
    this._settleStop = null
  }

  async start({ chromePid, expectedWindowTitle, outputPath, timeoutMs = 10_000 } = {}) {
    if (this.platform !== 'darwin') {
      throw createVideoError('UNSUPPORTED_PLATFORM', `Window video recording is not implemented for ${this.platform}`)
    }
    if (this._startPromise) return this._startPromise
    if (!Number.isInteger(chromePid) || chromePid <= 0) throw createVideoError('INVALID_ARGUMENT', 'chromePid must be a positive integer')
    if (!expectedWindowTitle) throw createVideoError('INVALID_ARGUMENT', 'expectedWindowTitle is required')
    if (!outputPath) throw createVideoError('INVALID_ARGUMENT', 'outputPath is required')

    const binaryPath = this.resolveBinaryPath('bf-window-recorder')
    const args = [
      '--chrome-pid', String(chromePid),
      '--expected-window-title', expectedWindowTitle,
      '--output', outputPath,
      '--fps', String(this.fps),
      '--timeout-ms', String(timeoutMs)
    ]

    this._startPromise = new Promise((resolve, reject) => {
      this._settleStart = { resolve, reject }
      let child
      try {
        child = this.spawnProcess(binaryPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (error) {
        this._rejectStart(createVideoError('RECORDER_LAUNCH_FAILED', error.message, error))
        return
      }
      this._child = child
      child.stdout?.on('data', chunk => this._handleStdout(chunk))
      child.stderr?.on('data', () => {})
      child.once?.('error', error => this._handleProcessError(error))
      child.once?.('exit', (code, signal) => this._handleExit(code, signal))
    })

    return this._startPromise
  }

  async stop() {
    if (this._stopPromise) return this._stopPromise
    if (!this._child) {
      return { state: 'failed', durationMs: 0, coveredUntilOffsetMs: 0 }
    }

    this._stopPromise = new Promise((resolve, reject) => {
      this._settleStop = { resolve, reject }
      try {
        this._child.stdin?.write?.('{"type":"stop"}\n')
      } catch (error) {
        this._rejectStop(createVideoError('RECORDER_STOP_FAILED', error.message, error))
      }
    })
    return this._stopPromise
  }

  _handleStdout(chunk) {
    this._lineBuffer += Buffer.from(chunk).toString('utf8')
    const lines = this._lineBuffer.split('\n')
    this._lineBuffer = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        this._handleProtocolError(`Recorder emitted invalid JSON: ${line.slice(0, 200)}`)
        continue
      }
      this._handleMessage(message)
    }
  }

  _handleMessage(message) {
    if (message.type === 'started') {
      if (!Number.isFinite(message.startEpochMs) || !message.window) {
        this._handleProtocolError('Recorder started message is missing first-frame metadata')
        return
      }
      this._started = { startEpochMs: Math.round(message.startEpochMs), window: message.window }
      this._resolveStart(this._started)
      return
    }
    if (message.type === 'completed') {
      this._resolveStartIfNeededFailure('Recorder completed before persisting a first frame')
      this._resolveStop({
        state: message.state,
        durationMs: message.durationMs,
        coveredUntilOffsetMs: message.coveredUntilOffsetMs,
        sourcePath: message.sourcePath,
        window: message.window ?? this._started?.window
      })
      return
    }
    if (message.type === 'error') {
      const error = createVideoError(message.code ?? 'RECORDER_FAILED', message.message ?? 'Native video recorder failed')
      this._rejectStart(error)
      this._rejectStop(error)
      return
    }
    this._handleProtocolError(`Recorder emitted an unknown message type: ${message.type ?? 'missing'}`)
  }

  _handleProcessError(error) {
    const wrapped = createVideoError('RECORDER_LAUNCH_FAILED', error.message, error)
    this._rejectStart(wrapped)
    this._rejectStop(wrapped)
  }

  _handleExit(code, signal) {
    if (this._settleStart) {
      this._rejectStart(createVideoError('RECORDER_EXITED', `Native recorder exited before first frame (code=${code ?? 'null'}, signal=${signal ?? 'null'})`))
    }
    if (this._settleStop) {
      this._rejectStop(createVideoError('RECORDER_EXITED', `Native recorder exited before finalization (code=${code ?? 'null'}, signal=${signal ?? 'null'})`))
    }
  }

  _handleProtocolError(message) {
    const error = createVideoError('RECORDER_PROTOCOL_ERROR', message)
    this._rejectStart(error)
    this._rejectStop(error)
  }

  _resolveStart(value) {
    const settle = this._settleStart
    this._settleStart = null
    settle?.resolve(value)
  }

  _rejectStart(error) {
    const settle = this._settleStart
    this._settleStart = null
    settle?.reject(error)
  }

  _resolveStartIfNeededFailure(message) {
    if (this._settleStart) this._rejectStart(createVideoError('FIRST_FRAME_NOT_WRITTEN', message))
  }

  _resolveStop(value) {
    const settle = this._settleStop
    this._settleStop = null
    settle?.resolve(value)
  }

  _rejectStop(error) {
    const settle = this._settleStop
    this._settleStop = null
    settle?.reject(error)
  }
}

export function createVideoError(code, message, cause) {
  const error = new Error(message)
  error.code = code
  if (cause) error.cause = cause
  return error
}
