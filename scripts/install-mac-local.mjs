import { spawn } from 'child_process'
import { access, rm } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { resetBrowserForgeScreenRecordingPermission } from '../src/main/screen-recording-recovery.js'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_SOURCE_APP = join(projectRoot, 'dist', 'Browser Forge-darwin-arm64', 'Browser Forge.app')
const DEFAULT_TARGET_APP = '/Applications/Browser Forge.app'
const LSREGISTER_PATH = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

function runCommand(command, args, { cwd = projectRoot, allowFailure = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0 || allowFailure) {
        resolvePromise({ code, stdout, stderr })
        return
      }
      const error = new Error(`${command} exited with code ${code}: ${stderr.trim()}`)
      error.code = 'LOCAL_MAC_INSTALL_COMMAND_FAILED'
      error.exitCode = code
      error.stdout = stdout
      error.stderr = stderr
      reject(error)
    })
  })
}

async function isBrowserForgeRunning() {
  const result = await runCommand('/usr/bin/pgrep', ['-x', 'Browser Forge'], { allowFailure: true })
  return result.code === 0
}

async function waitUntilStopped(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!await isBrowserForgeRunning()) return true
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200))
  }
  return !await isBrowserForgeRunning()
}

async function quitInstalledBrowserForge() {
  if (!await isBrowserForgeRunning()) return
  await runCommand('/usr/bin/osascript', ['-e', 'tell application id "com.browserforge.app" to quit'], { allowFailure: true })
  if (await waitUntilStopped(8000)) return
  await runCommand('/usr/bin/pkill', ['-TERM', '-x', 'Browser Forge'], { allowFailure: true })
  if (await waitUntilStopped(3000)) return
  const error = new Error('Browser Forge did not exit before local installation')
  error.code = 'LOCAL_MAC_INSTALL_APP_STILL_RUNNING'
  throw error
}

async function buildPackagedApp() {
  await runCommand('npm', ['run', 'package:mac'])
}

async function replaceInstalledApp({ sourceApp, targetApp }) {
  await access(sourceApp)
  await rm(targetApp, { recursive: true, force: true })
  await runCommand('/usr/bin/ditto', [sourceApp, targetApp])
}

async function registerInstalledApp(targetApp) {
  await runCommand(LSREGISTER_PATH, ['-f', targetApp])
}

async function launchInstalledApp(targetApp) {
  await runCommand('/usr/bin/open', ['-a', targetApp])
}

export async function installMacLocal({
  platform = process.platform,
  sourceApp = DEFAULT_SOURCE_APP,
  targetApp = DEFAULT_TARGET_APP,
  buildApp = buildPackagedApp,
  quitApp = quitInstalledBrowserForge,
  resetPermission = () => resetBrowserForgeScreenRecordingPermission({ platform }),
  replaceApp = replaceInstalledApp,
  registerApp = registerInstalledApp,
  launchApp = launchInstalledApp
} = {}) {
  if (platform !== 'darwin') {
    const error = new Error(`Local macOS installation is not supported on ${platform}`)
    error.code = 'LOCAL_MAC_INSTALL_UNSUPPORTED'
    throw error
  }

  const resolvedSource = resolve(sourceApp)
  const resolvedTarget = resolve(targetApp)
  await buildApp()
  await quitApp()
  await resetPermission()
  await replaceApp({ sourceApp: resolvedSource, targetApp: resolvedTarget })
  await registerApp(resolvedTarget)
  await launchApp(resolvedTarget)
  return { ok: true, sourceApp: resolvedSource, targetApp: resolvedTarget }
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--source-app') options.sourceApp = argv[++index]
    else if (argv[index] === '--target-app') options.targetApp = argv[++index]
    else if (argv[index] === '--skip-build') options.buildApp = async () => {}
    else throw new Error(`Unknown argument: ${argv[index]}`)
  }
  return options
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  installMacLocal(parseArgs(process.argv.slice(2)))
    .then(result => {
      console.log(`Installed ${result.sourceApp} to ${result.targetApp}`)
      console.log('Browser Forge screen recording permission was reset. In System Settings, turn Browser Forge off and on, complete Touch ID/password confirmation, then restart the App.')
    })
    .catch(error => {
      console.error(error.message)
      process.exitCode = 1
    })
}
