import { spawn } from 'child_process'
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

export function buildChromeArgs({ port, userDataDir }) {
  return [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank'  // 确保打开一个可见的窗口
  ]
}

export function launchChrome({ execPath, port, userDataDir }) {
  const args = buildChromeArgs({ port, userDataDir })
  return spawn(execPath, args, { detached: false, stdio: 'ignore' })
}
