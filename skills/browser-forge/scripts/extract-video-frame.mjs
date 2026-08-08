#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, constants, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const skillDir = resolve(scriptDir, '..')

function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`) }
function fail(code, message) { emit({ type: 'error', code, message }); process.exitCode = 1 }
function parseArgs(args) {
  const values = { overwrite: false }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--overwrite') { values.overwrite = true; continue }
    if (!['--recording-dir', '--offset-ms', '--output'].includes(arg) || index + 1 >= args.length) throw new Error(`Unknown or incomplete argument: ${arg}`)
    values[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = args[++index]
  }
  if (!values.recordingDir || !values.output || !/^\d+$/.test(String(values.offsetMs))) throw new Error('Usage: extract-video-frame --recording-dir <dir> --offset-ms <non-negative-ms> --output <png> [--overwrite]')
  return { ...values, offsetMs: Number(values.offsetMs) }
}
async function exists(path) { try { await access(path, constants.F_OK); return true } catch { return false } }
async function sha256(path) { return createHash('sha256').update(await readFile(path)).digest('hex') }
async function main() {
  let options
  try { options = parseArgs(process.argv.slice(2)) } catch (error) { return fail('INVALID_ARGUMENT', error.message) }
  const manifestPath = join(options.recordingDir, 'video', 'manifest.json')
  if (!await exists(manifestPath)) return fail('VIDEO_MANIFEST_NOT_FOUND', `Missing ${manifestPath}`)
  let manifest
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) } catch { return fail('VIDEO_MANIFEST_INVALID', `Invalid JSON in ${manifestPath}`) }
  if (manifest.state === 'failed') return fail('VIDEO_STATE_FAILED', 'This recording has no usable window video')
  if (!['complete', 'partial'].includes(manifest.state)) return fail('VIDEO_MANIFEST_INVALID', `Unsupported video state: ${manifest.state}`)
  if (options.offsetMs > Number(manifest.durationMs ?? 0)) return fail('VIDEO_OFFSET_OUT_OF_RANGE', `Requested offset ${options.offsetMs}ms exceeds video duration ${manifest.durationMs}ms`)
  if (manifest.state === 'partial' && options.offsetMs > Number(manifest.coveredUntilOffsetMs ?? 0)) return fail('VIDEO_OFFSET_NOT_COVERED', `Requested offset ${options.offsetMs}ms exceeds covered video range ${manifest.coveredUntilOffsetMs}ms`)
  const videoPath = join(options.recordingDir, 'video', manifest.file ?? 'recording.mp4')
  if (!await exists(videoPath)) return fail('VIDEO_FILE_NOT_FOUND', `Missing ${videoPath}`)
  if (await exists(options.output)) {
    if (!options.overwrite) return fail('OUTPUT_ALREADY_EXISTS', `Refusing to overwrite ${options.output}`)
    await rm(options.output, { force: true })
  }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return fail('UNSUPPORTED_PLATFORM', `No bundled frame extractor for ${process.platform}-${process.arch}`)
  const toolsManifestPath = join(skillDir, 'assets', 'video-tools', 'manifest.json')
  if (!await exists(toolsManifestPath)) return fail('EXTRACTION_FAILED', 'Bundled video-tools manifest is missing')
  const toolManifest = JSON.parse(await readFile(toolsManifestPath, 'utf8'))
  const tool = toolManifest.tools?.['darwin-arm64']?.['bf-video-frame']
  const binary = join(skillDir, 'assets', 'video-tools', 'darwin-arm64', 'bf-video-frame')
  if (!tool || !await exists(binary)) return fail('EXTRACTION_FAILED', 'Bundled macOS frame extractor is missing')
  if (tool.sha256 !== await sha256(binary)) return fail('EXTRACTION_FAILED', 'Bundled macOS frame extractor failed integrity validation')
  const result = await new Promise(resolveResult => execFile(binary, ['--input', videoPath, '--offset-ms', String(options.offsetMs), '--output', options.output], { encoding: 'utf8' }, (error, stdout, stderr) => resolveResult({ error, stdout, stderr })))
  if (result.error) {
    try { process.stdout.write(result.stdout) } catch {}
    return fail('EXTRACTION_FAILED', result.stderr.trim() || result.error.message)
  }
  process.stdout.write(result.stdout)
}
main().catch(error => fail('EXTRACTION_FAILED', error.message))
