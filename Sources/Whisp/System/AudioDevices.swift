import CoreAudio
import Foundation

/** Input devices as CoreAudio sees them, identified by their stable UID. */
nonisolated enum AudioDevices {
    struct Device: Identifiable, Hashable, Sendable {
        let id: AudioDeviceID
        let uid: String
        let name: String
        let transport: UInt32

        var isBluetooth: Bool {
            transport == kAudioDeviceTransportTypeBluetooth || transport == kAudioDeviceTransportTypeBluetoothLE
        }

        var isBuiltIn: Bool { transport == kAudioDeviceTransportTypeBuiltIn }
    }

    static func inputs() -> [Device] {
        allDeviceIDs().compactMap { id in
            guard hasInput(id), let uid = string(id, kAudioDevicePropertyDeviceUID),
                  let name = string(id, kAudioObjectPropertyName)
            else { return nil }
            return Device(id: id, uid: uid, name: name, transport: uint32(id, kAudioDevicePropertyTransportType) ?? 0)
        }
    }

    /**
     * The microphone a take should open: the chosen one while it's connected;
     * otherwise the system default — unless that is a Bluetooth headset and
     * `avoidBluetooth` is on, in which case the Mac's built-in microphone, if
     * there is one (a closed lid has none). Nil means "leave the default".
     */
    static func resolveInput(uid: String?, avoidBluetooth: Bool) -> Device? {
        let devices = inputs()
        if let uid, let chosen = devices.first(where: { $0.uid == uid }) { return chosen }
        guard avoidBluetooth, let defaultID = defaultDevice(kAudioHardwarePropertyDefaultInputDevice),
              devices.first(where: { $0.id == defaultID })?.isBluetooth == true
        else { return nil }
        return devices.first(where: \.isBuiltIn)
    }

    static func defaultInput() -> Device? {
        guard let id = defaultDevice(kAudioHardwarePropertyDefaultInputDevice) else { return nil }
        return inputs().first { $0.id == id }
    }

    static func defaultOutput() -> AudioDeviceID? {
        defaultDevice(kAudioHardwarePropertyDefaultOutputDevice)
    }

    private static func defaultDevice(_ selector: AudioObjectPropertySelector) -> AudioDeviceID? {
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id)
        return status == noErr && id != 0 ? id : nil
    }

    private static func allDeviceIDs() -> [AudioDeviceID] {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        let system = AudioObjectID(kAudioObjectSystemObject)
        guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids) == noErr else { return [] }
        return ids
    }

    private static func hasInput(_ id: AudioDeviceID) -> Bool {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreams,
            mScope: kAudioDevicePropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        return AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size) == noErr && size > 0
    }

    private static func uint32(_ id: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> UInt32? {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr ? value : nil
    }

    private static func string(_ id: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String? {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr,
              let string = value?.takeRetainedValue()
        else { return nil }
        return string as String
    }
}
