import { execFile as defaultExecFile } from 'child_process'

export const BROWSER_FORGE_BUNDLE_ID = 'com.browserforge.app'
export const SCREEN_RECORDING_TCC_SERVICE = 'ScreenCapture'
const TCCUTIL_PATH = '/usr/bin/tccutil'

function executeFile(command, args, execFile = defaultExecFile) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
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


export function createMainProcessScreenRecordingPermission({
  nativeModule,
  platform = process.platform,
  arch = process.arch
} = {}) {
  const unsupported = () => ({
    supported: false,
    status: 'unsupported',
    granted: false,
    restartRequired: false,
    platform: `${platform}-${arch}`
  })

  const check = async () => {
    if (platform !== 'darwin') return unsupported()
    if (!nativeModule || typeof nativeModule.check !== 'function') {
      throw recoveryError('SCREEN_RECORDING_MAIN_ADDON_INVALID', 'Main-process screen permission addon is invalid')
    }
    let granted
    try {
      granted = nativeModule.check()
    } catch (cause) {
      throw recoveryError('SCREEN_RECORDING_PERMISSION_CHECK_FAILED', 'Unable to check Browser Forge screen recording permission', cause)
    }
    if (typeof granted !== 'boolean') {
      throw recoveryError('SCREEN_RECORDING_MAIN_ADDON_INVALID', 'Main-process screen permission check returned an invalid value')
    }
    return {
      supported: true,
      status: granted ? 'granted' : 'not-granted',
      granted,
      restartRequired: false
    }
  }

  const request = async () => {
    const current = await check()
    if (!current.supported || current.granted) return current
    if (typeof nativeModule.request !== 'function') {
      throw recoveryError('SCREEN_RECORDING_MAIN_ADDON_INVALID', 'Main-process screen permission request is unavailable')
    }
    let accepted
    try {
      accepted = nativeModule.request()
    } catch (cause) {
      throw recoveryError('SCREEN_RECORDING_PERMISSION_REQUEST_FAILED', 'Unable to request Browser Forge screen recording permission', cause)
    }
    if (typeof accepted !== 'boolean') {
      throw recoveryError('SCREEN_RECORDING_MAIN_ADDON_INVALID', 'Main-process screen permission request returned an invalid value')
    }
    return accepted
      ? { supported: true, status: 'restart-required', granted: false, restartRequired: true }
      : { supported: true, status: 'manual-authorization-required', granted: false, restartRequired: false }
  }

  return { check, request }
}

export async function resetBrowserForgeScreenRecordingPermission({
  platform = process.platform,
  execute = (command, args) => executeFile(command, args)
} = {}) {
  if (platform !== 'darwin') {
    throw recoveryError(
      'SCREEN_RECORDING_RESET_UNSUPPORTED',
      `Screen recording permission reset is not supported on ${platform}`
    )
  }

  try {
    await execute(TCCUTIL_PATH, ['reset', SCREEN_RECORDING_TCC_SERVICE, BROWSER_FORGE_BUNDLE_ID])
  } catch (cause) {
    throw recoveryError(
      'SCREEN_RECORDING_RESET_FAILED',
      'Unable to reset Browser Forge screen recording permission',
      cause
    )
  }

  return {
    ok: true,
    service: SCREEN_RECORDING_TCC_SERVICE,
    bundleId: BROWSER_FORGE_BUNDLE_ID
  }
}

function recoveryError(code, message, cause) {
  const error = new Error(message)
  error.code = code
  if (cause) error.cause = cause
  return error
}
