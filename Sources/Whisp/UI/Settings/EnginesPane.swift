import SwiftUI
import WhispCore

struct EnginesPane: View {
    @Bindable var model: AppModel
    @ViewState private var keyDraft = ""

    var body: some View {
        Form {
            Section {
                Picker("Transcribe with", selection: $model.settings.transcriber) {
                    ForEach(TranscriberEngine.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)

                switch model.settings.transcriber {
                case .apple:
                    Picker("Language", selection: $model.settings.appleLanguage) {
                        ForEach(DictationLanguage.allCases, id: \.self) { Text($0.label).tag($0) }
                    }
                    ForEach(DictationLanguage.allCases, id: \.self) { language in
                        ModelRow(model: model, language: language)
                    }
                case .openai:
                    Picker("Model", selection: $model.settings.openAIModel) {
                        ForEach(OpenAITranscribeModel.allCases, id: \.self) { Text($0.label).tag($0) }
                    }
                    LabeledContent("Languages you speak") {
                        VStack(alignment: .trailing) {
                            ForEach(DictationLanguage.allCases, id: \.self) { language in
                                Toggle(language.label, isOn: languageBinding(language))
                            }
                        }
                    }
                }
            } header: {
                Text("Transcription")
            } footer: {
                switch model.settings.transcriber {
                case .apple:
                    Text("Runs on this Mac: free, private, works offline, and shows words while you speak. It doesn't detect language, so pick the one you're about to speak (also from the menu bar).")
                case .openai:
                    Text("Audio is sent to OpenAI. gpt-transcribe uses your Dictionary as keywords and picks among your languages itself; gpt-4o-mini-transcribe is cheaper.")
                }
            }

            Section {
                Picker("Clean up with", selection: $model.settings.cleaner) {
                    ForEach(CleanerEngine.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                if model.settings.cleaner == .apple, let reason = AppleCleaner.unavailableReason {
                    Label(reason, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                }
                if model.settings.cleaner == .openai, !model.hasKey {
                    Label("Needs an OpenAI API key", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                }
            } header: {
                Text("Cleanup")
            } footer: {
                Text("Removes fillers and false starts, applies \"scratch that\", and fixes punctuation, without changing your words or language. If cleanup fails, the raw transcript is pasted.")
            }

            Section {
                if let last4 = model.keyLast4 {
                    LabeledContent("API key") {
                        HStack {
                            Text("••••\(last4)").monospaced()
                            Button("Remove", role: .destructive) { model.setKey(nil) }
                        }
                    }
                } else {
                    HStack {
                        SecureField("API key", text: $keyDraft, prompt: Text("sk-…"))
                        Button("Save") {
                            model.setKey(keyDraft)
                            keyDraft = ""
                        }
                        .disabled(keyDraft.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            } header: {
                Text("OpenAI")
            } footer: {
                Text("Stored in your Keychain. Only needed when transcription or cleanup uses OpenAI.")
            }
        }
        .formStyle(.grouped)
    }

    private func languageBinding(_ language: DictationLanguage) -> Binding<Bool> {
        Binding {
            model.settings.languages.contains(language)
        } set: { on in
            var set = Set(model.settings.languages)
            if on { set.insert(language) } else { set.remove(language) }
            model.settings.languages = DictationLanguage.allCases.filter(set.contains)
        }
    }
}

/** One on-device language model: installed, downloading, or a Download button. */
private struct ModelRow: View {
    let model: AppModel
    let language: DictationLanguage

    var body: some View {
        LabeledContent("\(language.label) model") {
            switch model.appleModels[language] {
            case .installed:
                Label("Installed", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            case .downloading:
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Downloading…").foregroundStyle(.secondary)
                }
            case .notInstalled:
                Button("Download") { Task { await model.downloadAppleModel(language) } }
            case .unsupported:
                Text("Not available").foregroundStyle(.secondary)
            case nil:
                ProgressView().controlSize(.small)
            }
        }
    }
}
