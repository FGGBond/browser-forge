import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct Arguments {
    let input: URL
    let offsetMs: Int64
    let output: URL

    init() throws {
        var values: [String: String] = [:]
        var index = 1
        let args = CommandLine.arguments
        while index + 1 < args.count {
            values[args[index]] = args[index + 1]
            index += 2
        }
        guard let rawInput = values["--input"], let rawOutput = values["--output"],
              let rawOffset = values["--offset-ms"], let offset = Int64(rawOffset), offset >= 0 else {
            throw CliError(code: "INVALID_ARGUMENT", message: "Usage: bf-video-frame --input <mp4> --offset-ms <non-negative-ms> --output <png>")
        }
        input = URL(fileURLWithPath: rawInput)
        output = URL(fileURLWithPath: rawOutput)
        offsetMs = offset
    }
}

struct CliError: Error {
    let code: String
    let message: String
}

func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value), let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

@main
struct Main {
    static func main() {
        do {
            let arguments = try Arguments()
            guard FileManager.default.fileExists(atPath: arguments.input.path) else {
                throw CliError(code: "VIDEO_FILE_NOT_FOUND", message: "Input MP4 does not exist")
            }
            if FileManager.default.fileExists(atPath: arguments.output.path) {
                throw CliError(code: "OUTPUT_ALREADY_EXISTS", message: "Refusing to overwrite existing output")
            }

            let asset = AVURLAsset(url: arguments.input)
            let generator = AVAssetImageGenerator(asset: asset)
            generator.appliesPreferredTrackTransform = true
            generator.requestedTimeToleranceBefore = .zero
            generator.requestedTimeToleranceAfter = .zero

            let requested = CMTime(value: arguments.offsetMs, timescale: 1000)
            var actual = CMTime.zero
            let image = try generator.copyCGImage(at: requested, actualTime: &actual)

            guard let destination = CGImageDestinationCreateWithURL(arguments.output as CFURL, UTType.png.identifier as CFString, 1, nil) else {
                throw CliError(code: "EXTRACTION_FAILED", message: "Unable to create PNG output")
            }
            CGImageDestinationAddImage(destination, image, nil)
            guard CGImageDestinationFinalize(destination) else {
                throw CliError(code: "EXTRACTION_FAILED", message: "Unable to finalize PNG output")
            }

            emit([
                "requestedOffsetMs": arguments.offsetMs,
                "actualOffsetMs": Int64((CMTimeGetSeconds(actual) * 1000.0).rounded()),
                "output": arguments.output.path,
                "width": image.width,
                "height": image.height
            ])
        } catch let error as CliError {
            emit(["type": "error", "code": error.code, "message": error.message])
            exit(1)
        } catch {
            emit(["type": "error", "code": "EXTRACTION_FAILED", "message": error.localizedDescription])
            exit(1)
        }
    }
}
