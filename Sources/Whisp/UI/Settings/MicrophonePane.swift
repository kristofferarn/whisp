import SwiftUI

struct MicrophonePane: View {
    @Bindable var model: AppModel
    @ViewState private var devices = AudioDevices.inputs()

    /** The microphone the next take will open, as the recorder will resolve it. */
    private var inUse: String {
        _ = devices // re-evaluate when the device list refreshes
        let settings = model.settings
        if let device = AudioDevices.resolveInput(uid: settings.microphoneUID, avoidBluetooth: settings.preferBuiltInMicrophone) {
            return device.name
        }
        return AudioDevices.defaultInput()?.name ?? "No microphone"
    }

    var body: some View {
        Form {
            Section {
                Picker("Input", selection: $model.settings.microphoneUID) {
                    Text("System default").tag(String?.none)
                    ForEach(devices, id: \.uid) { device in
                        Text(device.name).tag(String?.some(device.uid))
                    }
                    if let uid = model.settings.microphoneUID, !devices.contains(where: { $0.uid == uid }) {
                        Text("Disconnected microphone").tag(String?.some(uid))
                    }
                }
                Toggle("Use the Mac's microphone instead of Bluetooth headsets", isOn: $model.settings.preferBuiltInMicrophone)
                    .disabled(model.settings.microphoneUID != nil)
                LabeledContent("Dictating with") {
                    Text(inUse).foregroundStyle(.secondary)
                }
            } footer: {
                Text("A chosen microphone is used whenever it's connected; otherwise whisp follows the system default. Opening AirPods' or another headset's microphone switches it to call mode: a second of silence before it hears you, and call-quality sound for everything else until you're done. The Mac's own microphone avoids both.")
            }
            Section {
                Toggle("Turn other audio down while dictating", isOn: $model.settings.lowerAudio)
            } footer: {
                Text("Music and videos drop to a third of their volume while the microphone is open, then come back — unless you changed the volume yourself in the meantime.")
            }
        }
        .formStyle(.grouped)
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            devices = AudioDevices.inputs()
        }
    }
}
