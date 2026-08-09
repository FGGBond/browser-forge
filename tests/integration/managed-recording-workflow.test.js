import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { RecordingLibrary } from '../../src/main/recording-library/index.js'
import { createRecorderHttpServer } from '../../src/main/recorder/http-server.js'
import { writeSession } from '../../src/main/recorder/output-writer.js'

let root
let server

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'bf-managed-workflow-')) })
afterEach(async () => {
  await server?.close().catch(() => {})
  await rm(root, { recursive: true, force: true })
})

describe('managed recording workflow', () => {
  it('records, promotes, restarts, and lists the same App-managed recording', async () => {
    const libraryRoot = join(root, 'recordings')
    const firstLibrary = new RecordingLibrary({ root: libraryRoot })
    await firstLibrary.initialize()

    class FakeRecordingSession {
      constructor({ sessionDir }) {
        this.sessionDir = sessionDir
        this._cdp = { getTargets: () => [], disconnect: async () => {} }
      }
      async start() {}
      async stop({ video }) {
        await writeSession({
          sessionDir: this.sessionDir,
          metadata: {
            startedAt: '2026-08-08T12:15:00.000Z',
            startUrl: 'https://example.com/orders',
            durationMs: 1234,
            chromeVersion: 'test',
            tabs: []
          },
          har: { log: { version: '1.2', creator: { name: 'browser-forge', version: '0.1.0' }, pages: [], entries: [] } },
          timeline: [{ type: 'navigation', url: 'https://example.com/orders', timestamp: Date.parse('2026-08-08T12:15:00.000Z'), videoOffsetMs: 0 }],
          tabs: {},
          video
        })
        return this.sessionDir
      }
      getLiveSummary() { return { type: 'summary', startedAt: 1, tabs: [], totals: {} } }
    }

    server = createRecorderHttpServer({
      uiRoot: join(process.cwd(), 'ui'),
      startupLogFile: null,
      recordingLibrary: firstLibrary,
      screenRecordingPermission: {
        check: async () => ({ supported: true, status: 'granted', granted: true, restartRequired: false }),
        request: async () => ({ supported: true, status: 'granted', granted: true, restartRequired: false })
      },
      findAvailablePort: async () => 9333,
      findChromePath: async () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      waitForChromeDebugEndpoint: async () => {},
      launchChrome: () => ({ pid: 4242, exitCode: null, once: () => {}, kill: () => {} }),
      createVideoRecorder: () => ({
        start: async () => ({ startEpochMs: Date.parse('2026-08-08T12:15:00.000Z'), window: { pid: 4242, windowId: '1', title: 'Browser Forge' } }),
        stop: async () => ({ state: 'failed', durationMs: 0, coveredUntilOffsetMs: 0, window: { pid: 4242, windowId: '1', title: 'Browser Forge' } })
      }),
      RecordingSession: FakeRecordingSession
    })
    const url = await server.listen()

    const started = await fetch(`${url}/api/start-recording`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(response => response.json())
    const stopped = await fetch(`${url}/api/stop-recording`, { method: 'POST' }).then(response => response.json())
    expect(stopped.recordingId).toBe(started.recordingId)
    expect(stopped.recording).toMatchObject({ id: started.recordingId, state: 'active', title: expect.stringContaining('example.com'), videoStatus: 'failed' })

    await server.close()
    server = null
    const restartedLibrary = new RecordingLibrary({ root: libraryRoot })
    await restartedLibrary.initialize()
    expect((await restartedLibrary.list({ state: 'active' })).map(item => item.id)).toEqual([started.recordingId])
  })
})
