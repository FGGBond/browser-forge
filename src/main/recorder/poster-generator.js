import { spawn as spawnProcess } from 'child_process'
import { join } from 'path'
import { rm } from 'fs/promises'
import { resolveNativeToolPath } from './native-tools.js'

const FRAME_QUANTIZATION_TOLERANCE_MS = 100

export function selectPosterOffset({ durationMs, coveredUntilOffsetMs = durationMs, timeline = [], internalOrigins = [] } = {}) {
  const duration = Math.max(0, Number(durationMs) || 0)
  const coverage = Math.min(duration, Math.max(0, Number(coveredUntilOffsetMs) || 0))
  if (coverage <= 0) return null
  const maxOffset = coverage > 100 ? coverage - 100 : coverage
  const internal = new Set(internalOrigins.map(value => {
    try { return new URL(String(value)).origin } catch { return null }
  }).filter(Boolean))

  for (const event of timeline) {
    if (event?.type !== 'navigation-stable' || event?.success === false || event?.failed === true) continue
    const offset = Number(event.videoOffsetMs)
    if (!Number.isFinite(offset) || offset < 0) continue
    let parsed
    try { parsed = new URL(String(event.url || event.documentUrl || event.pageUrl || '')) } catch { continue }
    if (!['http:', 'https:'].includes(parsed.protocol)) continue
    if (internal.has(parsed.origin) || parsed.pathname.endsWith('/recording-start.html')) continue
    const roundedOffset = Math.round(offset)
    if (roundedOffset > maxOffset) continue
    return roundedOffset
  }
  return null
}

export async function generatePoster({
  recordingDir,
  durationMs,
  coveredUntilOffsetMs = durationMs,
  timeline = [],
  internalOrigins = [],
  nativeToolPathOptions = {},
  spawn = spawnProcess
}) {
  const input = join(recordingDir, 'video', 'recording.mp4')
  const output = join(recordingDir, 'video', 'poster.png')
  const requestedOffsetMs = selectPosterOffset({ durationMs, coveredUntilOffsetMs, timeline, internalOrigins })
  if (requestedOffsetMs === null) {
    return { status: 'unavailable', reason: 'no-stable-external-page' }
  }
  try {
    const binary = resolveNativeToolPath({ ...nativeToolPathOptions, toolName: 'bf-video-frame' })
    const extracted = await runProcess(spawn, binary, [
      '--input', input,
      '--offset-ms', String(requestedOffsetMs),
      '--output', output
    ])
    const nativeRequestedOffsetMs = Number(extracted?.requestedOffsetMs)
    const actualOffsetMs = Number(extracted?.actualOffsetMs)
    if (!Number.isFinite(nativeRequestedOffsetMs) || nativeRequestedOffsetMs < 0 || !Number.isFinite(actualOffsetMs) || actualOffsetMs < 0) {
      throw new Error('Native frame extractor did not report valid offsets')
    }
    if (nativeRequestedOffsetMs !== requestedOffsetMs) {
      throw new Error(`Native frame extractor requested offset ${nativeRequestedOffsetMs}ms does not match ${requestedOffsetMs}ms`)
    }
    const duration = Math.max(0, Number(durationMs) || 0)
    const coverage = Math.min(duration, Math.max(0, Number(coveredUntilOffsetMs) || 0))
    const maximumQuantizedOffset = Math.min(duration, coverage + FRAME_QUANTIZATION_TOLERANCE_MS)
    if (actualOffsetMs > maximumQuantizedOffset) {
      throw new Error(`Native frame extractor returned ${actualOffsetMs}ms beyond captured coverage ${coverage}ms`)
    }
    return {
      status: 'complete',
      path: output,
      offsetMs: Math.round(actualOffsetMs),
      requestedOffsetMs: Math.round(nativeRequestedOffsetMs),
      actualOffsetMs: Math.round(actualOffsetMs),
      ...(Number.isFinite(Number(extracted.width)) ? { width: Math.round(Number(extracted.width)) } : {}),
      ...(Number.isFinite(Number(extracted.height)) ? { height: Math.round(Number(extracted.height)) } : {})
    }
  } catch (error) {
    await rm(output, { force: true }).catch(() => {})
    return { status: 'failed', error }
  }
}

async function runProcess(spawn, binary, args) {
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  if (!child?.once) throw new Error('Native frame extractor did not start')
  let stdout = ''
  let stderr = ''
  child.stdout?.on?.('data', chunk => {
    stdout += Buffer.from(chunk).toString('utf8')
    if (stdout.length > 32_768) stdout = stdout.slice(-32_768)
  })
  child.stderr?.on?.('data', chunk => {
    stderr += Buffer.from(chunk).toString('utf8')
    if (stderr.length > 8_192) stderr = stderr.slice(-8_192)
  })
  await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`Native frame extractor failed (${signal || (code ?? 'unknown')}): ${stderr.trim() || parseNativeError(stdout) || 'no error output'}`))
    })
  })
  const records = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean)
  const result = records.at(-1)
  if (!result || result.type === 'error') {
    throw new Error(result?.message || 'Native frame extractor returned invalid output')
  }
  return result
}

function parseNativeError(stdout) {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    try {
      const value = JSON.parse(line)
      if (value?.message) return value.message
    } catch {}
  }
  return ''
}
