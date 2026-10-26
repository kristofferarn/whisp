import AVFoundation
import SwiftUI

struct GeneralPane: View {
    @Bindable var model: AppModel

    var body: some View {
        Form {
            Section {
                Toggle("Open whisp at login", isOn: $model.settings.launchAtLogin)
                Toggle("Play a sound when the microphone opens", isOn: $model.settings.chime)
            }
            Section {
                Toggle("Keep a history of dictations", isOn: $model.settings.keepHistory)
            } footer: {
                Text("History stays on this Mac. Turning it off also deletes what's there. Stats are counts only and are kept either way.")
            }
            Section("Permissions") {
                PermissionsList()
            }
        }
        .formStyle(.grouped)
    }
}

/** The three grants, each live — the list updates as they are given. */
struct PermissionsList: View {
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            PermissionRow(
                title: "Microphone",
                detail: "To hear you while you hold the key.",
                granted: Permissions.microphone == .authorized
            ) {
                if Permissions.microphone == .notDetermined {
                    Task { _ = await Permissions.requestMicrophone() }
                } else {
                    Permissions.open(.microphone)
                }
            }
            PermissionRow(
                title: "Accessibility",
                detail: "To notice the dictation key and paste with ⌘V.",
                granted: Permissions.accessibility
            ) {
                Permissions.promptAccessibility()
                Permissions.open(.accessibility)
            }
            if !Permissions.inputMonitoring {
                PermissionRow(
                    title: "Input Monitoring",
                    detail: "Only if the key still isn't noticed after Accessibility is on.",
                    granted: false,
                    optional: true
                ) {
                    Permissions.requestInputMonitoring()
                    Permissions.open(.inputMonitoring)
                }
            }
        }
    }
}

struct PermissionRow: View {
    let title: String
    let detail: String
    let granted: Bool
    var optional = false
    let grant: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: granted ? "checkmark.circle.fill" : (optional ? "circle.dashed" : "circle"))
                .font(.title3)
                .foregroundStyle(granted ? .green : .secondary)
                .contentTransition(.symbolEffect(.replace))
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if !granted {
                Button("Grant…", action: grant)
            }
        }
    }
}
