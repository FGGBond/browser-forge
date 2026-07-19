# browser-forge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an Electron desktop app that launches the user's local Chrome via `--remote-debugging-port`, records a full browser session via CDP, and outputs structured artifacts (HAR + DOM snapshots + screenshots + JS files + events) to a local directory with a generated `RECORDING.md` index.

**Architecture:** The app has two layers: a CDP recorder engine (pure Node.js, no Electron dependency) that connects to Chrome over WebSocket and streams all artifacts to disk; and an Electron control panel UI that launches Chrome, starts/stops the recorder, and displays session status. The recorder engine is tested independently using a headless Chrome fixture.

**Tech Stack:** Electron 28+, Node.js, `chrome-remote-interface` (CDP client), Vitest (unit tests), Playwright (integration test fixture for headless Chrome)

---

## File Map

```
browser-forge/
├── package.json
├── electron.vite.config.js
├── src/
│   ├── main/
│   │   ├── index.js               # Electron main entry — app lifecycle, IPC wiring
│   │   ├── chrome-launcher.js     # Launch/kill Chrome with --remote-debugging-port
│   │   ├── recorder/
│   │   │   ├── index.js           # RecordingSession: start/stop, coordinates all collectors
│   │   │   ├── cdp-client.js      # CDP WebSocket connection + Target management
│   │   │   ├── collectors/
│   │   │   │   ├── network.js     # Network domain — builds HAR entries
│   │   │   │   ├── dom.js         # DOM snapshots on frameNavigated
│   │   │   │   ├── screenshots.js # Screenshots on key events
│   │   │   │   ├── scripts.js     # JS file capture + dedup
│   │   │   │   ├── events.js      # User interaction events
│   │   │   │   └── console.js     # Runtime console + exceptions
│   │   │   ├── har-builder.js     # Assembles HAR 1.2 from network collector data
│   │   │   ├── timeline-builder.js# Assembles timeline.json from all collectors
│   │   │   └── output-writer.js   # Writes all artifacts to session directory + RECORDING.md
│   │   └── ipc-handlers.js        # IPC handlers: start-recording, stop-recording, open-folder
│   └── renderer/
│       ├── index.html
│       └── src/
│           ├── App.jsx            # Root — routes between Setup / Recording / Done views
│           ├── views/
│           │   ├── Setup.jsx      # Chrome path config + output dir picker
│           │   ├── Recording.jsx  # Tab list, elapsed time, artifact size, Stop button
│           │   └── Done.jsx       # Output path, Open in Finder, Copy Path buttons
│           └── store.js           # Shared state (recording status, tab list, stats)
├── tests/
│   ├── unit/
│   │   ├── har-builder.test.js
│   │   ├── timeline-builder.test.js
│   │   ├── output-writer.test.js
│   │   └── collectors/
│   │       ├── network.test.js
│   │       ├── dom.test.js
│   │       └── events.test.js
│   └── integration/
│       └── recorder.test.js       # Spins up headless Chrome, records a simple session
└── docs/
    └── superpowers/
        ├── specs/2026-07-17-browser-forge-design.md
        └── plans/2026-07-17-browser-forge.md
```

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `electron.vite.config.js`
- Create: `src/main/index.js`
- Create: `src/renderer/index.html`
- Create: `src/renderer/src/App.jsx`

- [ ] **Step 1: Initialize project**

```bash
cd /Users/zhukai.129/CodeSpace/claude-workspace/browser-forge
npm init -y
```

- [ ] **Step 2: Install dependencies**

```bash
npm install electron electron-vite react react-dom chrome-remote-interface
npm install -D vitest @vitest/coverage-v8 playwright
```

- [ ] **Step 3: Write package.json scripts**

Replace the `scripts` section of `package.json`:

```json
{
  "name": "browser-forge",
  "version": "0.1.0",
  "main": "out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "chrome-remote-interface": "^0.33.0",
    "electron": "^28.0.0",
    "react": "^18.0.0",
    "react-dom": "^18.0.0"
  },
  "devDependencies": {
    "@vitest/coverage-v8": "^1.0.0",
    "electron-vite": "^2.0.0",
    "playwright": "^1.40.0",
    "vitest": "^1.0.0"
  }
}
```

- [ ] **Step 4: Write electron.vite.config.js**

```js
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: { build: { outDir: 'out/main' } },
  preload: { build: { outDir: 'out/preload' } },
  renderer: {
    build: { outDir: 'out/renderer' },
    resolve: { extensions: ['.jsx', '.js'] }
  }
})
```

- [ ] **Step 5: Write src/main/index.js (Electron entry)**

```js
import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { registerIpcHandlers } from './ipc-handlers.js'

function createWindow() {
  const win = new BrowserWindow({
    width: 480,
    height: 600,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true
    }
  })
  if (process.env.NODE_ENV === 'development') {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerIpcHandlers()
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
```

- [ ] **Step 6: Write src/renderer/index.html**

```html
<!DOCTYPE html>
<html>
  <head><meta charset="UTF-8" /><title>browser-forge</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="./src/main.jsx"></script>
  </body>
</html>
```

- [ ] **Step 7: Write src/renderer/src/App.jsx (stub)**

```jsx
export default function App() {
  return <div style={{ fontFamily: 'sans-serif', padding: 24 }}>browser-forge</div>
}
```

- [ ] **Step 8: Write src/renderer/src/main.jsx**

```jsx
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
createRoot(document.getElementById('root')).render(<App />)
```

- [ ] **Step 9: Verify app launches**

```bash
npm run dev
```

Expected: Electron window opens with "browser-forge" text. No console errors.

- [ ] **Step 10: Commit**

```bash
git init
git add package.json electron.vite.config.js src/
git commit -m "feat: scaffold Electron project"
```

---

## Task 2: Chrome Launcher

