import Foundation
import WhispCore

/** Which engines one take uses, decided when it starts. */
nonisolated struct EnginePlan: Sendable {
    var transcriber: TranscriberEngine
    /** The language the on-device recognizer listens for. */
    var language: DictationLanguage
    var cleaner: CleanerEngine

    var label: String {
        let words = transcriber == .apple ? "\(transcriber.label) (\(language.label))" : transcriber.label
        return cleaner == .off ? words : "\(words) · \(cleaner.label)"
    }
}

/**
 * The take's path from audio to text. There is deliberately no fallback from
 * one provider to the other: choosing on-device means audio never leaves the
 * Mac, so an unready on-device engine is an error to fix, not a reason to
 * upload. Cleanup is the exception in the other direction: when it can't
 * run, the raw transcript is pasted, since cleanup may improve a paste but
 * never cost one.
 */
nonisolated enum Pipeline {
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    static func plan(
        _ settings: WhispSettings, appleModel: AppleSpeech.ModelState, hasKey: Bool
    ) throws -> EnginePlan {
        let language = settings.appleLanguage
        switch settings.transcriber {
        case .apple:
            switch appleModel {
            case .installed: break
            case .downloading: throw Failure(message: "The \(language.label) speech model is still downloading")
            case .notInstalled: throw Failure(message: "Download the \(language.label) speech model in Settings › Engines")
            case .unsupported: throw Failure(message: "On-device \(language.label) isn't available on this Mac")
            }
        case .openai:
            if !hasKey { throw Failure(message: "Add your OpenAI API key in Settings › Engines") }
        }
        var cleaner = settings.cleaner
        if cleaner == .apple, !AppleCleaner.isAvailable { cleaner = .off }
        if cleaner == .openai, !hasKey { cleaner = .off }
        return EnginePlan(transcriber: settings.transcriber, language: language, cleaner: cleaner)
    }

    /** Transcribe (finishing the live session, or uploading), then clean up. */
    static func run(
        _ plan: EnginePlan, capture: TakeCapture, apple: Task<AppleSpeechSession, Error>?,
        settings: WhispSettings, key: String?
    ) async throws -> String {
        let raw: String
        switch plan.transcriber {
        case .apple:
            guard let apple else { throw Failure(message: "on-device session missing") }
            raw = try await apple.value.finish()
        case .openai:
            guard let key else { throw Failure(message: "Add your OpenAI API key in Settings › Engines") }
            raw = try await OpenAI.transcribe(
                wav: capture.wavData(), seconds: capture.duration, model: settings.openAIModel,
                languages: settings.languages, dictionary: settings.dictionary, key: key
            )
        }
        guard !raw.isEmpty else { return "" }
        return await clean(raw, plan: plan, dictionary: settings.dictionary, key: key)
    }

    static func clean(_ raw: String, plan: EnginePlan, dictionary: [String], key: String?) async -> String {
        do {
            let cleaned: String
            switch plan.cleaner {
            case .off:
                return raw
            case .apple:
                cleaned = try await AppleCleaner.clean(raw, dictionary: dictionary)
            case .openai:
                guard let key else { return raw }
                cleaned = try await OpenAI.clean(raw, dictionary: dictionary, key: key)
            }
            if let accepted = Cleanup.accept(cleaned, raw: raw) { return accepted }
            NSLog("whisp: cleanup answer rejected, pasting the raw transcript")
        } catch {
            NSLog("whisp: cleanup skipped, pasting the raw transcript: \(error)")
        }
        return raw
    }
}
