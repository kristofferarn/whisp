import FoundationModels
import WhispCore

/**
 * The cleanup pass on Apple Intelligence's on-device model: free, private,
 * offline. Uses the permissive guardrails Apple provides for transforming
 * the user's own text, since ordinary dictation trips the default ones now
 * and then. A fresh session per take — sessions remember, and one take's
 * words have no business shaping the next.
 */
nonisolated enum AppleCleaner {
    private static var model: SystemLanguageModel {
        SystemLanguageModel(useCase: .general, guardrails: .permissiveContentTransformations)
    }

    static var isAvailable: Bool { model.isAvailable }

    /** Why it isn't available, in words for Settings. Nil when it is. */
    static var unavailableReason: String? {
        switch model.availability {
        case .available: nil
        case .unavailable(.appleIntelligenceNotEnabled): "Turn on Apple Intelligence in System Settings"
        case .unavailable(.modelNotReady): "Apple Intelligence is still downloading"
        case .unavailable(.deviceNotEligible): "This Mac doesn't support Apple Intelligence"
        case .unavailable: "Apple Intelligence is unavailable"
        }
    }

    static func clean(_ text: String, dictionary: [String]) async throws -> String {
        let session = LanguageModelSession(model: model, instructions: Cleanup.instructions(dictionary: dictionary))
        let response = try await session.respond(to: text, options: GenerationOptions(samplingMode: .greedy))
        return response.content
    }

    /** Loads the model ahead of the first cleanup, so that one isn't slow. */
    static func prewarm() {
        guard isAvailable else { return }
        LanguageModelSession(model: model).prewarm()
    }
}
