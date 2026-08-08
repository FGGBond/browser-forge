import { spawn as defaultSpawn } from 'child_process'
import { resolve as resolvePath } from 'path'
import { getNativeToolExecutableName, getNativeToolPlatformKey, resolveNativeToolPath } from './native-tools.js'

const FINAL_STATES = new Set(['complete', 'partial', 'failed'])
const DEFAULT_STOP_TIMEOUT_MS = 15_000

export class VideoRecorder {
  constructor({
    platform = process.platform,
    arch = process.arch,
    nativeToolPathOptions = {},
    getPlatformKey = options => getNativeToolPlatformKey(options),
    resolveBinaryPath = toolName => resolveNativeToolPath({ ...nativeToolPathOptions, toolName, platform, arch }),
    spawnProcess = defaultSpawn,
    fps = 15,
    stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
    onUnexpectedTerminal
  } = {}) {
    this.platform = platform
    this.arch = arch
    this.getPlatformKey = getPlatformKey
    this.resolveBinaryPath = resolveBinaryPath
    this.spawnProcess = spawnProcess
    this.fps = fps
    this.stopTimeoutMs = normalizeStopTimeout(stopTimeoutMs)
    this.onUnexpectedTerminal = typeof onUnexpectedTerminal === 'function' ? onUnexpectedTerminal : null
    this._child = null
    this._childExited = false
    this._childClosed = false
    this._exitCode = null
    this._exitSignal = null
    this._startPromise = null
    this._startFailed = false
    this._stopPromise = null
    this._started = null
    this._terminal = null
    this._expectedWindow = null
    this._expectedOutputPath = null
    this._lineBuffer = ''
    this._settleStart = null
    this._settleStop = null
    this._unexpectedTerminalNotified = false
    this._stopRequested = false
    this._childTerminated = false
  }

