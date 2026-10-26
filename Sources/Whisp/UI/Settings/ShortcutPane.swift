import SwiftUI
import WhispCore

struct ShortcutPane: View {
    @Bindable var model: AppModel

    var body: some View {
        Form {
            Section {
                Picker("Dictation key", selection: $model.settings.hotkey) {
                    ForEach(HotkeyChoice.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                Toggle("Double-tap for hands-free", isOn: $model.settings.handsFree)
                LabeledContent("Status") {
                    if model.hotkeyActive {
                        Label("Listening for the key", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    } else {
                        Label("Needs Accessibility permission", systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                    }
                }
            } footer: {
                Text("Pressing another key while the dictation key is held (like Fn+← or Fn+Delete) cancels that take, so the key keeps working as a modifier.")
            }

            if model.settings.hotkey == .fn {
                Section {
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: "globe")
                            .font(.title2)
                            .foregroundStyle(.tint)
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Free up the 🌐 key")
                                .font(.headline)
                            Text("In Keyboard settings, set **Press 🌐 key to** to **Do Nothing**. Otherwise macOS opens its own dictation or the emoji picker when you use the key with whisp.")
                                .foregroundStyle(.secondary)
                            Button("Open Keyboard Settings") { Permissions.open(.keyboard) }
                        }
                    }
                    .padding(.vertical, 4)
                }
            }

            Section("Gestures") {
                GestureRow(keys: "Hold \(model.settings.hotkey.shortName)", action: "Dictate; release to paste")
                if model.settings.handsFree {
                    GestureRow(keys: "Double-tap \(model.settings.hotkey.shortName)", action: "Hands-free; tap again to paste")
                }
                GestureRow(keys: "esc", action: "Cancel the take")
                GestureRow(keys: "⌃⌘V", action: "Paste the last dictation again")
            }
        }
        .formStyle(.grouped)
    }
}

private struct GestureRow: View {
    let keys: String
    let action: String

    var body: some View {
        LabeledContent(action) {
            Text(keys)
                .font(.callout.monospaced())
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(.quaternary, in: .rect(cornerRadius: 6))
        }
    }
}
