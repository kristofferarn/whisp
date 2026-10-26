import AudioToolbox
import AVFoundation

/**
 * The microphone, open for exactly as long as a take records. A fresh engine
 * per take keeps the orange recording dot honest — lit only while you are
 * dictating — and lets a newly chosen microphone apply at once.
 *
 * Opening and closing happen on a serial queue of their own, because both
 * can block for a second: a Bluetooth headset has to switch from its music
 * profile to its headset profile before its microphone delivers anything.
 * The take is live from the caller's point of view the moment `start`
 * returns; audio simply starts arriving when the hardware is ready, and the
 * capture says so (its first buffer).
 */
nonisolated final class Recorder: @unchecked Sendable {
    enum Failure: LocalizedError {
        case noInput
        var errorDescription: String? { "No microphone is available" }
    }

    private let queue = DispatchQueue(label: "whisp.recorder", qos: .userInteractive)
    // Queue only.
    private var engine: AVAudioEngine?

    func start(microphoneUID: String?, into capture: TakeCapture, failed: @escaping @Sendable (Error) -> Void) {
        queue.async { [self] in
            stopEngine()
            let began = ProcessInfo.processInfo.systemUptime
            do {
                try startEngine(microphoneUID: microphoneUID, capture: capture)
                let ms = Int((ProcessInfo.processInfo.systemUptime - began) * 1000)
                Log.audio.info("microphone opened in \(ms) ms")
            } catch {
                Log.audio.error("microphone failed to open: \(error.localizedDescription, privacy: .public)")
                failed(error)
            }
        }
    }

    func stop() {
        queue.async { [self] in stopEngine() }
    }

    private func startEngine(microphoneUID: String?, capture: TakeCapture) throws {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        // A chosen microphone that is plugged in wins; one that has gone away
        // falls back to the system default rather than failing the take.
        if let uid = microphoneUID, var device = AudioDevices.deviceID(forUID: uid), let unit = input.audioUnit {
            AudioUnitSetProperty(
                unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
                &device, UInt32(MemoryLayout<AudioDeviceID>.size)
            )
        }
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw Failure.noInput }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            capture.append(native: buffer)
        }
        engine.prepare()
        try engine.start()
        self.engine = engine
    }

    private func stopEngine() {
        guard let engine else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        self.engine = nil
    }
}