  async start({ chromePid, expectedWindowTitle, outputPath, timeoutMs = 10_000 } = {}) {
    try {
      this.getPlatformKey({ platform: this.platform, arch: this.arch })
    } catch (cause) {
      throw createVideoError('UNSUPPORTED_PLATFORM', `Window video recording is not implemented for ${this.platform}-${this.arch}`, cause)
    }
    if (this._startPromise) return this._startPromise
    if (!Number.isInteger(chromePid) || chromePid <= 0) throw createVideoError('INVALID_ARGUMENT', 'chromePid must be a positive integer')
    if (typeof expectedWindowTitle !== 'string' || !expectedWindowTitle) throw createVideoError('INVALID_ARGUMENT', 'expectedWindowTitle is required')
    if (typeof outputPath !== 'string' || !outputPath) throw createVideoError('INVALID_ARGUMENT', 'outputPath is required')

    this._expectedWindow = { pid: chromePid, title: expectedWindowTitle }
    this._expectedOutputPath = resolvePath(outputPath)
    this._childExited = false
    this._childClosed = false
    this._exitCode = null
    this._exitSignal = null
    const binaryPath = this.resolveBinaryPath(getNativeToolExecutableName({ tool: 'windowRecorder', platform: this.platform, arch: this.arch }))
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
      child.stdout?.once?.('end', () => this._flushLineBuffer())
      child.once?.('exit', (code, signal) => this._handleExit(code, signal))
      child.once?.('close', (code, signal) => this._handleClose(code, signal))
      if (this._hasExited(child)) this._handleExit(child.exitCode, child.signalCode)
      if (child.stdout?.readableEnded) this._flushLineBuffer()
    })

    return this._startPromise
  }

  async stop({ timeoutMs } = {}) {
    if (this._terminal) return this._terminal
    if (this._stopPromise) return this._stopPromise
    if (!this._child) {
      return { state: 'failed', durationMs: 0, coveredUntilOffsetMs: 0 }
    }
    if (this._startFailed && !this._started) {
      this._terminateChild()
      return { state: 'failed', durationMs: 0, coveredUntilOffsetMs: 0 }
    }
    const finalizationTimeoutMs = normalizeStopTimeout(timeoutMs ?? this.stopTimeoutMs)
    this._stopRequested = true
    this._stopPromise = new Promise((resolve, reject) => {
      const settle = { resolve, reject, timer: null, cleanup: null }
      this._settleStop = settle
      settle.timer = setTimeout(() => {
        this._failStopClosed(createVideoError('RECORDER_STOP_TIMEOUT', `Native recorder did not finalize within ${finalizationTimeoutMs}ms`))
      }, finalizationTimeoutMs)

      if (this._childClosed) {
        this._handleClose(this._exitCode, this._exitSignal)
        return
      }
      if (this._hasExited(this._child)) {
        return
      }

      const stdin = this._child.stdin
      const write = stdin?.write
      if (typeof write !== 'function') {
        this._failStopClosed(createVideoError('RECORDER_STOP_FAILED', 'Native recorder stdin is unavailable'))
        return
      }

      const onWriteError = error => {
        if (error) this._failStopClosed(createVideoError('RECORDER_STOP_FAILED', error.message, error))
      }
      if (typeof stdin.once === 'function') {
        const onStdinError = error => this._failStopClosed(createVideoError('RECORDER_STOP_FAILED', error.message, error))
        stdin.once('error', onStdinError)
        settle.cleanup = () => stdin.removeListener?.('error', onStdinError)
      }
      try {
        // The existing test double is a zero-argument vi.fn(). Do not pass it a
        // callback, while real Node Writable streams receive callback errors here.
        if (write.length >= 2) {
          write.call(stdin, '{"type":"stop"}\n', onWriteError)
        } else {
          write.call(stdin, '{"type":"stop"}\n')
        }
      } catch (error) {
        this._failStopClosed(createVideoError('RECORDER_STOP_FAILED', error.message, error))
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

  _flushLineBuffer() {
    const line = this._lineBuffer
    this._lineBuffer = ''
    if (!line.trim()) return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this._handleProtocolError(`Recorder emitted invalid JSON: ${line.slice(0, 200)}`)
      return
    }
    this._handleMessage(message)
  }

  _handleMessage(message) {
    if (this._terminal) return
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this._handleProtocolError('Recorder emitted a non-object message')
      return
    }

    if (message.type === 'started') {
      if (this._started) {
        this._handleProtocolError('Recorder emitted multiple started messages')
        return
      }
      const started = this._validateStarted(message)
      if (!started) return
      this._started = started
      this._resolveStart(started)
      return
    }
    if (message.type === 'completed') {
      const completed = this._validateCompleted(message)
      if (!completed) return
      this._setTerminal(completed, { unexpected: !this._stopRequested })
      return
    }
    if (message.type === 'error') {
      if (this._started) {
        this._terminateChild()
        this._cacheUnexpectedTerminal({ notify: !this._stopRequested })
        return
      }
      const error = createVideoError(message.code ?? 'RECORDER_FAILED', message.message ?? 'Native video recorder failed')
      this._rejectStart(error)
      this._rejectStop(error)
      this._terminateChild()
      return
    }
    this._handleProtocolError(`Recorder emitted an unknown message type: ${message.type ?? 'missing'}`)
  }

  _validateStarted(message) {
    if (!Number.isFinite(message.startEpochMs)) {
      this._handleProtocolError('Recorder started message is missing first-frame metadata')
      return null
    }
    const window = message.window
    if (!this._matchesExpectedWindow(window)) {
      this._handleProtocolError('Recorder started message does not match the requested window identity')
      return null
    }
    return {
      startEpochMs: Math.round(message.startEpochMs),
      window: { pid: window.pid, windowId: window.windowId, title: window.title }
    }
  }

  _validateCompleted(message) {
    if (!this._started) {
      this._handleProtocolError('Recorder completed before persisting a first frame')
      return null
    }
    if (!FINAL_STATES.has(message.state)) {
      this._handleProtocolError(`Recorder completed message has an invalid state: ${message.state ?? 'missing'}`)
      return null
    }

    const window = message.window === undefined ? this._started.window : message.window
    if (!this._windowsMatch(window, this._started.window)) {
      this._handleProtocolError('Recorder completed message does not match the started window identity')
      return null
    }
    if (!isNonNegativeNumber(message.durationMs) || !isNonNegativeNumber(message.coveredUntilOffsetMs)) {
      this._handleProtocolError('Recorder completed message has invalid duration or coverage')
      return null
    }
    if (message.coveredUntilOffsetMs > message.durationMs) {
      this._handleProtocolError('Recorder completed message coverage exceeds duration')
      return null
    }
    if (message.state === 'complete' && message.coveredUntilOffsetMs !== message.durationMs) {
      this._handleProtocolError('Recorder complete completion must cover the full duration')
      return null
    }

    const hasSourcePath = Object.prototype.hasOwnProperty.call(message, 'sourcePath')
    if (message.state === 'failed') {
      if (message.durationMs !== 0 || message.coveredUntilOffsetMs !== 0) {
        this._handleProtocolError('Recorder failed completion must have zero duration and coverage')
        return null
      }
      if (hasSourcePath) {
        this._handleProtocolError('Recorder failed completion must not include a sourcePath')
        return null
      }
      return {
        state: message.state,
        durationMs: message.durationMs,
        coveredUntilOffsetMs: message.coveredUntilOffsetMs,
        window: this._started.window
      }
    }
    if (typeof message.sourcePath !== 'string' || !message.sourcePath.trim()) {
      this._handleProtocolError('Recorder captured completion requires a sourcePath')
      return null
    }
    if (resolvePath(message.sourcePath) !== this._expectedOutputPath) {
      this._handleProtocolError('Recorder completed message returned an unexpected sourcePath')
      return null
    }
    return {
      state: message.state,
      durationMs: message.durationMs,
      coveredUntilOffsetMs: message.coveredUntilOffsetMs,
      sourcePath: message.sourcePath,
      window: this._started.window
    }
  }

  _matchesExpectedWindow(window) {
    return Boolean(
      window &&
      Number.isInteger(window.pid) &&
      window.pid === this._expectedWindow?.pid &&
      typeof window.title === 'string' &&
      window.title === this._expectedWindow?.title &&
      isNonEmptyString(window.windowId)
    )
  }

  _windowsMatch(left, right) {
    return Boolean(
      left &&
      right &&
      Number.isInteger(left.pid) &&
      left.pid === right.pid &&
      typeof left.title === 'string' &&
      left.title === right.title &&
      isNonEmptyString(left.windowId) &&
      left.windowId === right.windowId
    )
  }

  _handleProcessError(error) {
    if (this._terminal) return
    if (this._started) {
      this._terminateChild()
      this._cacheUnexpectedTerminal({ notify: !this._stopRequested })
      return
    }
    const wrapped = createVideoError('RECORDER_LAUNCH_FAILED', error.message, error)
    this._rejectStart(wrapped)
    this._rejectStop(wrapped)
    this._terminateChild()
  }

  _handleExit(code, signal) {
    this._childExited = true
    this._exitCode = code
    this._exitSignal = signal
  }

  _handleClose(code, signal) {
    if (this._childClosed) return
    this._childClosed = true
    this._childExited = true
    this._exitCode = code
    this._exitSignal = signal
    this._flushLineBuffer()
    if (this._terminal) return

    const detail = `code=${code ?? 'null'}, signal=${signal ?? 'null'}`
    if (this._started) {
      this._cacheUnexpectedTerminal({ notify: !this._stopRequested })
      return
    }
    const error = createVideoError('RECORDER_EXITED', `Native recorder exited before first frame (${detail})`)
    this._rejectStart(error)
    this._rejectStop(error)
  }

  _handleProtocolError(message) {
    const error = createVideoError('RECORDER_PROTOCOL_ERROR', message)
    if (this._started) {
      this._terminateChild()
      this._cacheUnexpectedTerminal({ notify: !this._stopRequested })
      return
    }
    this._rejectStart(error)
    this._rejectStop(error)
    this._terminateChild()
  }

  _cacheUnexpectedTerminal({ notify = true } = {}) {
    if (!this._started || this._terminal) return this._terminal
    return this._setTerminal(this._failedTerminal(), { unexpected: notify })
  }

  _failStopClosed(error) {
    if (this._terminal) return this._terminal
    if (!this._started) {
      this._rejectStop(error)
      return null
    }
    this._terminateChild()
    return this._setTerminal(this._failedTerminal())
  }

  _failedTerminal() {
    return {
      state: 'failed',
      durationMs: 0,
      coveredUntilOffsetMs: 0,
      window: this._started.window
    }
  }

  _setTerminal(terminal, { unexpected = false } = {}) {
    if (this._terminal) return this._terminal
    this._terminal = terminal
    this._resolveStop(terminal)
    if (unexpected) this._notifyUnexpectedTerminal(terminal)
    return terminal
  }

  _notifyUnexpectedTerminal(terminal) {
    if (this._unexpectedTerminalNotified) return
    this._unexpectedTerminalNotified = true
    try {
      this.onUnexpectedTerminal?.(terminal)
    } catch {
      // The recorder has already reached its terminal state; callback failures
      // must not reopen it or make stop() hang.
    }
  }

  _terminateChild() {
    if (this._childTerminated || !this._child || this._hasExited(this._child)) return
    this._childTerminated = true
    try { this._child.kill?.() } catch {}
  }

  _hasExited(child) {
    return this._childExited || child?.exitCode != null || child?.signalCode != null
  }

  _resolveStart(value) {
    const settle = this._settleStart
    this._settleStart = null
    settle?.resolve(value)
  }

  _rejectStart(error) {
    this._startFailed = true
    const settle = this._settleStart
    this._settleStart = null
    settle?.reject(error)
  }

  _resolveStop(value) {
    const settle = this._takeStopSettle()
    settle?.resolve(value)
  }

  _rejectStop(error) {
    const settle = this._takeStopSettle()
    settle?.reject(error)
  }

  _takeStopSettle() {
    const settle = this._settleStop
    this._settleStop = null
    if (settle?.timer) clearTimeout(settle.timer)
    settle?.cleanup?.()
    return settle
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isNonNegativeNumber(value) {
  return Number.isFinite(value) && value >= 0
}

function normalizeStopTimeout(value) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : DEFAULT_STOP_TIMEOUT_MS
}

export function createVideoError(code, message, cause) {
  const error = new Error(message)
  error.code = code
  if (cause) error.cause = cause
  return error
}
