import SwiftUI
import WhispCore

/**
 * What clicking the menu bar icon shows: status, the one switch people flip
 * most (on-device or OpenAI), the last few dictations to copy, and the way
 * to Settings.
 */
struct MenuBarPopover: View {
    @Bindable var model: AppModel
    let windows: WindowManager

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            engineSwitch
            if !model.history.isEmpty || model.lastTranscript != nil {
                recent
            }
            Divider()
            HStack {
                Button("Settings…") { windows.showSettings() }
                    .keyboardShortcut(",")
                Spacer()
                Button("Quit whisp") { NSApp.terminate(nil) }
                    .keyboardShortcut("q")
            }
            .buttonStyle(.borderless)
        }
        .padding(16)
        .frame(width: 320)
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: statusSymbol)
                .font(.title2)
                .foregroundStyle(statusColor)
                .contentTransition(.symbolEffect(.replace))
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text("whisp").font(.headline)
                Text(statusText)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Toggle(isOn: $model.muted) {
                Image(systemName: model.muted ? "mic.slash.fill" : "mic.fill")
            }
            .toggleStyle(.button)
            .help(model.muted ? "Unmute whisp" : "Mute whisp until you unmute or restart it")
        }
    }

    @ViewBuilder
    private var engineSwitch: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker("Engine", selection: engine) {
                Text("On-device").tag(TranscriberEngine.apple)
                Text("OpenAI").tag(TranscriberEngine.openai)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            if model.settings.transcriber == .apple {
                Picker("Language", selection: $model.settings.appleLanguage) {
                    ForEach(DictationLanguage.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .controlSize(.small)
            }
            if let problem = engineProblem {
                Button {
                    windows.showSettings(.engines)
                } label: {
                    Label(problem, systemImage: "exclamationmark.circle")
                        .font(.caption)
                }
                .buttonStyle(.link)
            }
        }
    }

    private var recent: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Recent")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            let items = model.history.isEmpty
                ? (model.lastTranscript.map { [$0] } ?? [])
                : model.history.prefix(3).map(\.text)
            ForEach(Array(items.enumerated()), id: \.offset) { _, text in
                RecentRow(text: text)
            }
        }
    }

    /**
     * The quick switch moves transcription and cleanup together — the point
     * is "all on this Mac" or "all OpenAI". Cleanup that was off stays off.
     */
    private var engine: Binding<TranscriberEngine> {
        Binding {
            model.settings.transcriber
        } set: { engine in
            model.settings.transcriber = engine
            if model.settings.cleaner != .off {
                model.settings.cleaner = engine == .apple ? .apple : .openai
            }
        }
    }

    private var engineProblem: String? {
        switch model.settings.transcriber {
        case .apple:
            switch model.appleModelState {
            case .installed: return nil
            case .downloading: return "Downloading the \(model.settings.appleLanguage.label) model…"
            case .notInstalled: return "Download the \(model.settings.appleLanguage.label) model"
            case .unsupported: return "Not available on this Mac"
            }
        case .openai:
            return model.hasKey ? nil : "Add your OpenAI API key"
        }
    }

    private var statusSymbol: String {
        if !model.hotkeyActive { return "exclamationmark.triangle.fill" }
        if model.muted { return "mic.slash.circle.fill" }
        return switch model.phase {
        case .idle: "waveform.circle"
        case .listening: "waveform.circle.fill"
        case .handsFree: "infinity.circle.fill"
        case .transcribing: "ellipsis.circle.fill"
        }
    }

    private var statusColor: Color {
        if !model.hotkeyActive { return .yellow }
        if model.muted { return .secondary }
        return switch model.phase {
        case .idle: .accentColor
        case .listening: .red
        case .handsFree: .orange
        case .transcribing: .accentColor
        }
    }

    private var statusText: String {
        if !model.hotkeyActive { return "Needs Accessibility permission" }
        if model.muted { return "Muted" }
        return switch model.phase {
        case .idle: "Hold \(model.settings.hotkey.shortName) to dictate"
        case .listening: "Listening…"
        case .handsFree: "Hands-free — tap to finish"
        case .transcribing: "Transcribing…"
        }
    }
}

private struct RecentRow: View {
    let text: String
    @ViewState private var copied = false

    var body: some View {
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            copied = true
            Task {
                try? await Task.sleep(for: .seconds(1.2))
                copied = false
            }
        } label: {
            HStack(alignment: .firstTextBaseline) {
                Text(text)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .foregroundStyle(.secondary)
                    .contentTransition(.symbolEffect(.replace))
            }
            .padding(.vertical, 6)
            .padding(.horizontal, 8)
            .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .help("Copy")
    }
}

extension HotkeyChoice {
    var shortName: String {
        switch self {
        case .fn: "🌐"
        case .rightOption: "right ⌥"
        case .controlOption: "⌃⌥"
        }
    }
}
