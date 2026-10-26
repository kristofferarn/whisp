import SwiftUI

struct MicrophonePane: View {
    @Bindable var model: AppModel
    @ViewState private var devices = AudioDevices.inputs()

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
            } footer: {
                Text("A chosen microphone is used whenever it's connected; when it isn't, whisp uses the system default.")
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
