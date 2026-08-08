import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
@preconcurrency import ScreenCaptureKit

struct RecorderArguments {
    let chromePid: pid_t
    let expectedWindowTitle: String
    let outputURL: URL
    let fps: Int
    let timeoutMs: Int

    init() throws {
        var values: [String: String] = [:]
        var index = 1
        let args = CommandLine.arguments
        while index + 1 < args.count {
            values[args[index]] = args[index + 1]
            index += 2
        }
        guard let rawPid = values["--chrome-pid"], let pid = Int32(rawPid), pid > 0,
              let title = values["--expected-window-title"], !title.isEmpty,
              let output = values["--output"], !output.isEmpty else {
            throw RecorderError(code: "INVALID_ARGUMENT", message: "Usage: bf-window-recorder --chrome-pid <pid> --expected-window-title <title> --output <mp4> [--fps 15] [--timeout-ms 10000]")
        }
        chromePid = pid_t(pid)
        expectedWindowTitle = title
        outputURL = URL(fileURLWithPath: output)
        fps = max(1, Int(values["--fps"] ?? "15") ?? 15)
        timeoutMs = max(1, Int(values["--timeout-ms"] ?? "10000") ?? 10_000)
    }
}

struct RecorderError: Error {
    let code: String
    let message: String
}

struct WindowIdentity {
    let pid: pid_t
    let windowId: CGWindowID
    let title: String

    func json() -> [String: Any] {
        ["pid": Int(pid), "windowId": String(windowId), "title": title]
    }
}

func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value), let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

