import { execFile as defaultExecFile } from 'child_process'
import { getNativeToolExecutableName, getNativeToolPlatformKey, resolveNativeToolPath } from './native-tools.js'

const STATUS_BY_ACTION = Object.freeze({
  check: new Set(['granted', 'not-granted']),
  request: new Set(['granted', 'denied', 'restart-required'])
})

function executeFile(binaryPath, args, execFile = defaultExecFile) {
  return new Promise((resolve, reject) => {
    execFile(binaryPath, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

export class ScreenRecordingPermission {
  constructor({
    platform = process.platform,
    arch = process.arch,
    nativeToolPathOptions = {},
    getPlatformKey = options => getNativeToolPlatformKey(options),
    resolveBinaryPath = toolName => resolveNativeToolPath({ ...nativeToolPathOptions, toolName, platform, arch }),
    execute = (binaryPath, args) => executeFile(binaryPath, args)
  } = {}) {
    this.platform = platform
    this.arch = arch
    this.getPlatformKey = getPlatformKey
    this.resolveBinaryPath = resolveBinaryPath
    this.execute = execute
  }

  check() {
    return this.#run('check')
  }

  request() {
    return this.#run('request')
  }

  async #run(action) {
    const platform = `${this.platform}-${this.arch}`
    try {
      this.getPlatformKey({ platform: this.platform, arch: this.arch })
    } catch {
      return { supported: false, status: 'unsupported', granted: false, restartRequired: false, platform }
    }

    const executable = getNativeToolExecutableName({ tool: 'windowRecorder', platform: this.platform, arch: this.arch })
    const binaryPath = this.resolveBinaryPath(executable)
    let result
    try {
      result = await this.execute(binaryPath, [`--${action}-permission`])
    } catch (cause) {
      throw createPermissionError(
        `SCREEN_RECORDING_PERMISSION_${action.toUpperCase()}_FAILED`,
        `Unable to ${action} macOS screen recording permission`,
        cause
      )
    }

    try {
      const message = parsePermissionMessage(result?.stdout, action)
      return {
        supported: true,
        status: message.status,
        granted: message.granted,
        restartRequired: message.restartRequired
      }
    } catch (cause) {
      if (cause?.code === 'SCREEN_RECORDING_PERMISSION_PROTOCOL_ERROR') throw cause
      throw createPermissionError('SCREEN_RECORDING_PERMISSION_PROTOCOL_ERROR', 'Invalid native screen recording permission response', cause)
    }
  }
}

function parsePermissionMessage(stdout, action) {
  const lines = String(stdout ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (lines.length !== 1) throw createPermissionError('SCREEN_RECORDING_PERMISSION_PROTOCOL_ERROR', 'Native permission response must contain exactly one JSON line')
  let message
  try {
    message = JSON.parse(lines[0])
  } catch (cause) {
    throw createPermissionError('SCREEN_RECORDING_PERMISSION_PROTOCOL_ERROR', 'Native permission response is not valid JSON', cause)
  }
  if (
    message?.type !== 'screen-recording-permission' ||
    message.action !== action ||
    !STATUS_BY_ACTION[action]?.has(message.status) ||
    typeof message.granted !== 'boolean' ||
    typeof message.restartRequired !== 'boolean' ||
    message.granted !== (message.status === 'granted') ||
    message.restartRequired !== (message.status === 'restart-required')
  ) {
    throw createPermissionError('SCREEN_RECORDING_PERMISSION_PROTOCOL_ERROR', 'Native permission response fields are inconsistent')
  }
  return message
}

function createPermissionError(code, message, cause) {
  const error = new Error(message)
  error.code = code
  if (cause) error.cause = cause
  return error
}
