import AudioToolbox
import CoreAudio

/**
 * Turns the default output down while the microphone is open, then puts it
 * back — but only if nobody touched the volume in between: someone who
 * turned it up mid-take meant it.
 */
final class AudioDucker {
    /** What's left of the volume while ducked. */
    private static let factor: Float32 = 0.3

    private var saved: (device: AudioDeviceID, original: Float32, ducked: Float32)?

    func lower() {
        guard saved == nil, let device = AudioDevices.defaultOutput(),
              let volume = Self.volume(device), volume > 0.05
        else { return }
        let ducked = volume * Self.factor
        guard Self.setVolume(device, ducked) else { return }
        saved = (device, volume, ducked)
    }

    func restore() {
        guard let saved else { return }
        self.saved = nil
        if let now = Self.volume(saved.device), abs(now - saved.ducked) < 0.02 {
            _ = Self.setVolume(saved.device, saved.original)
        }
    }

    private static var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwareServiceDeviceProperty_VirtualMainVolume,
        mScope: kAudioDevicePropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain
    )

    private static func volume(_ device: AudioDeviceID) -> Float32? {
        var value: Float32 = 0
        var size = UInt32(MemoryLayout<Float32>.size)
        var address = address
        guard AudioObjectHasProperty(device, &address),
              AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value) == noErr
        else { return nil }
        return value
    }

    private static func setVolume(_ device: AudioDeviceID, _ value: Float32) -> Bool {
        var value = value
        var address = address
        return AudioObjectSetPropertyData(device, &address, 0, nil, UInt32(MemoryLayout<Float32>.size), &value) == noErr
    }
}