final class WindowRecorder: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let args: RecorderArguments
    private let queue = DispatchQueue(label: "com.browserforge.window-recorder")
    private var stream: SCStream?
    private var writer: AVAssetWriter?
    private var writerInput: AVAssetWriterInput?
    private var firstPTS: CMTime?
    private var lastPTS: CMTime?
    private var startEpochMs: Int64?
    private var identity: WindowIdentity?
    private var captureStartInFlight = false
    private var stopRequested = false
    private var finalizationStarted = false
    private var finished = false
    private var terminalFailure: RecorderError?

    init(args: RecorderArguments) {
        self.args = args
        super.init()
    }

    func start() async throws {
        let target = try await waitForUniqueWindow()
        let matchedIdentity = WindowIdentity(pid: target.owningApplication!.processID, windowId: target.windowID, title: target.title ?? "")

        let filter = SCContentFilter(desktopIndependentWindow: target)
        let configuration = SCStreamConfiguration()
        configuration.width = max(2, Int(target.frame.width * 2))
        configuration.height = max(2, Int(target.frame.height * 2))
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(args.fps))
        configuration.showsCursor = true
        configuration.capturesAudio = false
        if #available(macOS 14.2, *) {
            configuration.includeChildWindows = true
        }

        let captureStream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try captureStream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        try await installAndStartCapture(stream: captureStream, identity: matchedIdentity)
    }

    private func installAndStartCapture(stream: SCStream, identity: WindowIdentity) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async { [weak self] in
                guard let self else {
                    continuation.resume(throwing: RecorderError(code: "RECORDER_DEALLOCATED", message: "Window recorder was released during capture startup"))
                    return
                }
                self.beginCaptureStart(stream: stream, identity: identity, continuation: continuation)
            }
        }
    }

    private func beginCaptureStart(stream: SCStream, identity: WindowIdentity, continuation: CheckedContinuation<Void, Error>) {
        guard !finished, !stopRequested else {
            continuation.resume(throwing: terminalFailure ?? RecorderError(code: "STOPPED_BEFORE_START", message: "Stop was requested before ScreenCaptureKit startup completed"))
            return
        }
        self.identity = identity
        self.stream = stream
        captureStartInFlight = true
        stream.startCapture(completionHandler: { [weak self] error in
            guard let self else {
                continuation.resume(throwing: RecorderError(code: "RECORDER_DEALLOCATED", message: "Window recorder was released during capture startup"))
                return
            }
            self.queue.async { [weak self] in
                self?.captureDidStart(error, continuation: continuation)
            }
        })
    }

    private func captureDidStart(_ error: Error?, continuation: CheckedContinuation<Void, Error>) {
        captureStartInFlight = false
        if let error {
            finished = true
            continuation.resume(throwing: terminalFailure ?? RecorderError(code: "CAPTURE_START_FAILED", message: error.localizedDescription))
            return
        }

        continuation.resume()
        if stopRequested {
            stopCaptureAndFinalize()
        }
    }

    func requestStop() {
        queue.async { [weak self] in self?.beginStop() }
    }

    func requestFailure(_ error: RecorderError) {
        queue.async { [weak self] in self?.beginStop(failure: error) }
    }

    private func waitForUniqueWindow() async throws -> SCWindow {
        let deadline = Date().addingTimeInterval(Double(args.timeoutMs) / 1000.0)
        while Date() <= deadline {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            let matches = content.windows.filter { window in
                window.owningApplication?.processID == args.chromePid &&
                window.title == args.expectedWindowTitle &&
                window.isOnScreen &&
                window.frame.width > 1 && window.frame.height > 1
            }
            if matches.count == 1 { return matches[0] }
            if matches.count > 1 {
                throw RecorderError(code: "WINDOW_AMBIGUOUS", message: "More than one Chrome window matched the Browser Forge PID/title identity")
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        throw RecorderError(code: "WINDOW_NOT_FOUND", message: "No on-screen Chrome window matched the Browser Forge PID/title identity before timeout")
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .screen else { return }
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }
        guard let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        guard !stopRequested else { return }

        do {
            if writer == nil {
                try beginWriter(sampleBuffer: sampleBuffer, imageBuffer: imageBuffer)
            }
            guard let writerInput, writerInput.isReadyForMoreMediaData else { return }
            let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            let commitsFirstFrame = firstPTS == nil
            if commitsFirstFrame {
                writer?.startSession(atSourceTime: pts)
            }
            guard writerInput.append(sampleBuffer) else {
                throw RecorderError(code: "VIDEO_APPEND_FAILED", message: writer?.error?.localizedDescription ?? "AVAssetWriterInput rejected a captured frame")
            }
            lastPTS = pts
            if commitsFirstFrame {
                firstPTS = pts
                startEpochMs = epochForFirstFrame(pts)
                emit(["type": "started", "startEpochMs": startEpochMs!, "window": identity!.json()])
            }
        } catch let error as RecorderError {
            fail(error)
        } catch {
            fail(RecorderError(code: "RECORDER_FAILED", message: error.localizedDescription))
        }
    }

    private func beginWriter(sampleBuffer: CMSampleBuffer, imageBuffer: CVImageBuffer) throws {
        try? FileManager.default.removeItem(at: args.outputURL)
        let width = CVPixelBufferGetWidth(imageBuffer)
        let height = CVPixelBufferGetHeight(imageBuffer)
        let outputSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height
        ]
        let newWriter = try AVAssetWriter(outputURL: args.outputURL, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: outputSettings, sourceFormatHint: CMSampleBufferGetFormatDescription(sampleBuffer))
        input.expectsMediaDataInRealTime = true
        guard newWriter.canAdd(input) else {
            throw RecorderError(code: "WRITER_SETUP_FAILED", message: "AVAssetWriter cannot add H.264 video input")
        }
        newWriter.add(input)
        guard newWriter.startWriting() else {
            throw RecorderError(code: "WRITER_SETUP_FAILED", message: newWriter.error?.localizedDescription ?? "AVAssetWriter failed to start")
        }
        writer = newWriter
        writerInput = input
    }

    private func epochForFirstFrame(_ pts: CMTime) -> Int64 {
        let hostNow = CMClockGetTime(CMClockGetHostTimeClock())
        let deltaMs = CMTimeGetSeconds(CMTimeSubtract(pts, hostNow)) * 1000.0
        return Int64((Date().timeIntervalSince1970 * 1000.0 + deltaMs).rounded())
    }

    private func beginStop(failure: RecorderError? = nil) {
        guard !finished else { return }
        if let failure, terminalFailure == nil {
            terminalFailure = failure
        }
        guard !stopRequested else { return }
        stopRequested = true
        guard !captureStartInFlight else { return }
        stopCaptureAndFinalize()
    }

    private func stopCaptureAndFinalize() {
        let stopped: @Sendable (Error?) -> Void = { [weak self] stopCaptureError in
            guard let self else { return }
            self.queue.async { [weak self] in
                self?.captureDidStop(stopCaptureError)
            }
        }
        if let stream {
            stream.stopCapture(completionHandler: stopped)
        } else {
            stopped(nil)
        }
    }

    private func captureDidStop(_ stopCaptureError: Error?) {
        guard !finished else { return }
        if let stopCaptureError, terminalFailure == nil {
            terminalFailure = RecorderError(code: "CAPTURE_STOP_FAILED", message: stopCaptureError.localizedDescription)
        }
        guard !finalizationStarted else { return }
        finalizationStarted = true

        writerInput?.markAsFinished()
        guard let writer, firstPTS != nil, lastPTS != nil, identity != nil else {
            finished = true
            let terminalError = terminalFailure ?? RecorderError(code: "FIRST_FRAME_NOT_WRITTEN", message: "Stop requested before a first video frame was persisted")
            emitPreStartFailure(code: terminalError.code, message: terminalError.message)
            return
        }
        writer.finishWriting { [weak self] in
            guard let self else { return }
            self.queue.async { [weak self] in
                self?.finalizeWriter()
            }
        }
    }

    private func finalizeWriter() {
        guard !finished else { return }
        guard let writer, let first = firstPTS, let last = lastPTS, let identity else {
            finished = true
            emitPreStartFailure(code: "WRITER_STATE_LOST", message: "Video writer state was unavailable during finalization")
            return
        }
        finished = true

        let duration = max(0, Int64((CMTimeGetSeconds(CMTimeSubtract(last, first)) * 1000.0).rounded()))
        let playable = writer.status == .completed && isPlayableVideo()
        let state: String
        if playable && terminalFailure == nil {
            state = "complete"
        } else if playable {
            // Capture or parent-pipe failure occurred, but AVFoundation finalized a
            // playable prefix. Never silently upgrade that prefix to complete.
            state = "partial"
        } else {
            state = "failed"
        }

        var message: [String: Any] = [
            "type": "completed",
            "state": state,
            "durationMs": state == "failed" ? 0 : duration,
            "coveredUntilOffsetMs": state == "failed" ? 0 : duration,
            "window": identity.json()
        ]
        if state != "failed" {
            message["sourcePath"] = args.outputURL.path
        }
        emit(message)
        // A completed protocol response is final even when the video material
        // is failed. JS can then persist a failed manifest instead of hanging.
        exit(0)
    }

    private func isPlayableVideo() -> Bool {
        guard FileManager.default.fileExists(atPath: args.outputURL.path) else { return false }
        let asset = AVURLAsset(url: args.outputURL)
        return asset.isPlayable && !asset.tracks(withMediaType: .video).isEmpty
    }

    private func emitPreStartFailure(code: String, message: String) {
        emit(["type": "error", "code": code, "message": message])
        exit(1)
    }

    private func fail(_ error: RecorderError) {
        beginStop(failure: error)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        requestFailure(RecorderError(code: "CAPTURE_STOPPED", message: error.localizedDescription))
    }
}

@main
struct Main {
    static func main() async {
        do {
            let args = try RecorderArguments()
            let recorder = WindowRecorder(args: args)
            FileHandle.standardInput.readabilityHandler = { handle in
                let data = handle.availableData
                if data.isEmpty {
                    handle.readabilityHandler = nil
                    recorder.requestFailure(RecorderError(code: "STDIN_CLOSED", message: "Browser Forge parent pipe closed before a clean stop request"))
                    return
                }
                guard let line = String(data: data, encoding: .utf8), line.contains("\"type\":\"stop\"") else { return }
                handle.readabilityHandler = nil
                recorder.requestStop()
            }
            try await recorder.start()
            dispatchMain()
        } catch let error as RecorderError {
            emit(["type": "error", "code": error.code, "message": error.message])
            exit(1)
        } catch {
            emit(["type": "error", "code": "RECORDER_FAILED", "message": error.localizedDescription])
            exit(1)
        }
    }
}
