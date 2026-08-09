const { execFile } = require('child_process')
const { access, mkdir, rename, rm } = require('fs/promises')
const { join } = require('path')

const RECORDER_APP_NAME = 'Browser Forge Recorder.app'

async function defaultRunCommand(command, args) {
  await new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (!error) return resolve({ stdout, stderr })
      error.stdout = stdout
      error.stderr = stderr
      reject(error)
    })
  })
}

function resolveAppPath(outputPath) {
  return outputPath.endsWith('.app') ? outputPath : join(outputPath, 'Browser Forge.app')
}

async function installMacOSRecorderHelper({
  outputPath,
  runCommand = defaultRunCommand,
  signIdentity = process.env.BROWSER_FORGE_MAC_SIGN_IDENTITY || '-'
}) {
  if (!outputPath) throw new Error('outputPath is required')
  const appPath = resolveAppPath(outputPath)
  const stagedHelper = join(appPath, 'Contents', 'Resources', 'native-tools', RECORDER_APP_NAME)
  const helpersDir = join(appPath, 'Contents', 'Helpers')
  const helperAppPath = join(helpersDir, RECORDER_APP_NAME)

  await access(stagedHelper)
  await mkdir(helpersDir, { recursive: true })
  await rm(helperAppPath, { recursive: true, force: true })
  await rename(stagedHelper, helperAppPath)

  await runCommand('codesign', ['--force', '--deep', '--sign', signIdentity, helperAppPath])
  await runCommand('codesign', ['--force', '--deep', '--sign', signIdentity, appPath])
  await runCommand('codesign', ['--verify', '--deep', '--strict', appPath])
  return { appPath, helperAppPath }
}

async function packageRecorderHelpers({ platform, outputPaths = [] } = {}, {
  installHelper = installMacOSRecorderHelper
} = {}) {
  if (platform !== 'darwin') return
  for (const outputPath of outputPaths) await installHelper({ outputPath })
}

module.exports = {
  RECORDER_APP_NAME,
  installMacOSRecorderHelper,
  packageRecorderHelpers,
  resolveAppPath
}
