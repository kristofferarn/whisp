import AudioToolbox
import AVFoundation

/**
 * The microphone, open for exactly as long as a take records. A fresh engine
 * per take keeps the orange recording dot honest — it is lit only while you
 * are actually dictating — and lets a newly chosen microphone apply at once.
 */
final class Recorder {
    enum Failure: LocalizedError {
        case noInput
        var errorDescription: String? { "No microphone is available" }
    }

    private var engine: AVAudioEngine?

    var isRecording: Bool { engine != nil }

    func start(microphoneUID: String?, into capture: TakeCapture) throws {
        stop()
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
        input.installTap(onBus: 0, bufferSize: 1024, format: format, block: Self.tap(into: capture))
        engine.prepare()
        try engine.start()
        self.engine = engine
    }

    func stop() {
        guard let engine else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        self.engine = nil
    }

    /**
     * Built outside the main actor on purpose: the block runs on the audio
     * thread, and a closure formed in a main-actor method would carry that
     * isolation with it and trap the first time audio arrives.
     */
    nonisolated private static func tap(into capture: TakeCapture) -> AVAudioNodeTapBlock {
        { buffer, _ in capture.append(native: buffer) }
    }
}
