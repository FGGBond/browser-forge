import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'

describe('recorder CLI entrypoint', () => {
  it('delegates recorder HTTP behavior to the shared server implementation', () => {
    const source = readFileSync('recorder.mjs', 'utf8')

    expect(source).toContain('createRecorderHttpServer')
    expect(source).not.toContain("from 'express'")
    expect(source).not.toContain('new WebSocketServer')
    expect(source).not.toContain("app.post('/api/start-recording'")
  })
})
