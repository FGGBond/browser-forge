#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, constants, readFile, rename, rm } from 'node:fs/promises'
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
  const offsetMs = Number(values.offsetMs)
  if (!Number.isSafeInteger(offsetMs)) throw new Error('--offset-ms must be a non-negative safe integer')
  return { ...values, offsetMs }
}
function isNonNegativeSafeInteger(value) { return Number.isSafeInteger(value) && value >= 0 }
async function exists(path) { try { await access(path, constants.F_OK); return true } catch { return false } }
async function sha256(path) { return createHash('sha256').update(await readFile(path)).digest('hex') }
function parseSingleJsonLine(stdout) {
  const lines = String(stdout ?? '').trim().split(/\r?\n/).filter(Boolean)
  if (lines.length !== 1) return null
  try { return JSON.parse(lines[0]) } catch { return null }
}
async function commitOverwrite({ temporaryOutput, output, outputExisted }) {
  if (process.platform !== 'win32' || !outputExisted) {
    await rename(temporaryOutput, output)
    return
  }

  const backup = `${output}.browser-forge-backup-${process.pid}-${Date.now()}`
  await rename(output, backup)
  try {
    await rename(temporaryOutput, output)
    await rm(backup, { force: true })
  } catch (error) {
    await rename(backup, output).catch(() => {})
    throw error
  }
}
async function main() {
  let options
  try { options = parseArgs(process.argv.slice(2)) } catch (error) { return fail('INVALID_ARGUMENT', error.message) }
  const manifestPath = join(options.recordingDir, 'video', 'manifest.json')
  if (!await exists(manifestPath)) return fail('VIDEO_MANIFEST_NOT_FOUND', `Missing ${manifestPath}`)
  let manifest
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) } catch { return fail('VIDEO_MANIFEST_INVALID', `Invalid JSON in ${manifestPath}`) }
  if (manifest.version !== 1) return fail('VIDEO_MANIFEST_INVALID', `Unsupported video manifest version: ${manifest.version ?? 'missing'}`)
  if (!['complete', 'partial', 'failed'].includes(manifest.state)) return fail('VIDEO_MANIFEST_INVALID', `Unsupported video state: ${manifest.state}`)
  if (!isNonNegativeSafeInteger(manifest.durationMs) || !isNonNegativeSafeInteger(manifest.coveredUntilOffsetMs) || manifest.coveredUntilOffsetMs > manifest.durationMs) {
    return fail('VIDEO_MANIFEST_INVALID', 'Video manifest has invalid duration or coverage')
  }
  if (manifest.state === 'complete' && manifest.coveredUntilOffsetMs !== manifest.durationMs) {
    return fail('VIDEO_MANIFEST_INVALID', 'Complete video manifest must cover the full duration')
  }
  if (manifest.state === 'failed') {
    if (manifest.durationMs !== 0 || manifest.coveredUntilOffsetMs !== 0 || Object.prototype.hasOwnProperty.call(manifest, 'file')) {
      return fail('VIDEO_MANIFEST_INVALID', 'Failed video manifest must have zero duration and coverage and no file')
    }
    return fail('VIDEO_STATE_FAILED', 'This recording has no usable window video')
  }
  if (manifest.file !== 'recording.mp4') return fail('VIDEO_MANIFEST_INVALID', 'Video manifest file must be recording.mp4')
  if (options.offsetMs > manifest.durationMs) return fail('VIDEO_OFFSET_OUT_OF_RANGE', `Requested offset ${options.offsetMs}ms exceeds video duration ${manifest.durationMs}ms`)
  if (manifest.state === 'partial' && options.offsetMs > manifest.coveredUntilOffsetMs) return fail('VIDEO_OFFSET_NOT_COVERED', `Requested offset ${options.offsetMs}ms exceeds covered video range ${manifest.coveredUntilOffsetMs}ms`)
  const videoPath = join(options.recordingDir, 'video', manifest.file)
  if (!await exists(videoPath)) return fail('VIDEO_FILE_NOT_FOUND', `Missing ${videoPath}`)
  const outputExisted = await exists(options.output)
  if (outputExisted && !options.overwrite) return fail('OUTPUT_ALREADY_EXISTS', `Refusing to overwrite ${options.output}`)
  const platformKey = `${process.platform}-${process.arch}`
  const toolName = process.platform === 'win32' ? 'bf-video-frame.exe' : 'bf-video-frame'
  const toolsManifestPath = join(skillDir, 'assets', 'video-tools', 'manifest.json')
  if (!await exists(toolsManifestPath)) return fail('EXTRACTION_FAILED', 'Bundled video-tools manifest is missing')
  let toolManifest
  try { toolManifest = JSON.parse(await readFile(toolsManifestPath, 'utf8')) } catch { return fail('EXTRACTION_FAILED', 'Bundled video-tools manifest is invalid') }
  const tool = toolManifest.version === 1 ? toolManifest.tools?.[platformKey]?.[toolName] : null
  if (!tool) return fail('UNSUPPORTED_PLATFORM', `No bundled frame extractor for ${platformKey}`)
  const binary = join(skillDir, 'assets', 'video-tools', platformKey, toolName)
  if (!await exists(binary)) return fail('EXTRACTION_FAILED', `Bundled frame extractor is missing for ${platformKey}`)
  if (tool.sha256 !== await sha256(binary)) return fail('EXTRACTION_FAILED', `Bundled frame extractor failed integrity validation for ${platformKey}`)

  const nativeOutput = `${options.output}.browser-forge-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp.png`
  await rm(nativeOutput, { force: true })
  const result = await new Promise(resolveResult => execFile(binary, ['--input', videoPath, '--offset-ms', String(options.offsetMs), '--output', nativeOutput], { encoding: 'utf8' }, (error, stdout, stderr) => resolveResult({ error, stdout, stderr })))
  const nativeMessage = parseSingleJsonLine(result.stdout)
  if (result.error) {
    await rm(nativeOutput, { force: true }).catch(() => {})
    if (nativeMessage?.type === 'error' && typeof nativeMessage.code === 'string' && typeof nativeMessage.message === 'string') {
      emit(nativeMessage)
      process.exitCode = 1
      return
    }
    return fail('EXTRACTION_FAILED', String(result.stderr ?? '').trim() || result.error.message)
  }
  if (!nativeMessage || nativeMessage.type === 'error') {
    await rm(nativeOutput, { force: true }).catch(() => {})
    return fail('EXTRACTION_FAILED', 'Bundled frame extractor returned an invalid response')
  }

  try {
    await commitOverwrite({ temporaryOutput: nativeOutput, output: options.output, outputExisted })
  } catch (error) {
    await rm(nativeOutput, { force: true }).catch(() => {})
    return fail('EXTRACTION_FAILED', `Unable to replace output: ${error.message}`)
  }
  emit({ ...nativeMessage, output: options.output })
}
main().catch(error => fail('EXTRACTION_FAILED', error.message))