**Files:**
- Create: `src/main/chrome-launcher.js`
- Test: `tests/unit/chrome-launcher.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/chrome-launcher.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { findChromePath, buildChromeArgs } from '../../src/main/chrome-launcher.js'

describe('buildChromeArgs', () => {
  it('includes remote-debugging-port', () => {
    const args = buildChromeArgs({ port: 9222, userDataDir: '/tmp/test' })
    expect(args).toContain('--remote-debugging-port=9222')
  })

  it('includes user-data-dir', () => {
    const args = buildChromeArgs({ port: 9222, userDataDir: '/tmp/test' })
    expect(args.some(a => a.startsWith('--user-data-dir='))).toBe(true)
  })
})

describe('findChromePath', () => {
  it('returns a string path', async () => {
    const path = await findChromePath()
    expect(typeof path).toBe('string')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test tests/unit/chrome-launcher.test.js
```

Expected: FAIL — `chrome-launcher.js` not found.

- [ ] **Step 3: Implement chrome-launcher.js**

```js
// src/main/chrome-launcher.js
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const execFileAsync = promisify(execFile)

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
    '--no-default-browser-check'
  ]
}

export function launchChrome({ execPath, port, userDataDir }) {
  const args = buildChromeArgs({ port, userDataDir })
  return spawn(execPath, args, { detached: false, stdio: 'ignore' })
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test tests/unit/chrome-launcher.test.js
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/chrome-launcher.js tests/unit/chrome-launcher.test.js
git commit -m "feat: chrome launcher with auto-detect and arg builder"
```

---

## Task 3: CDP Client + Target Manager

**Files:**
- Create: `src/main/recorder/cdp-client.js`
- Test: `tests/unit/cdp-client.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/cdp-client.test.js
import { describe, it, expect, vi } from 'vitest'
import { CdpClient } from '../../src/main/recorder/cdp-client.js'

describe('CdpClient', () => {
  it('can be constructed with a port', () => {
    const client = new CdpClient({ port: 9222 })
    expect(client.port).toBe(9222)
  })

  it('tracks attached targets', () => {
    const client = new CdpClient({ port: 9222 })
    expect(client.getTargets()).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test tests/unit/cdp-client.test.js
```

Expected: FAIL.

- [ ] **Step 3: Implement cdp-client.js**

```js
// src/main/recorder/cdp-client.js
import CDP from 'chrome-remote-interface'

export class CdpClient {
  constructor({ port = 9222 } = {}) {
    this.port = port
    this._targets = new Map() // targetId -> { session, info }
    this._browser = null
  }

  getTargets() {
    return Array.from(this._targets.values()).map(t => t.info)
  }

  async connect() {
    this._browser = await CDP({ port: this.port })
    await this._browser.Target.setDiscoverTargets({ discover: true })

    this._browser.Target.targetCreated(({ targetInfo }) => {
      if (targetInfo.type === 'page') this._attachTarget(targetInfo)
    })

    this._browser.Target.targetDestroyed(({ targetId }) => {
      this._targets.delete(targetId)
    })

    const { targetInfos } = await this._browser.Target.getTargets()
    for (const info of targetInfos.filter(t => t.type === 'page')) {
      await this._attachTarget(info)
    }
  }

  async _attachTarget(targetInfo) {
    const { sessionId } = await this._browser.Target.attachToTarget({
      targetId: targetInfo.targetId,
      flatten: true
    })
    const session = await CDP({ port: this.port, sessionId })
    this._targets.set(targetInfo.targetId, { session, info: targetInfo })
    this.onTargetAttached?.(targetInfo.targetId, session)
  }

  async disconnect() {
    for (const { session } of this._targets.values()) {
      await session.close().catch(() => {})
    }
    await this._browser?.close().catch(() => {})
    this._targets.clear()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test tests/unit/cdp-client.test.js
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/recorder/cdp-client.js tests/unit/cdp-client.test.js
git commit -m "feat: CDP client with multi-target management"
```

---

## Task 4: Network Collector + HAR Builder

**Files:**
- Create: `src/main/recorder/collectors/network.js`
- Create: `src/main/recorder/har-builder.js`
- Test: `tests/unit/collectors/network.test.js`
- Test: `tests/unit/har-builder.test.js`

- [ ] **Step 1: Write failing tests**

```js
// tests/unit/collectors/network.test.js
import { describe, it, expect } from 'vitest'
import { NetworkCollector } from '../../../src/main/recorder/collectors/network.js'

describe('NetworkCollector', () => {
  it('records a request entry on requestWillBeSent', () => {
    const col = new NetworkCollector({ targetId: 't1', maxBodyBytes: 10_000_000 })
    col.onRequestWillBeSent({
      requestId: 'r1',
      request: { url: 'https://example.com/', method: 'GET', headers: {} },
      timestamp: 1000,
      type: 'Document'
    })
    expect(col.getEntries()).toHaveLength(1)
    expect(col.getEntries()[0].requestId).toBe('r1')
  })

  it('attaches response data on responseReceived', () => {
    const col = new NetworkCollector({ targetId: 't1', maxBodyBytes: 10_000_000 })
    col.onRequestWillBeSent({
      requestId: 'r1',
      request: { url: 'https://example.com/', method: 'GET', headers: {} },
      timestamp: 1000,
      type: 'Document'
    })
    col.onResponseReceived({
      requestId: 'r1',
      response: { url: 'https://example.com/', status: 200, headers: {}, mimeType: 'text/html' },
      timestamp: 1050
    })
    expect(col.getEntries()[0].response.status).toBe(200)
  })
})
```

