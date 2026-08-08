import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

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

final class WindowRecorder: NSObject, SCStreamOutput, SCStreamDelegate {
    private let args: RecorderArguments
    private let queue = DispatchQueue(label: "com.browserforge.window-recorder")
    private var stream: SCStream?
    private var writer: AVAssetWriter?
    private var writerInput: AVAssetWriterInput?
    private var firstPTS: CMTime?
    private var lastPTS: CMTime?
    private var startEpochMs: Int64?
    private var identity: WindowIdentity?
    private var terminal = false

    init(args: RecorderArguments) {
        self.args = args
        super.init()
    }

    func start() async throws {
        let target = try await waitForUniqueWindow()
        identity = WindowIdentity(pid: target.owningApplication!.processID, windowId: target.windowID, title: target.title ?? "")

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
        stream = captureStream
        try await captureStream.startCapture()
    }

    func requestStop() {
        queue.async { [weak self] in self?.finish(state: "complete") }
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
        guard !terminal else { return }

        do {
            if writer == nil {
                try beginWriter(sampleBuffer: sampleBuffer, imageBuffer: imageBuffer)
            }
            guard let writerInput, writerInput.isReadyForMoreMediaData else { return }
            guard writerInput.append(sampleBuffer) else {
                throw RecorderError(code: "VIDEO_APPEND_FAILED", message: writer?.error?.localizedDescription ?? "AVAssetWriterInput rejected a captured frame")
            }
            lastPTS = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            if startEpochMs == nil, let firstPTS {
                startEpochMs = epochForFirstFrame(firstPTS)
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
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        newWriter.startSession(atSourceTime: pts)
        writer = newWriter
        writerInput = input
        firstPTS = pts
    }

    private func epochForFirstFrame(_ pts: CMTime) -> Int64 {
        let hostNow = CMClockGetTime(CMClockGetHostTimeClock())
        let deltaMs = CMTimeGetSeconds(CMTimeSubtract(pts, hostNow)) * 1000.0
        return Int64((Date().timeIntervalSince1970 * 1000.0 + deltaMs).rounded())
    }

    private func finish(state: String) {
        guard !terminal else { return }
        terminal = true
        stream?.stopCapture { [weak self] _ in
            guard let self else { return }
            self.writerInput?.markAsFinished()
            guard let writer = self.writer, let first = self.firstPTS, let last = self.lastPTS else {
                emit(["type": "error", "code": "FIRST_FRAME_NOT_WRITTEN", "message": "Stop requested before a first video frame was persisted"])
                exit(1)
            }
            writer.finishWriting {
                let duration = max(0, Int64((CMTimeGetSeconds(CMTimeSubtract(last, first)) * 1000.0).rounded()))
                let finalState = writer.status == .completed ? state : "partial"
                emit([
                    "type": "completed",
                    "state": finalState,
                    "durationMs": duration,
                    "coveredUntilOffsetMs": duration,
                    "sourcePath": self.args.outputURL.path,
                    "window": self.identity!.json()
                ])
                exit(writer.status == .failed ? 1 : 0)
            }
        }
    }

    private func fail(_ error: RecorderError) {
        guard !terminal else { return }
        terminal = true
        stream?.stopCapture { _ in
            emit(["type": "error", "code": error.code, "message": error.message])
            exit(1)
        }
        if stream == nil {
            emit(["type": "error", "code": error.code, "message": error.message])
            exit(1)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fail(RecorderError(code: "CAPTURE_STOPPED", message: error.localizedDescription))
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
                guard let line = String(data: data, encoding: .utf8), line.contains("\"type\":\"stop\"") else { return }
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
