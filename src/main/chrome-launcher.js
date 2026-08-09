import { spawn } from 'child_process'
import { createServer } from 'http'
import { existsSync } from 'fs'

const CHROME_PATHS = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ]
}

export async function findChromePath() {
  const candidates = CHROME_PATHS[process.platform] ?? []
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return 'google-chrome'
}

export async function findAvailablePort({ host = '127.0.0.1' } = {}) {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  const { port } = server.address()
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

export function buildChromeArgs({ port, userDataDir, startUrl = 'about:blank' }) {
  return [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--app=${startUrl}`
  ]
}

function appendTail(existing, chunk, maxLength = 12000) {
  const next = `${existing}${chunk}`
  return next.length > maxLength ? next.slice(next.length - maxLength) : next
}

export function launchChrome({ execPath, port, userDataDir, startUrl }) {
  const args = buildChromeArgs({ port, userDataDir, startUrl })
  const chromeProcess = spawn(execPath, args, { detached: false, stdio: ['ignore', 'ignore', 'pipe'] })
  chromeProcess.browserForge = {
    execPath,
    args,
    stderrTail: ''
  }
  chromeProcess.stderr?.on?.('data', chunk => {
    chromeProcess.browserForge.stderrTail = appendTail(
      chromeProcess.browserForge.stderrTail,
      chunk.toString('utf8')
    )
  })
  return chromeProcess
}

function processExitDetails(chromeProcess) {
  const code = chromeProcess?.exitCode
  const signal = chromeProcess?.signalCode
  if (code !== null && code !== undefined) return `exit code ${code}`
  if (signal) return `signal ${signal}`
  return 'exited'
}

export async function waitForChromeDebugEndpoint({
  port,
  chromeProcess,
  timeoutMs = 20000,
  intervalMs = 300,
  fetchImpl = globalThis.fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  if (!port) throw new Error('Chrome debug port is required')
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required')

  let spawnError = null
  let exited = false
  chromeProcess?.once?.('error', error => {
    spawnError = error
  })
  chromeProcess?.once?.('exit', () => {
    exited = true
  })

  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() <= deadline) {
    if (spawnError) {
      throw new Error(`Chrome 启动失败：${spawnError.message}`)
    }
    if (exited || (chromeProcess && chromeProcess.exitCode !== null)) {
      const stderr = chromeProcess?.browserForge?.stderrTail?.trim()
      throw new Error(`Chrome 启动后提前退出（${processExitDetails(chromeProcess)}）${stderr ? `：${stderr}` : ''}`)
    }

    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) {
        const version = await response.json()
        if (version?.webSocketDebuggerUrl) return version
      }
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }

  throw new Error(`Chrome 调试端口启动超时：无法连接 127.0.0.1:${port}/json/version${lastError?.message ? `（最后错误：${lastError.message}）` : ''}`)
}
