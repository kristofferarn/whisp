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
 *
 * That switch also changes the microphone's format under the engine's feet
 * (AirPods go to 24 kHz), so the tap never names a format — it takes
 * whatever the node delivers, and the capture converts. Naming one that has
 * gone stale makes AVAudioEngine throw an Objective-C exception, which no
 * Swift code can catch. When the route changes mid-take (a headset connects
 * or drops), the engine stops itself; it is rebuilt and the take carries on.
 */
nonisolated final class Recorder: @unchecked Sendable {
    enum Failure: LocalizedError {
        case noInput
        var errorDescription: String? { "No microphone is available" }
    }

    private let queue = DispatchQueue(label: "whisp.recorder", qos: .userInteractive)
    // Queue only.
    private var engine: AVAudioEngine?
    private var current: (microphoneUID: String?, capture: TakeCapture)?
    private var observer: NSObjectProtocol?

    func start(microphoneUID: String?, into capture: TakeCapture, failed: @escaping @Sendable (Error) -> Void) {
        queue.async { [self] in
            stopEngine()
            current = (microphoneUID, capture)
            let began = ProcessInfo.processInfo.systemUptime
            do {
                try startEngine()
                let ms = Int((ProcessInfo.processInfo.systemUptime - began) * 1000)
                Log.audio.info("microphone opened in \(ms) ms")
            } catch {
                Log.audio.error("microphone failed to open: \(error.localizedDescription, privacy: .public)")
                current = nil
                failed(error)
            }
        }
    }

    func stop() {
        queue.async { [self] in
            current = nil
            stopEngine()
        }
    }

    private func startEngine() throws {
        guard let current else { return }
        let engine = AVAudioEngine()
        let input = engine.inputNode
        // A chosen microphone that is plugged in wins; one that has gone away
        // falls back to the system default rather than failing the take.
        if let uid = current.microphoneUID, var device = AudioDevices.deviceID(forUID: uid), let unit = input.audioUnit {
            AudioUnitSetProperty(
                unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
                &device, UInt32(MemoryLayout<AudioDeviceID>.size)
            )
        }
        let hardware = input.inputFormat(forBus: 0)
        guard hardware.sampleRate > 0, hardware.channelCount > 0 else { throw Failure.noInput }
        let capture = current.capture
        input.installTap(onBus: 0, bufferSize: 1024, format: nil) { buffer, _ in
            capture.append(native: buffer)
        }
        observer = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
        ) { [weak self] _ in
            guard let self else { return }
            queue.async { self.restartAfterRouteChange() }
        }
        engine.prepare()
        try engine.start()
        self.engine = engine
    }

    private func restartAfterRouteChange() {
        guard current != nil else { return }
        Log.audio.info("audio route changed mid-take; reopening the microphone")
        stopEngine()
        do {
            try startEngine()
        } catch {
            Log.audio.error("microphone could not reopen: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func stopEngine() {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        guard let engine else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        self.engine = nil
    }
}
