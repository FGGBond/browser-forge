export function isProcessAlive(process) {
  return Boolean(process && process.exitCode === null && !process.killed)
}

export function shouldClearActiveSession({ activeSession, chromeProcess }) {
  return Boolean(activeSession && !isProcessAlive(chromeProcess))
}
