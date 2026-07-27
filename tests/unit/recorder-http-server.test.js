import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'path'
import { createRecorderHttpServer } from '../../src/main/recorder/http-server.js'

let recorderServer

afterEach(async () => {
  await recorderServer?.close()
  recorderServer = null
})

describe('recorder HTTP server', () => {
  it('serves the polished recorder UI and clean live summary', async () => {
    recorderServer = createRecorderHttpServer({
      uiRoot: join(process.cwd(), 'ui')
    })
    const url = await recorderServer.listen()

    const html = await fetch(url).then(response => response.text())
    const summary = await fetch(`${url}/api/summary`).then(response => response.json())

    expect(html).toContain('Browser Tabs')
    expect(html).toContain('screenshot-grid')
    expect(html).toContain('view-setup')
    expect(html).not.toContain('启动 Chrome 并开始录制</button></div>')
    expect(summary).toEqual(expect.objectContaining({
      type: 'summary',
      startedAt: null,
      tabs: [],
      totals: { events: 0, network: 0, console: 0, artifacts: 0 }
    }))
  })
})
