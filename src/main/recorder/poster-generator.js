import { spawn as spawnProcess } from 'child_process'
import { join } from 'path'
import { resolveNativeToolPath } from './native-tools.js'


export function selectPosterOffset({ durationMs, timeline = [], internalOrigins = [], settleDelayMs = 750 } = {}) {
  const duration = Math.max(0, Number(durationMs) || 0)
  const maxOffset = duration > 100 ? duration - 100 : duration
  const internal = new Set(internalOrigins.map(value => {
    try { return new URL(String(value)).origin } catch { return null }
  }).filter(Boolean))
  for (const event of timeline) {
    if (event?.type !== 'navigation' || event?.success === false || event?.failed === true) continue
    const offset = Number(event.videoOffsetMs)
    if (!Number.isFinite(offset) || offset < 0) continue
    let parsed
    try { parsed = new URL(String(event.url || event.documentUrl || event.pageUrl || '')) } catch { continue }
    if (!['http:', 'https:'].includes(parsed.protocol)) continue
    if (internal.has(parsed.origin) || ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) continue
    return Math.max(0, Math.round(Math.min(maxOffset, offset + Math.max(0, Number(settleDelayMs) || 0))))
  }
  return Math.max(0, Math.round(Math.min(maxOffset, 1000, duration * 0.2)))
}

export async function generatePoster({
  recordingDir,
  durationMs,
  timeline = [],
  internalOrigins = [],
  settleDelayMs = 750,
  nativeToolPathOptions = {},
  spawn = spawnProcess
}) {
  const input = join(recordingDir, 'video', 'recording.mp4')
  const output = join(recordingDir, 'video', 'poster.png')
  const offsetMs = selectPosterOffset({ durationMs, timeline, internalOrigins, settleDelayMs })
  try {
    const binary = resolveNativeToolPath({ ...nativeToolPathOptions, toolName: 'bf-video-frame' })
    await runProcess(spawn, binary, [
      '--input', input,
      '--offset-ms', String(offsetMs),
      '--output', output
    ])
    return { status: 'complete', path: output, offsetMs }
  } catch (error) {
    return { status: 'failed', error }
  }
}

async function runProcess(spawn, binary, args) {
  const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  if (!child?.once) throw new Error('Native frame extractor did not start')
  let stderr = ''
  child.stderr?.on?.('data', chunk => {
    stderr += Buffer.from(chunk).toString('utf8')
    if (stderr.length > 8_192) stderr = stderr.slice(-8_192)
  })
  await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`Native frame extractor failed (${signal || (code ?? 'unknown')}): ${stderr.trim() || 'no error output'}`))
    })
  })
}