```js
// tests/unit/har-builder.test.js
import { describe, it, expect } from 'vitest'
import { buildHar } from '../../src/main/recorder/har-builder.js'

describe('buildHar', () => {
  it('produces valid HAR 1.2 envelope', () => {
    const har = buildHar({ entries: [], pages: [], startedDateTime: '2026-07-17T14:32:00.000Z' })
    expect(har.log.version).toBe('1.2')
    expect(har.log.creator.name).toBe('browser-forge')
    expect(Array.isArray(har.log.entries)).toBe(true)
  })

  it('includes provided entries', () => {
    const entry = { startedDateTime: '2026-07-17T14:32:01.000Z', time: 50, request: {}, response: {} }
    const har = buildHar({ entries: [entry], pages: [], startedDateTime: '2026-07-17T14:32:00.000Z' })
    expect(har.log.entries).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

```bash
npm test tests/unit/collectors/network.test.js tests/unit/har-builder.test.js
```

Expected: FAIL.

- [ ] **Step 3: Implement network.js**

```js
// src/main/recorder/collectors/network.js
export class NetworkCollector {
  constructor({ targetId, maxBodyBytes = 10_000_000 }) {
    this.targetId = targetId
    this.maxBodyBytes = maxBodyBytes
    this._entries = new Map() // requestId -> entry
  }

  onRequestWillBeSent({ requestId, request, timestamp, type }) {
    this._entries.set(requestId, {
      requestId,
      startedTimestamp: timestamp,
      type,
      request: { url: request.url, method: request.method, headers: request.headers, postData: request.postData },
      response: null,
      body: null,
      bodyTooLarge: false
    })
  }

  onResponseReceived({ requestId, response, timestamp }) {
    const entry = this._entries.get(requestId)
    if (!entry) return
    entry.response = {
      status: response.status,
      statusText: response.statusText ?? '',
      headers: response.headers,
      mimeType: response.mimeType,
      url: response.url
    }
    entry.responseTimestamp = timestamp
  }

  onLoadingFinished({ requestId }) {
    const entry = this._entries.get(requestId)
    if (entry) entry.loadingFinished = true
  }

  setBody(requestId, body, base64Encoded) {
    const entry = this._entries.get(requestId)
    if (!entry) return
    const bytes = base64Encoded ? Buffer.from(body, 'base64').length : Buffer.byteLength(body)
    if (bytes > this.maxBodyBytes) {
      entry.bodyTooLarge = true
    } else {
      entry.body = body
      entry.bodyBase64 = base64Encoded
    }
  }

  getEntries() {
    return Array.from(this._entries.values())
  }
}
```

- [ ] **Step 4: Implement har-builder.js**

```js
// src/main/recorder/har-builder.js
export function buildHar({ entries, pages, startedDateTime }) {
  return {
    log: {
      version: '1.2',
      creator: { name: 'browser-forge', version: '0.1.0' },
      pages,
      entries: entries.map(e => ({
        startedDateTime: e.startedDateTime ?? startedDateTime,
        time: e.time ?? -1,
        request: {
          method: e.request?.method ?? 'GET',
          url: e.request?.url ?? '',
          httpVersion: 'HTTP/1.1',
          headers: headersObjectToHar(e.request?.headers ?? {}),
          queryString: [],
          cookies: [],
          headersSize: -1,
          bodySize: e.request?.postData ? Buffer.byteLength(e.request.postData) : 0,
          postData: e.request?.postData ? { mimeType: 'application/octet-stream', text: e.request.postData } : undefined
        },
        response: {
          status: e.response?.status ?? 0,
          statusText: e.response?.statusText ?? '',
          httpVersion: 'HTTP/1.1',
          headers: headersObjectToHar(e.response?.headers ?? {}),
          cookies: [],
          content: {
            size: e.body ? Buffer.byteLength(e.body) : -1,
            mimeType: e.response?.mimeType ?? 'application/octet-stream',
            text: e.bodyTooLarge ? undefined : e.body,
            comment: e.bodyTooLarge ? 'body_too_large' : undefined,
            encoding: e.bodyBase64 ? 'base64' : undefined
          },
          redirectURL: '',
          headersSize: -1,
          bodySize: -1
        },
        cache: {},
        timings: { send: 0, wait: e.time ?? -1, receive: 0 }
      }))
    }
  }
}

function headersObjectToHar(headers) {
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }))
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test tests/unit/collectors/network.test.js tests/unit/har-builder.test.js
```

Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/main/recorder/collectors/network.js src/main/recorder/har-builder.js tests/unit/collectors/network.test.js tests/unit/har-builder.test.js
git commit -m "feat: network collector and HAR 1.2 builder"
```

---

## Task 5: DOM, Screenshots, Scripts, Events, Console Collectors

**Files:**
- Create: `src/main/recorder/collectors/dom.js`
- Create: `src/main/recorder/collectors/screenshots.js`
- Create: `src/main/recorder/collectors/scripts.js`
- Create: `src/main/recorder/collectors/events.js`
- Create: `src/main/recorder/collectors/console.js`
- Test: `tests/unit/collectors/dom.test.js`
- Test: `tests/unit/collectors/events.test.js`

- [ ] **Step 1: Write failing tests**

```js
// tests/unit/collectors/dom.test.js
import { describe, it, expect } from 'vitest'
import { DomCollector } from '../../../src/main/recorder/collectors/dom.js'

describe('DomCollector', () => {
  it('stores a snapshot with timestamp and html', () => {
    const col = new DomCollector({ targetId: 't1' })
    col.addSnapshot({ timestamp: 1000, html: '<html></html>', url: 'https://example.com/' })
    expect(col.getSnapshots()).toHaveLength(1)
    expect(col.getSnapshots()[0].html).toBe('<html></html>')
  })
})
```

