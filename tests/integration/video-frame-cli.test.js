import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const buildNativeToolsScript = join(repoRoot, 'scripts', 'build-native-tools.mjs')
const nativeFrameCli = join(repoRoot, 'native-tools', 'bf-video-frame')
const skillFrameWrapper = join(repoRoot, 'skills', 'browser-forge', 'scripts', 'extract-video-frame')

const fixtureGenerator = String.raw`
import AVFoundation
import CoreMedia
import CoreVideo
import Foundation

let width = 64
let height = 48
let output = URL(fileURLWithPath: CommandLine.arguments[1])

try? FileManager.default.removeItem(at: output)
let writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
let input = AVAssetWriterInput(
    mediaType: .video,
    outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: width,
        AVVideoHeightKey: height
    ]
)
let adaptor = AVAssetWriterInputPixelBufferAdaptor(
    assetWriterInput: input,
    sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: width,
        kCVPixelBufferHeightKey as String: height,
        kCVPixelBufferIOSurfacePropertiesKey as String: [:]
    ]
)

guard writer.canAdd(input) else { fatalError("Cannot add video input") }
writer.add(input)
guard writer.startWriting() else { fatalError(writer.error?.localizedDescription ?? "Cannot start writer") }
writer.startSession(atSourceTime: .zero)

for frame in 0..<3 {
    while !input.isReadyForMoreMediaData {
        Thread.sleep(forTimeInterval: 0.01)
    }

    var pixelBuffer: CVPixelBuffer?
    let status = CVPixelBufferCreate(
        nil,
        width,
        height,
        kCVPixelFormatType_32BGRA,
        [kCVPixelBufferIOSurfacePropertiesKey as String: [:]] as CFDictionary,
        &pixelBuffer
    )
    guard status == kCVReturnSuccess, let pixelBuffer else { fatalError("Cannot create pixel buffer") }

    CVPixelBufferLockBaseAddress(pixelBuffer, [])
    let base = CVPixelBufferGetBaseAddress(pixelBuffer)!.assumingMemoryBound(to: UInt8.self)
    let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
    for y in 0..<height {
        for x in 0..<width {
            let pixel = base.advanced(by: y * bytesPerRow + x * 4)
            pixel[0] = UInt8(frame * 80)
            pixel[1] = UInt8(x * 4)
            pixel[2] = UInt8(y * 5)
            pixel[3] = 255
        }
    }
    CVPixelBufferUnlockBaseAddress(pixelBuffer, [])

    guard adaptor.append(pixelBuffer, withPresentationTime: CMTime(value: Int64(frame), timescale: 2)) else {
        fatalError(writer.error?.localizedDescription ?? "Cannot append frame")
    }
}

input.markAsFinished()
let finished = DispatchSemaphore(value: 0)
writer.finishWriting { finished.signal() }
finished.wait()
guard writer.status == .completed else { fatalError(writer.error?.localizedDescription ?? "Cannot finish writer") }
`

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8' })
  if (result.error) throw result.error
  return result
}

function expectSuccess(result) {
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0)
}

function parseCliJson(stdout) {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean)
  expect(lines).toHaveLength(1)
  return JSON.parse(lines[0])
}

function expectPngDimensions(path) {
  const png = readFileSync(path)
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  expect(png.readUInt32BE(8)).toBe(13)
  expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR')
  expect(png.readUInt32BE(16)).toBe(64)
  expect(png.readUInt32BE(20)).toBe(48)
}

function buildNativeTools() {
  expectSuccess(run(process.execPath, [buildNativeToolsScript]))
}

