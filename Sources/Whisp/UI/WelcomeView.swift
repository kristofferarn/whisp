import SwiftUI
import WhispCore

/**
 * First run, in five short steps: what whisp is, the permissions, the key,
 * the engine, and a first dictation into a field right here — which proves
 * every piece works before you rely on it somewhere else.
 */
struct WelcomeView: View {
    @Bindable var model: AppModel
    let done: () -> Void

    private enum Step: Int, CaseIterable {
        case hello, permissions, key, engine, tryIt
    }

    @ViewState private var step = Step.hello
    @ViewState private var trial = ""
    @FocusState private var trialFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            Group {
                switch step {
                case .hello: hello
                case .permissions: permissions
                case .key: key
                case .engine: engine
                case .tryIt: tryIt
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .padding(.horizontal, 40)
            .padding(.top, 44)
            .transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)).combined(with: .opacity))
            .id(step)

            footer
        }
        .frame(width: 560, height: 520)
        .animation(.smooth(duration: 0.3), value: step)
        .task { await model.refreshAppleModels() }
    }

    // MARK: Steps

    private var hello: some View {
        VStack(spacing: 18) {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: 96, height: 96)
            Text("whisp").font(.largeTitle.weight(.semibold))
            Text("Hold a key, speak, let go — your words appear wherever you're typing.")
                .font(.title3)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 10) {
                Point(symbol: "hand.point.up.left", text: "Hold 🌐 to talk, release to paste")
                Point(symbol: "infinity", text: "Double-tap 🌐 to keep listening hands-free")
                Point(symbol: "lock.shield", text: "Transcribe on this Mac or with OpenAI — your choice")
            }
            .padding(.top, 8)
        }
    }

    private var permissions: some View {
        StepPage(symbol: "lock.open", title: "Two permissions", text: "whisp needs to hear you while the key is held, and to notice the key and paste for you.") {
            VStack(spacing: 0) {
                PermissionsList()
                    .padding(.vertical, 6)
            }
            .padding(.horizontal, 14)
            .background(.background.secondary, in: .rect(cornerRadius: 12))
        }
    }

    private var key: some View {
        StepPage(symbol: "globe", title: "Your dictation key", text: "🌐 Fn is right under your thumb. Pick another if you'd rather.") {
            VStack(alignment: .leading, spacing: 14) {
                Picker("Key", selection: $model.settings.hotkey) {
                    ForEach(HotkeyChoice.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                .pickerStyle(.radioGroup)
                .labelsHidden()
                if model.settings.hotkey == .fn {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("In Keyboard settings, set **Press 🌐 key to** to **Do Nothing**, so macOS doesn't react to the key too.")
                            .fixedSize(horizontal: false, vertical: true)
                        Button("Open Keyboard Settings") { Permissions.open(.keyboard) }
                    }
                    .padding(12)
                    .background(.background.secondary, in: .rect(cornerRadius: 12))
                }
            }
        }
    }

    private var engine: some View {
        StepPage(symbol: "cpu", title: "Where your words are heard", text: "You can switch any time from the menu bar.") {
            VStack(spacing: 10) {
                EngineChoice(
                    selected: model.settings.transcriber == .apple,
                    title: "On this Mac",
                    detail: "Free, private, offline. Live words as you speak. Cleanup by Apple Intelligence."
                ) {
                    model.settings.transcriber = .apple
                    model.settings.cleaner = AppleCleaner.isAvailable ? .apple : .off
                }
                EngineChoice(
                    selected: model.settings.transcriber == .openai,
                    title: "OpenAI",
                    detail: "Detects English and Norwegian by itself. Needs an API key; audio is sent to OpenAI."
                ) {
                    model.settings.transcriber = .openai
                    model.settings.cleaner = .openai
                }
                if model.settings.transcriber == .apple {
                    HStack {
                        Picker("Language", selection: $model.settings.appleLanguage) {
                            ForEach(DictationLanguage.allCases, id: \.self) { Text($0.label).tag($0) }
                        }
                        .fixedSize()
                        Spacer()
                        modelStatus
                    }
                    .padding(.top, 4)
                } else {
                    OpenAIKeyField(model: model)
                        .padding(.top, 4)
                }
            }
        }
    }

    @ViewBuilder
    private var modelStatus: some View {
        let language = model.settings.appleLanguage
        switch model.appleModels[language] {
        case .installed:
            Label("Model ready", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
        case .downloading:
            HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Downloading…") }
        case .notInstalled:
            Button("Download model") { Task { await model.downloadAppleModel(language) } }
        case .unsupported:
            Text("Not available on this Mac").foregroundStyle(.secondary)
        case nil:
            ProgressView().controlSize(.small)
        }
    }

    private var tryIt: some View {
        StepPage(symbol: "waveform", title: "Try it", text: "Click the box, hold \(model.settings.hotkey.shortName), say something, and let go.") {
            VStack(alignment: .leading, spacing: 10) {
                TextEditor(text: $trial)
                    .font(.title3)
                    .focused($trialFocused)
                    .scrollContentBackground(.hidden)
                    .padding(10)
                    .frame(height: 140)
                    .background(.background.secondary, in: .rect(cornerRadius: 12))
                if !trial.isEmpty {
                    Label("That's it. whisp lives in your menu bar.", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                } else if !model.hotkeyActive {
                    Label("whisp can't see the key yet — check the permissions step.", systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                }
            }
            .onAppear { trialFocused = true }
        }
    }

    // MARK: Footer

    private var footer: some View {
        HStack {
            if step != .hello {
                Button("Back") { step = Step(rawValue: step.rawValue - 1) ?? .hello }
            }
            Spacer()
            HStack(spacing: 6) {
                ForEach(Step.allCases, id: \.self) { s in
                    Circle()
                        .fill(s == step ? Color.accentColor : Color.secondary.opacity(0.3))
                        .frame(width: 6, height: 6)
                }
            }
            Spacer()
            if step == .tryIt {
                Button("Done", action: done)
                    .keyboardShortcut(.defaultAction)
            } else {
                Button("Continue") { step = Step(rawValue: step.rawValue + 1) ?? .tryIt }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .controlSize(.large)
        .padding(20)
    }
}

private struct StepPage<Content: View>: View {
    let symbol: String
    let title: String
    let text: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 40, weight: .light))
                .foregroundStyle(.tint)
                .frame(height: 48)
            Text(title).font(.title.weight(.semibold))
            Text(text)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            content
                .padding(.top, 10)
        }
    }
}

private struct Point: View {
    let symbol: String
    let text: String

    var body: some View {
        Label {
            Text(text)
        } icon: {
            Image(systemName: symbol)
                .foregroundStyle(.tint)
                .frame(width: 22)
        }
    }
}

private struct EngineChoice: View {
    let selected: Bool
    let title: String
    let detail: String
    let choose: () -> Void

    var body: some View {
        Button(action: choose) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(selected ? Color.accentColor : .secondary)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.headline)
                    Text(detail)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .padding(12)
            .background(.background.secondary, in: .rect(cornerRadius: 12))
            .overlay {
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(selected ? Color.accentColor : .clear, lineWidth: 2)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}

/** The key field, shared by onboarding; shows the saved key's tail once set. */
struct OpenAIKeyField: View {
    let model: AppModel
    @ViewState private var draft = ""

    var body: some View {
        if let last4 = model.keyLast4 {
            Label("API key saved (••••\(last4))", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            HStack {
                SecureField("OpenAI API key", text: $draft, prompt: Text("sk-…"))
                    .textFieldStyle(.roundedBorder)
                Button("Save") {
                    model.setKey(draft)
                    draft = ""
                }
                .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }
}