```js
// tests/unit/collectors/events.test.js
import { describe, it, expect } from 'vitest'
import { EventsCollector } from '../../../src/main/recorder/collectors/events.js'

describe('EventsCollector', () => {
  it('records a click event', () => {
    const col = new EventsCollector({ targetId: 't1' })
    col.addEvent({ type: 'click', timestamp: 1000, selector: '#btn', x: 100, y: 200 })
    expect(col.getEvents()).toHaveLength(1)
    expect(col.getEvents()[0].type).toBe('click')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

```bash
npm test tests/unit/collectors/dom.test.js tests/unit/collectors/events.test.js
```

Expected: FAIL.

- [ ] **Step 3: Implement dom.js**

```js
// src/main/recorder/collectors/dom.js
export class DomCollector {
  constructor({ targetId }) {
    this.targetId = targetId
    this._snapshots = []
  }

  addSnapshot({ timestamp, html, url }) {
    this._snapshots.push({ timestamp, html, url })
  }

  getSnapshots() {
    return this._snapshots
  }
}
```

- [ ] **Step 4: Implement screenshots.js**

```js
// src/main/recorder/collectors/screenshots.js
export class ScreenshotsCollector {
  constructor({ targetId }) {
    this.targetId = targetId
    this._screenshots = [] // { timestamp, dataBase64 }
  }

  addScreenshot({ timestamp, dataBase64 }) {
    this._screenshots.push({ timestamp, dataBase64 })
  }

  getScreenshots() {
    return this._screenshots
  }
}
```

- [ ] **Step 5: Implement scripts.js**

```js
// src/main/recorder/collectors/scripts.js
import { createHash } from 'crypto'

export class ScriptsCollector {
  constructor({ targetId }) {
    this.targetId = targetId
    this._scripts = new Map() // hash -> { url, content }
  }

  addScript({ url, content }) {
    const hash = createHash('sha1').update(content).digest('hex').slice(0, 12)
    if (!this._scripts.has(hash)) {
      this._scripts.set(hash, { url, content, hash })
    }
  }

  getScripts() {
    return Array.from(this._scripts.values())
  }
}
```

- [ ] **Step 6: Implement events.js**

```js
// src/main/recorder/collectors/events.js
export class EventsCollector {
  constructor({ targetId }) {
    this.targetId = targetId
    this._events = []
  }

  addEvent(event) {
    this._events.push(event)
  }

  getEvents() {
    return this._events
  }
}
```

- [ ] **Step 7: Implement console.js**

```js
// src/main/recorder/collectors/console.js
export class ConsoleCollector {
  constructor({ targetId }) {
    this.targetId = targetId
    this._entries = []
  }

  addEntry({ type, args, timestamp, stackTrace }) {
    this._entries.push({ type, args, timestamp, stackTrace })
  }

  getEntries() {
    return this._entries
  }
}
```

- [ ] **Step 8: Run tests to verify they pass**

```bash
npm test tests/unit/collectors/
```

Expected: PASS (all collector tests).

- [ ] **Step 9: Commit**

```bash
git add src/main/recorder/collectors/ tests/unit/collectors/
git commit -m "feat: DOM, screenshots, scripts, events, console collectors"
```

---

## Task 6: Timeline Builder

**Files:**
- Create: `src/main/recorder/timeline-builder.js`
- Test: `tests/unit/timeline-builder.test.js`

- [ ] **Step 1: Write failing test**

```js
// tests/unit/timeline-builder.test.js
import { describe, it, expect } from 'vitest'
import { buildTimeline } from '../../src/main/recorder/timeline-builder.js'

