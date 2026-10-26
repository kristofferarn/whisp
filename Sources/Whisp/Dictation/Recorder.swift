import AVFoundation
import CoreMedia

/**
 * The microphone, open for exactly as long as a take records — the orange
 * recording dot is lit only while you are dictating.
 *
 * Built on AVCaptureSession rather than AVAudioEngine. Pointing an engine's
 * input at a particular microphone fires the engine's own "route changed"
 * notification, invalidates the formats it has already reported, and leaves
 * the next start failing with "format not supported". A capture session is
 * made for opening one specific device: it takes the microphone by its ID,
 * leaves the system default alone, and converts to the format asked for
 * (16 kHz mono float) before handing the audio over.
 *
 * Opening happens on a serial queue of its own, since it can take a moment;
 * the take is live from the caller's point of view as soon as `start`
 * returns, and the capture reports its first buffer when audio really flows.
 */
nonisolated final class Recorder: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate, @unchecked Sendable {
    enum Failure: LocalizedError {
        case noInput
        case unusable(String)

        var errorDescription: String? {
            switch self {
            case .noInput: "No microphone is available"
            case .unusable(let name): "\(name) can't be used for recording"
            }
        }
    }

    private let control = DispatchQueue(label: "whisp.recorder", qos: .userInteractive)
    private let delivery = DispatchQueue(label: "whisp.recorder.audio", qos: .userInteractive)
    private let lock = NSLock()
    // Control queue only.
    private var session: AVCaptureSession?
    // Under lock: read on the delivery queue.
    private var capture: TakeCapture?

    func start(
        microphoneUID: String?, avoidBluetooth: Bool, into capture: TakeCapture,
        failed: @escaping @Sendable (Error) -> Void
    ) {
        control.async { [self] in
            stopSession()
            let began = ProcessInfo.processInfo.systemUptime
            do {
                let device = try Self.device(microphoneUID: microphoneUID, avoidBluetooth: avoidBluetooth)
                let session = try makeSession(device)
                lock.withLock { self.capture = capture }
                session.startRunning()
                self.session = session
                let ms = Int((ProcessInfo.processInfo.systemUptime - began) * 1000)
                Log.audio.info("\(device.localizedName, privacy: .public) opened in \(ms) ms")
            } catch {
                Log.audio.error("microphone failed to open: \(error.localizedDescription, privacy: .public)")
                failed(error)
            }
        }
    }

    func stop() {
        control.async { [self] in stopSession() }
    }

    /** The chosen microphone while it's connected, else the default — with a Bluetooth default traded for the built-in mic when asked. */
    private static func device(microphoneUID: String?, avoidBluetooth: Bool) throws -> AVCaptureDevice {
        if let resolved = AudioDevices.resolveInput(uid: microphoneUID, avoidBluetooth: avoidBluetooth),
           let device = AVCaptureDevice(uniqueID: resolved.uid) {
            return device
        }
        guard let device = AVCaptureDevice.default(for: .audio) else { throw Failure.noInput }
        return device
    }

    private func makeSession(_ device: AVCaptureDevice) throws -> AVCaptureSession {
        let session = AVCaptureSession()
        let input = try AVCaptureDeviceInput(device: device)
        let output = AVCaptureAudioDataOutput()
        output.audioSettings = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: TakeCapture.sampleRate,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsNonInterleaved: true,
            AVLinearPCMIsBigEndianKey: false
        ]
        output.setSampleBufferDelegate(self, queue: delivery)
        session.beginConfiguration()
        guard session.canAddInput(input), session.canAddOutput(output) else {
            session.commitConfiguration()
            throw Failure.unusable(device.localizedName)
        }
        session.addInput(input)
        session.addOutput(output)
        session.commitConfiguration()
        return session
    }

    private func stopSession() {
        lock.withLock { capture = nil }
        guard let session else { return }
        session.stopRunning()
        self.session = nil
    }

    // MARK: Delivery queue

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let capture = lock.withLock({ capture }), let buffer = Self.pcmBuffer(sampleBuffer) else { return }
        if buffer.format == TakeCapture.format {
            capture.append(converted: buffer)
        } else {
            capture.append(native: buffer)
        }
    }

    private static func pcmBuffer(_ sampleBuffer: CMSampleBuffer) -> AVAudioPCMBuffer? {
        guard let description = CMSampleBufferGetFormatDescription(sampleBuffer),
              let stream = CMAudioFormatDescriptionGetStreamBasicDescription(description),
              let format = AVAudioFormat(streamDescription: stream)
        else { return nil }
        let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return nil }
        buffer.frameLength = frames
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sampleBuffer, at: 0, frameCount: Int32(frames), into: buffer.mutableAudioBufferList
        )
        return status == noErr ? buffer : nil
    }
}