function withVideoFixture(test) {
  const tempDir = mkdtempSync(join(tmpdir(), 'bf-video-frame-'))
  const generatorSource = join(tempDir, 'fixture-generator.swift')
  const generator = join(tempDir, 'fixture-generator')
  const input = join(tempDir, 'fixture.mp4')

  try {
    writeFileSync(generatorSource, fixtureGenerator)
    expectSuccess(run('swiftc', [
      generatorSource,
      '-framework', 'AVFoundation',
      '-framework', 'CoreMedia',
      '-framework', 'CoreVideo',
      '-o', generator
    ]))
    expectSuccess(run(generator, [input]))
    expect(existsSync(input)).toBe(true)

    test({ tempDir, input })
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function createRecordingMaterial(tempDir, input) {
  const recordingDir = join(tempDir, 'recording-material')
  const videoDir = join(recordingDir, 'video')
  mkdirSync(videoDir, { recursive: true })
  copyFileSync(input, join(videoDir, 'recording.mp4'))
  writeFileSync(join(videoDir, 'manifest.json'), JSON.stringify({
    version: 1,
    state: 'complete',
    file: 'recording.mp4',
    codec: 'h264',
    fps: 2,
    startEpochMs: 1_786_170_000_000,
    durationMs: 1_000,
    coveredUntilOffsetMs: 1_000,
    window: { pid: 1234, windowId: 'fixture', title: 'Browser Forge Recording · fixture' }
  }))
  return recordingDir
}

describe.runIf(process.platform === 'darwin')('bf-video-frame native CLI', () => {
  it('extracts the exact 500ms AVFoundation fixture frame and reports out-of-range offsets as JSON errors', () => {
    withVideoFixture(({ tempDir, input }) => {
      const output = join(tempDir, 'frame.png')
      const nearbyOutput = join(tempDir, 'nearby-frame.png')
      const outOfRangeOutput = join(tempDir, 'out-of-range.png')

      buildNativeTools()
      const extraction = run(nativeFrameCli, ['--input', input, '--offset-ms', '500', '--output', output])
      expectSuccess(extraction)
      expect(parseCliJson(extraction.stdout)).toMatchObject({
        requestedOffsetMs: 500,
        actualOffsetMs: 500,
        output,
        width: 64,
        height: 48
      })
      expectPngDimensions(output)

      const nearby = run(nativeFrameCli, ['--input', input, '--offset-ms', '530', '--output', nearbyOutput])
      expectSuccess(nearby)
      expect(parseCliJson(nearby.stdout)).toMatchObject({
        requestedOffsetMs: 530,
        actualOffsetMs: 500,
        output: nearbyOutput
      })
      expectPngDimensions(nearbyOutput)

      const outOfRange = run(nativeFrameCli, ['--input', input, '--offset-ms', '10000', '--output', outOfRangeOutput])
      expect(outOfRange.status).not.toBe(0)
      expect(existsSync(outOfRangeOutput)).toBe(false)
      expect(parseCliJson(outOfRange.stdout)).toMatchObject({
        type: 'error',
        code: expect.any(String),
        message: expect.any(String)
      })
    })
  }, 120_000)
})

describe.runIf(process.platform === 'darwin' && process.arch === 'arm64')('bf-video-frame Agent skill wrapper', () => {
  it('extracts the exact 500ms AVFoundation fixture frame and reports manifest range errors as JSON', () => {
    withVideoFixture(({ tempDir, input }) => {
      const recordingDir = createRecordingMaterial(tempDir, input)
      const output = join(tempDir, 'skill-frame.png')
      const outOfRangeOutput = join(tempDir, 'skill-out-of-range.png')

      buildNativeTools()
      const extraction = run('/bin/bash', [
        skillFrameWrapper,
        '--recording-dir', recordingDir,
        '--offset-ms', '500',
        '--output', output
      ])
      expectSuccess(extraction)
      expect(parseCliJson(extraction.stdout)).toMatchObject({
        requestedOffsetMs: 500,
        actualOffsetMs: 500,
        output,
        width: 64,
        height: 48
      })
      expectPngDimensions(output)

      const outOfRange = run('/bin/bash', [
        skillFrameWrapper,
        '--recording-dir', recordingDir,
        '--offset-ms', '1001',
        '--output', outOfRangeOutput
      ])
      expect(outOfRange.status).not.toBe(0)
      expect(existsSync(outOfRangeOutput)).toBe(false)
      expect(parseCliJson(outOfRange.stdout)).toMatchObject({
        type: 'error',
        code: 'VIDEO_OFFSET_OUT_OF_RANGE'
      })

      const manifestPath = join(recordingDir, 'video', 'manifest.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      writeFileSync(manifestPath, JSON.stringify({
        ...manifest,
        state: 'partial',
        coveredUntilOffsetMs: 400
      }))
      const uncovered = run('/bin/bash', [
        skillFrameWrapper,
        '--recording-dir', recordingDir,
        '--offset-ms', '500',
        '--output', join(tempDir, 'skill-uncovered.png')
      ])
      expect(uncovered.status).not.toBe(0)
      expect(parseCliJson(uncovered.stdout)).toMatchObject({
        type: 'error',
        code: 'VIDEO_OFFSET_NOT_COVERED'
      })

      writeFileSync(manifestPath, JSON.stringify({ ...manifest, file: '../../fixture.mp4' }))
      const escapedFile = run('/bin/bash', [
        skillFrameWrapper,
        '--recording-dir', recordingDir,
        '--offset-ms', '500',
        '--output', join(tempDir, 'skill-escaped-file.png')
      ])
      expect(escapedFile.status).not.toBe(0)
      expect(parseCliJson(escapedFile.stdout)).toMatchObject({
        type: 'error',
        code: 'VIDEO_MANIFEST_INVALID'
      })

      writeFileSync(manifestPath, JSON.stringify({
        ...manifest,
        coveredUntilOffsetMs: manifest.durationMs - 1
      }))
      const incompleteComplete = run('/bin/bash', [
        skillFrameWrapper,
        '--recording-dir', recordingDir,
        '--offset-ms', '500',
        '--output', join(tempDir, 'skill-incomplete-complete.png')
      ])
      expect(incompleteComplete.status).not.toBe(0)
      expect(parseCliJson(incompleteComplete.stdout)).toMatchObject({
        type: 'error',
        code: 'VIDEO_MANIFEST_INVALID'
      })

      writeFileSync(manifestPath, JSON.stringify({ ...manifest, state: 'failed' }))
      const contradictoryFailed = run('/bin/bash', [
        skillFrameWrapper,
        '--recording-dir', recordingDir,
        '--offset-ms', '0',
        '--output', join(tempDir, 'skill-contradictory-failed.png')
      ])
      expect(contradictoryFailed.status).not.toBe(0)
      expect(parseCliJson(contradictoryFailed.stdout)).toMatchObject({
        type: 'error',
        code: 'VIDEO_MANIFEST_INVALID'
      })

      writeFileSync(manifestPath, JSON.stringify({
        version: 1,
        state: 'failed',
        startEpochMs: null,
        durationMs: 0,
        coveredUntilOffsetMs: 0,
        window: manifest.window
      }))
      const failed = run('/bin/bash', [
        skillFrameWrapper,
        '--recording-dir', recordingDir,
        '--offset-ms', '0',
        '--output', join(tempDir, 'skill-failed.png')
      ])
      expect(failed.status).not.toBe(0)
      expect(parseCliJson(failed.stdout)).toMatchObject({
        type: 'error',
        code: 'VIDEO_STATE_FAILED'
      })


      writeFileSync(manifestPath, JSON.stringify(manifest))
      writeFileSync(join(recordingDir, 'video', 'recording.mp4'), 'not-an-mp4')
      const preservedOutput = join(tempDir, 'preserved-on-extraction-failure.png')
      writeFileSync(preservedOutput, 'existing-output')
      const corruptVideo = run('/bin/bash', [
        skillFrameWrapper,
        '--recording-dir', recordingDir,
        '--offset-ms', '500',
        '--output', preservedOutput,
        '--overwrite'
      ])
      expect(corruptVideo.status).not.toBe(0)
      expect(parseCliJson(corruptVideo.stdout)).toMatchObject({
        type: 'error',
        code: 'EXTRACTION_FAILED'
      })
      expect(readFileSync(preservedOutput, 'utf8')).toBe('existing-output')

      const newOutput = join(tempDir, 'no-partial-output-on-extraction-failure.png')
      const corruptVideoWithoutOverwrite = run(process.execPath, [
        join(repoRoot, 'skills/browser-forge/scripts/extract-video-frame.mjs'),
        '--recording-dir', recordingDir,
        '--offset-ms', '500',
        '--output', newOutput
      ])
      expect(corruptVideoWithoutOverwrite.status).not.toBe(0)
      expect(parseCliJson(corruptVideoWithoutOverwrite.stdout)).toMatchObject({
        type: 'error',
        code: 'EXTRACTION_FAILED'
      })
      expect(existsSync(newOutput)).toBe(false)
    })
  }, 120_000)
})
