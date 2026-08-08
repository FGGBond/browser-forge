const VIDEO_STATES = new Set(['complete', 'partial', 'failed'])

export function createVideoManifest({
  state,
  file = 'recording.mp4',
  codec = 'h264',
  fps = 15,
  startEpochMs = null,
  durationMs = 0,
  coveredUntilOffsetMs = durationMs,
  window
} = {}) {
  if (!VIDEO_STATES.has(state)) {
    throw new Error(`Unsupported video manifest state: ${state}`)
  }
  if (!window || !Number.isInteger(window.pid) || !window.windowId || !window.title) {
    throw new Error('Video manifest requires a matched window identity')
  }

  const normalizedDurationMs = nonNegativeInteger(durationMs, 'durationMs')
  const normalizedCoverageMs = nonNegativeInteger(coveredUntilOffsetMs, 'coveredUntilOffsetMs')
  if (normalizedCoverageMs > normalizedDurationMs) {
    throw new Error('coveredUntilOffsetMs cannot exceed durationMs')
  }

  if (state === 'failed') {
    return {
      version: 1,
      state,
      startEpochMs: null,
      durationMs: 0,
      coveredUntilOffsetMs: 0,
      window
    }
  }

  if (!Number.isFinite(startEpochMs) || startEpochMs <= 0) {
    throw new Error('Video manifest requires startEpochMs for captured video')
  }

  return {
    version: 1,
    state,
    file,
    codec,
    fps: nonNegativeInteger(fps, 'fps'),
    startEpochMs: Math.round(startEpochMs),
    durationMs: normalizedDurationMs,
    coveredUntilOffsetMs: normalizedCoverageMs,
    window
  }
}

export function addVideoOffset(event, startEpochMs) {
  if (!Number.isFinite(startEpochMs) || startEpochMs <= 0 || !Number.isFinite(event?.timestamp)) {
    return { ...event }
  }
  return {
    ...event,
    videoOffsetMs: Math.max(0, Math.round(event.timestamp - startEpochMs))
  }
}

function nonNegativeInteger(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`)
  }
  return Math.round(value)
}

export const VIDEO_MANIFEST_STATES = Object.freeze([...VIDEO_STATES])
