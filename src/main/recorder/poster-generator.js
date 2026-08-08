import { spawn as spawnProcess } from 'child_process'
import { join } from 'path'
import { resolveNativeToolPath } from './native-tools.js'

export async function generatePoster({
  recordingDir,
  durationMs,
  nativeToolPathOptions = {},
  spawn = spawnProcess
}) {
  const input = join(recordingDir, 'video', 'recording.mp4')
  const output = join(recordingDir, 'video', 'poster.png')
  const offsetMs = Math.max(0, Math.round(Math.min(1000, Math.max(0, Number(durationMs) || 0) * 0.2)))
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
