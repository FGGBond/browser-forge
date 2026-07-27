import { describe, expect, it } from 'vitest'
import { isProcessAlive, shouldClearActiveSession } from '../../src/main/recorder/session-state.js'

describe('recorder session state', () => {
  it('treats a child process with no exit code as alive', () => {
    expect(isProcessAlive({ exitCode: null, killed: false })).toBe(true)
  })

  it('treats killed or exited child processes as inactive', () => {
    expect(isProcessAlive({ exitCode: 0, killed: false })).toBe(false)
    expect(isProcessAlive({ exitCode: null, killed: true })).toBe(false)
    expect(isProcessAlive(null)).toBe(false)
  })

  it('clears active sessions when the owned Chrome process is gone', () => {
    expect(shouldClearActiveSession({
      activeSession: {},
      chromeProcess: { exitCode: 0, killed: false }
    })).toBe(true)
  })

  it('keeps active sessions while the owned Chrome process is alive', () => {
    expect(shouldClearActiveSession({
      activeSession: {},
      chromeProcess: { exitCode: null, killed: false }
    })).toBe(false)
  })
})