describe('buildTimeline', () => {
  it('merges events from multiple tabs sorted by timestamp', () => {
    const events = [
      { timestamp: 2000, type: 'click', targetId: 't2' },
      { timestamp: 1000, type: 'navigation', targetId: 't1', url: 'https://a.com' },
      { timestamp: 3000, type: 'tab-switch', fromTargetId: 't1', toTargetId: 't2' }
    ]
    const timeline = buildTimeline(events)
    expect(timeline[0].timestamp).toBe(1000)
    expect(timeline[1].timestamp).toBe(2000)
    expect(timeline[2].timestamp).toBe(3000)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test tests/unit/timeline-builder.test.js
```

Expected: FAIL.

- [ ] **Step 3: Implement timeline-builder.js**

```js
// src/main/recorder/timeline-builder.js
export function buildTimeline(events) {
  return [...events].sort((a, b) => a.timestamp - b.timestamp)
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test tests/unit/timeline-builder.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/recorder/timeline-builder.js tests/unit/timeline-builder.test.js
git commit -m "feat: timeline builder"
```

---

## Task 7: Output Writer + RECORDING.md Generator

**Files:**
- Create: `src/main/recorder/output-writer.js`
- Test: `tests/unit/output-writer.test.js`

- [ ] **Step 1: Write failing test**

```js
// tests/unit/output-writer.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { join, tmpdir } from 'path'
import { writeSession } from '../../src/main/recorder/output-writer.js'

let tmpDir

beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'bf-test-')) })
afterEach(() => { rmSync(tmpDir, { recursive: true }) })

describe('writeSession', () => {
  it('creates RECORDING.md', async () => {
    await writeSession({
      outputDir: tmpDir,
      sessionName: 'session-test',
      metadata: { startUrl: 'https://example.com', durationMs: 5000, chromeVersion: '120', tabs: [] },
      har: { log: { version: '1.2', creator: { name: 'browser-forge', version: '0.1.0' }, pages: [], entries: [] } },
      timeline: [],
      tabs: {}
    })
    expect(existsSync(join(tmpDir, 'RECORDING.md'))).toBe(true)
  })

  it('creates recording.har', async () => {
    await writeSession({
      outputDir: tmpDir,
      sessionName: 'session-test',
      metadata: { startUrl: 'https://example.com', durationMs: 5000, chromeVersion: '120', tabs: [] },
      har: { log: { version: '1.2', creator: { name: 'browser-forge', version: '0.1.0' }, pages: [], entries: [] } },
      timeline: [],
      tabs: {}
    })
    expect(existsSync(join(tmpDir, 'recording.har'))).toBe(true)
  })

  it('RECORDING.md contains start URL', async () => {
    await writeSession({
      outputDir: tmpDir,
      sessionName: 'session-test',
      metadata: { startUrl: 'https://example.com', durationMs: 5000, chromeVersion: '120', tabs: [] },
      har: { log: { version: '1.2', creator: { name: 'browser-forge', version: '0.1.0' }, pages: [], entries: [] } },
      timeline: [],
      tabs: {}
    })
    const content = readFileSync(join(tmpDir, 'RECORDING.md'), 'utf-8')
    expect(content).toContain('https://example.com')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test tests/unit/output-writer.test.js
```

Expected: FAIL.

- [ ] **Step 3: Implement output-writer.js**

```js
// src/main/recorder/output-writer.js
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'

export async function writeSession({ outputDir, sessionName, metadata, har, timeline, tabs }) {
  const sessionDir = join(outputDir, sessionName)
  await mkdir(sessionDir, { recursive: true })

  await writeFile(join(sessionDir, 'recording.har'), JSON.stringify(har, null, 2))
  await writeFile(join(sessionDir, 'timeline.json'), JSON.stringify(timeline, null, 2))
  await writeFile(join(sessionDir, 'metadata.json'), JSON.stringify(metadata, null, 2))

  const tabDirs = []
  for (const [targetId, tabData] of Object.entries(tabs)) {
    const safeName = `${targetId}-${sanitizeName(tabData.title ?? 'untitled')}`
    const tabDir = join(sessionDir, 'tabs', safeName)
    await mkdir(join(tabDir, 'screenshots'), { recursive: true })
    await mkdir(join(tabDir, 'scripts'), { recursive: true })

    await writeFile(join(tabDir, 'events.json'), JSON.stringify(tabData.events ?? [], null, 2))
    await writeFile(join(tabDir, 'console.json'), JSON.stringify(tabData.console ?? [], null, 2))

    for (const snap of (tabData.domSnapshots ?? [])) {
      await writeFile(join(tabDir, `dom-${snap.timestamp}.html`), snap.html)
    }

    for (const ss of (tabData.screenshots ?? [])) {
      await writeFile(join(tabDir, 'screenshots', `${ss.timestamp}.png`), Buffer.from(ss.dataBase64, 'base64'))
    }

    for (const script of (tabData.scripts ?? [])) {
      const scriptPath = urlToFilePath(script.url)
      const scriptFile = join(tabDir, 'scripts', scriptPath)
      await mkdir(join(tabFile, '..'), { recursive: true }).catch(() => {})
      await writeFile(scriptFile, script.content).catch(() => {})
    }

    tabDirs.push(safeName)
  }

  const durationSec = Math.round((metadata.durationMs ?? 0) / 1000)
  const durationStr = `${Math.floor(durationSec / 60)}分${durationSec % 60}秒`
  const harEntryCount = har.log.entries.length

  const recording = [
    '# browser-forge 录制物料',
    '',
    `录制时间：${metadata.startedAt ?? ''}`,
    `起始 URL：${metadata.startUrl}`,
    `时长：${durationStr} | Tab 数量：${metadata.tabs.length} | 网络请求：${harEntryCount}个`,
    '',
    '## 目录结构',
    `${sessionName}/`,
    '├── RECORDING.md',
    '├── recording.har         HAR 1.2 格式，含所有 Tab 的网络请求',
    '├── timeline.json         全局事件时间线',
    '├── metadata.json         录制元数据',
    '└── tabs/',
    ...tabDirs.map((d, i) => `    ${i === tabDirs.length - 1 ? '└' : '├'}── ${d}/`),
    '',
    '## 文件说明',
    '- `recording.har` — 全部网络请求和响应，HAR 1.2 格式，含 headers、body、状态码、时序',
    '- `timeline.json` — 全局事件时间线，包含 Tab 创建/关闭/切换、页面导航、用户交互，按时间戳排列',
    '- `metadata.json` — 录制元数据：起始 URL、录制时长、Chrome 版本、Tab 列表（targetId + 标题 + URL）',
    '- `tabs/{tab}/events.json` — 该 Tab 内的用户交互事件序列（点击、输入、滚动），含目标元素选择器和时间戳',
    '- `tabs/{tab}/dom-{ts}.html` — 该 Tab 在导航完成时的完整 DOM 快照，文件名中的时间戳对应导航事件',
    '- `tabs/{tab}/console.json` — 该 Tab 的 Console 输出，含 log/warn/error 级别和 JS 异常堆栈',
    '- `tabs/{tab}/screenshots/` — 关键事件时刻的截图，文件名为事件触发时的时间戳（ms）',
    '- `tabs/{tab}/scripts/` — 该 Tab 加载的 JS 文件，按原始 URL 路径结构存放，相同内容去重',
  ].join('\n')

  await writeFile(join(sessionDir, 'RECORDING.md'), recording)

  return sessionDir
}

function sanitizeName(name) {
  return name.replace(/[^a-zA-Z0-9一-龥_-]/g, '_').slice(0, 40)
}

function urlToFilePath(url) {
  try {
    const u = new URL(url)
    return (u.hostname + u.pathname).replace(/[^a-zA-Z0-9./\-_]/g, '_')
  } catch {
    return 'unknown.js'
  }
}
```

- [ ] **Step 4: Fix bug in output-writer.js**

Line `await mkdir(join(tabFile, '..'), ...)` has a typo — `tabFile` should be `scriptFile`. Fix it:

```js
      await mkdir(join(scriptFile, '..'), { recursive: true }).catch(() => {})
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test tests/unit/output-writer.test.js
```

Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/main/recorder/output-writer.js tests/unit/output-writer.test.js
git commit -m "feat: output writer and RECORDING.md generator"
```

---

## Task 8: Recording Session Orchestrator

**Files:**
- Create: `src/main/recorder/index.js`
- Test: `tests/integration/recorder.test.js`

- [ ] **Step 1: Write failing integration test**

This test spins up a real headless Chromium via Playwright, records a navigation, then verifies artifacts are written.

```js
// tests/integration/recorder.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium } from 'playwright'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { RecordingSession } from '../../src/main/recorder/index.js'

let browser, tmpDir

beforeAll(async () => {
  browser = await chromium.launch({ args: ['--remote-debugging-port=19222'] })
  tmpDir = mkdtempSync(join(tmpdir(), 'bf-int-'))
})

afterAll(async () => {
  await browser.close()
  rmSync(tmpDir, { recursive: true })
})

describe('RecordingSession', () => {
  it('writes recording.har and RECORDING.md after stop', async () => {
    const session = new RecordingSession({ port: 19222, outputDir: tmpDir })
    await session.start()
    const page = await browser.newPage()
    await page.goto('data:text/html,<h1>hello</h1>')
    await new Promise(r => setTimeout(r, 500))
    await page.close()
    const sessionDir = await session.stop()
    expect(existsSync(join(sessionDir, 'recording.har'))).toBe(true)
    expect(existsSync(join(sessionDir, 'RECORDING.md'))).toBe(true)
  }, 15000)
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test tests/integration/recorder.test.js
```

Expected: FAIL — `recorder/index.js` not found.

- [ ] **Step 3: Implement recorder/index.js**

```js
// src/main/recorder/index.js
import { CdpClient } from './cdp-client.js'
import { NetworkCollector } from './collectors/network.js'
import { DomCollector } from './collectors/dom.js'
import { ScreenshotsCollector } from './collectors/screenshots.js'
import { ScriptsCollector } from './collectors/scripts.js'
import { EventsCollector } from './collectors/events.js'
import { ConsoleCollector } from './collectors/console.js'
import { buildHar } from './har-builder.js'
import { buildTimeline } from './timeline-builder.js'
import { writeSession } from './output-writer.js'

export class RecordingSession {
  constructor({ port = 9222, outputDir }) {
    this.port = port
    this.outputDir = outputDir
    this._cdp = new CdpClient({ port })
    this._tabCollectors = new Map() // targetId -> { network, dom, screenshots, scripts, events, console, info }
    this._timelineEvents = []
    this._startedAt = null
  }

  async start() {
    this._startedAt = Date.now()
    this._cdp.onTargetAttached = (targetId, session) => this._setupTabCollectors(targetId, session)
    await this._cdp.connect()
  }

  async _setupTabCollectors(targetId, session) {
    const collectors = {
      network: new NetworkCollector({ targetId }),
      dom: new DomCollector({ targetId }),
      screenshots: new ScreenshotsCollector({ targetId }),
      scripts: new ScriptsCollector({ targetId }),
      events: new EventsCollector({ targetId }),
      console: new ConsoleCollector({ targetId }),
      info: null
    }
    this._tabCollectors.set(targetId, collectors)

    await session.Network.enable()
    await session.Page.enable()
    await session.Runtime.enable()
    await session.DOM.enable()

    session.Network.requestWillBeSent(params => collectors.network.onRequestWillBeSent(params))
    session.Network.responseReceived(params => collectors.network.onResponseReceived(params))
    session.Network.loadingFinished(async ({ requestId }) => {
      collectors.network.onLoadingFinished({ requestId })
      try {
        const { body, base64Encoded } = await session.Network.getResponseBody({ requestId })
        collectors.network.setBody(requestId, body, base64Encoded)
      } catch {}
    })

    session.Page.frameNavigated(async ({ frame }) => {
      if (frame.parentId) return
      this._timelineEvents.push({ timestamp: Date.now(), type: 'navigation', targetId, url: frame.url })
      try {
        const { root } = await session.DOM.getDocument({ depth: -1 })
        const { outerHTML } = await session.DOM.getOuterHTML({ nodeId: root.nodeId })
        collectors.dom.addSnapshot({ timestamp: Date.now(), html: outerHTML, url: frame.url })
        const { data } = await session.Page.captureScreenshot({ format: 'png' })
        collectors.screenshots.addScreenshot({ timestamp: Date.now(), dataBase64: data })
      } catch {}
    })

    session.Runtime.consoleAPICalled(({ type, args, timestamp, stackTrace }) => {
      collectors.console.addEntry({ type, args, timestamp, stackTrace })
    })
    session.Runtime.exceptionThrown(({ exceptionDetails, timestamp }) => {
      collectors.console.addEntry({ type: 'error', args: [exceptionDetails], timestamp, stackTrace: exceptionDetails.stackTrace })
    })
  }

  async stop() {
    const durationMs = Date.now() - this._startedAt
    const targets = this._cdp.getTargets()

    const tabs = {}
    for (const [targetId, c] of this._tabCollectors.entries()) {
      tabs[targetId] = {
        title: targets.find(t => t.targetId === targetId)?.title ?? 'untitled',
        events: c.events.getEvents(),
        domSnapshots: c.dom.getSnapshots(),
        screenshots: c.screenshots.getScreenshots(),
        scripts: c.scripts.getScripts(),
        console: c.console.getEntries()
      }
    }

    const allNetworkEntries = Array.from(this._tabCollectors.values())
      .flatMap(c => c.network.getEntries())

    const har = buildHar({
      entries: allNetworkEntries,
      pages: [],
      startedDateTime: new Date(this._startedAt).toISOString()
    })

    const timeline = buildTimeline(this._timelineEvents)

    const sessionName = `session-${formatDate(this._startedAt)}`
    const sessionDir = await writeSession({
      outputDir: this.outputDir,
      sessionName,
      metadata: {
        startedAt: new Date(this._startedAt).toISOString(),
        startUrl: targets[0]?.url ?? '',
        durationMs,
        chromeVersion: 'unknown',
        tabs: targets.map(t => ({ targetId: t.targetId, title: t.title, url: t.url }))
      },
      har,
      timeline,
      tabs
    })

    await this._cdp.disconnect()
    return sessionDir
  }
}

function formatDate(ts) {
  return new Date(ts).toISOString().replace('T', '-').replace(/:/g, '').slice(0, 15)
}
```

- [ ] **Step 4: Run integration test**

```bash
npm test tests/integration/recorder.test.js
```

Expected: PASS. If Chrome port 19222 is in use, kill the process first:
```bash
lsof -ti:19222 | xargs kill -9
```

- [ ] **Step 5: Commit**

```bash
git add src/main/recorder/index.js tests/integration/recorder.test.js
git commit -m "feat: recording session orchestrator with CDP wiring"
```

---

## Task 9: IPC Handlers

**Files:**
- Create: `src/main/ipc-handlers.js`

- [ ] **Step 1: Implement ipc-handlers.js**

```js
// src/main/ipc-handlers.js
import { ipcMain, shell, dialog } from 'electron'
import { findChromePath, launchChrome } from './chrome-launcher.js'
import { RecordingSession } from './recorder/index.js'
import { join } from 'path'
import { homedir } from 'os'

let chromeProcess = null
let activeSession = null

export function registerIpcHandlers() {
  ipcMain.handle('find-chrome-path', () => findChromePath())

  ipcMain.handle('pick-output-dir', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('start-recording', async (_, { chromePath, outputDir, port = 9222 }) => {
    chromeProcess = launchChrome({ execPath: chromePath, port, userDataDir: join(homedir(), '.browser-forge', 'chrome-profile') })
    await new Promise(r => setTimeout(r, 1500)) // wait for Chrome to open
    activeSession = new RecordingSession({ port, outputDir })
    await activeSession.start()
    return { ok: true }
  })

  ipcMain.handle('stop-recording', async () => {
    if (!activeSession) return { ok: false, error: 'No active session' }
    const sessionDir = await activeSession.stop()
    activeSession = null
    chromeProcess?.kill()
    chromeProcess = null
    return { ok: true, sessionDir }
  })

  ipcMain.handle('open-folder', (_, folderPath) => {
    shell.openPath(folderPath)
  })

  ipcMain.handle('get-tab-list', () => {
    return activeSession?._cdp.getTargets() ?? []
  })
}
```

- [ ] **Step 2: Commit**

```bash
git add src/main/ipc-handlers.js
git commit -m "feat: IPC handlers for recording lifecycle"
```

---

## Task 10: Renderer — Store + Setup View

**Files:**
- Create: `src/renderer/src/store.js`
- Create: `src/renderer/src/views/Setup.jsx`

- [ ] **Step 1: Implement store.js**

```js
// src/renderer/src/store.js
import { useState, useCallback } from 'react'

export function useAppStore() {
  const [view, setView] = useState('setup') // 'setup' | 'recording' | 'done'
  const [chromePath, setChromePath] = useState('')
  const [outputDir, setOutputDir] = useState('')
  const [sessionDir, setSessionDir] = useState('')
  const [tabs, setTabs] = useState([])
  const [elapsedMs, setElapsedMs] = useState(0)
  const [artifactSize, setArtifactSize] = useState(0)

  return {
    view, setView,
    chromePath, setChromePath,
    outputDir, setOutputDir,
    sessionDir, setSessionDir,
    tabs, setTabs,
    elapsedMs, setElapsedMs,
    artifactSize, setArtifactSize
  }
}
```

- [ ] **Step 2: Implement Setup.jsx**

```jsx
// src/renderer/src/views/Setup.jsx
export default function Setup({ chromePath, setChromePath, outputDir, setOutputDir, onStart }) {
  async function pickChrome() {
    const path = await window.electronAPI.findChromePath()
    setChromePath(path)
  }

  async function pickOutputDir() {
    const dir = await window.electronAPI.pickOutputDir()
    if (dir) setOutputDir(dir)
  }

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ marginBottom: 20 }}>browser-forge</h2>

      <label style={{ display: 'block', marginBottom: 8, fontSize: 13 }}>Chrome 路径</label>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          value={chromePath}
          onChange={e => setChromePath(e.target.value)}
          style={{ flex: 1, padding: '6px 8px', fontSize: 13 }}
          placeholder="自动探测..."
        />
        <button onClick={pickChrome} style={{ padding: '6px 12px' }}>探测</button>
      </div>

      <label style={{ display: 'block', marginBottom: 8, fontSize: 13 }}>录制输出目录</label>
      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        <input
          value={outputDir}
          readOnly
          style={{ flex: 1, padding: '6px 8px', fontSize: 13 }}
          placeholder="选择目录..."
        />
        <button onClick={pickOutputDir} style={{ padding: '6px 12px' }}>选择</button>
      </div>

      <button
        onClick={onStart}
        disabled={!chromePath || !outputDir}
        style={{ width: '100%', padding: '10px', fontSize: 14, background: '#1a73e8', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
      >
        启动 Chrome 并开始录制
      </button>
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/store.js src/renderer/src/views/Setup.jsx
git commit -m "feat: renderer store and Setup view"
```

---

## Task 11: Renderer — Recording + Done Views + App Wiring

**Files:**
- Create: `src/renderer/src/views/Recording.jsx`
- Create: `src/renderer/src/views/Done.jsx`
- Modify: `src/renderer/src/App.jsx`
- Create: `src/preload/index.js`

- [ ] **Step 1: Implement preload/index.js**

```js
// src/preload/index.js
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  findChromePath: () => ipcRenderer.invoke('find-chrome-path'),
  pickOutputDir: () => ipcRenderer.invoke('pick-output-dir'),
  startRecording: (opts) => ipcRenderer.invoke('start-recording', opts),
  stopRecording: () => ipcRenderer.invoke('stop-recording'),
  openFolder: (path) => ipcRenderer.invoke('open-folder', path),
  getTabList: () => ipcRenderer.invoke('get-tab-list')
})
```

- [ ] **Step 2: Implement Recording.jsx**

```jsx
// src/renderer/src/views/Recording.jsx
import { useEffect, useRef } from 'react'

export default function Recording({ tabs, elapsedMs, onStop }) {
  const minutes = Math.floor(elapsedMs / 60000)
  const seconds = Math.floor((elapsedMs % 60000) / 1000)
  const timeStr = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h2 style={{ margin: 0 }}>录制中 {timeStr}</h2>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'red', display: 'inline-block' }} />
      </div>

      <div style={{ marginBottom: 16, fontSize: 13, color: '#555' }}>已打开 Tab：{tabs.length}</div>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none', marginBottom: 24 }}>
        {tabs.map(t => (
          <li key={t.targetId} style={{ fontSize: 12, padding: '4px 0', borderBottom: '1px solid #eee', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {t.title} — <span style={{ color: '#888' }}>{t.url}</span>
          </li>
        ))}
      </ul>

      <button
        onClick={onStop}
        style={{ width: '100%', padding: 10, fontSize: 14, background: '#d93025', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
      >
        停止录制
      </button>
    </div>
  )
}
```

- [ ] **Step 3: Implement Done.jsx**

```jsx
// src/renderer/src/views/Done.jsx
export default function Done({ sessionDir, onReset }) {
  function openFolder() {
    window.electronAPI.openFolder(sessionDir)
  }

  function copyPath() {
    navigator.clipboard.writeText(sessionDir)
  }

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ marginBottom: 16 }}>录制完成</h2>
      <div style={{ fontSize: 12, color: '#555', background: '#f5f5f5', padding: 10, borderRadius: 4, marginBottom: 20, wordBreak: 'break-all' }}>
        {sessionDir}
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button onClick={openFolder} style={{ flex: 1, padding: 10, fontSize: 13 }}>在 Finder 中打开</button>
        <button onClick={copyPath} style={{ flex: 1, padding: 10, fontSize: 13 }}>复制路径</button>
      </div>
      <button onClick={onReset} style={{ width: '100%', padding: 10, fontSize: 13, color: '#1a73e8', background: 'none', border: '1px solid #1a73e8', borderRadius: 4, cursor: 'pointer' }}>
        新建录制
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Update App.jsx to wire everything together**

```jsx
// src/renderer/src/App.jsx
import { useEffect, useRef, useState } from 'react'
import { useAppStore } from './store.js'
import Setup from './views/Setup.jsx'
import Recording from './views/Recording.jsx'
import Done from './views/Done.jsx'

export default function App() {
  const store = useAppStore()
  const timerRef = useRef(null)
  const tabPollerRef = useRef(null)
  const startTimeRef = useRef(null)

  async function handleStart() {
    const { ok } = await window.electronAPI.startRecording({
      chromePath: store.chromePath,
      outputDir: store.outputDir
    })
    if (!ok) return
    startTimeRef.current = Date.now()
    store.setView('recording')

    timerRef.current = setInterval(() => {
      store.setElapsedMs(Date.now() - startTimeRef.current)
    }, 1000)

    tabPollerRef.current = setInterval(async () => {
      const tabs = await window.electronAPI.getTabList()
      store.setTabs(tabs)
    }, 2000)
  }

  async function handleStop() {
    clearInterval(timerRef.current)
    clearInterval(tabPollerRef.current)
    const { ok, sessionDir } = await window.electronAPI.stopRecording()
    if (ok) {
      store.setSessionDir(sessionDir)
      store.setView('done')
    }
  }

  function handleReset() {
    store.setView('setup')
    store.setElapsedMs(0)
    store.setTabs([])
  }

  // Auto-detect chrome path on mount
  useEffect(() => {
    window.electronAPI.findChromePath().then(p => store.setChromePath(p))
  }, [])

  if (store.view === 'setup') return (
    <Setup
      chromePath={store.chromePath}
      setChromePath={store.setChromePath}
      outputDir={store.outputDir}
      setOutputDir={store.setOutputDir}
      onStart={handleStart}
    />
  )

  if (store.view === 'recording') return (
    <Recording
      tabs={store.tabs}
      elapsedMs={store.elapsedMs}
      onStop={handleStop}
    />
  )

  return <Done sessionDir={store.sessionDir} onReset={handleReset} />
}
```

- [ ] **Step 5: Verify full app flow**

```bash
npm run dev
```

Expected:
1. Setup view appears with auto-detected Chrome path
2. Select output dir, click "启动 Chrome 并开始录制"
3. Chrome launches, Recording view shows elapsed time
4. Navigate to a URL in Chrome, Tab appears in list
5. Click "停止录制", Done view shows session directory path
6. "在 Finder 中打开" opens the folder with `recording.har` and `RECORDING.md`

- [ ] **Step 6: Commit**

```bash
git add src/preload/index.js src/renderer/src/views/ src/renderer/src/App.jsx
git commit -m "feat: complete UI with Setup/Recording/Done views and preload bridge"
```

---

## Task 12: Run All Tests

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected: All unit tests PASS. Integration test PASS.

- [ ] **Step 2: Fix any failures before proceeding**

If `recorder.test.js` fails with port conflict:
```bash
lsof -ti:19222 | xargs kill -9
npm test tests/integration/recorder.test.js
```

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "chore: all tests passing"
```
