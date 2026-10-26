import Foundation
import WhispCore

/** whisp's two OpenAI calls: transcription and cleanup. */
nonisolated enum OpenAI {
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    /**
     * One take over REST. The dictionary and languages travel the way each
     * model takes them: gpt-transcribe has `keywords[]` for literal terms and
     * `languages[]` for the whole set; the mini model only has `prompt` (the
     * words as a spelling hint) and a single `language`.
     */
    static func transcribe(
        wav: Data, seconds: Double, model: OpenAITranscribeModel,
        languages: [DictationLanguage], dictionary: [String], key: String
    ) async throws -> String {
        var form = Multipart()
        form.file("file", filename: "take.wav", type: "audio/wav", data: wav)
        form.field("model", model.rawValue)
        form.field("response_format", "json")
        let prompt = dictionary.joined(separator: ", ")
        switch model {
        case .full:
            for language in languages { form.field("languages[]", language.rawValue) }
            for word in dictionary { form.field("keywords[]", word) }
        case .mini:
            if languages.count == 1 { form.field("language", languages[0].rawValue) }
            if !prompt.isEmpty { form.field("prompt", prompt) }
        }

        var request = URLRequest(url: URL(string: "https://api.openai.com/v1/audio/transcriptions")!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue(form.contentType, forHTTPHeaderField: "Content-Type")
        request.httpBody = form.finish()
        // Upload and work both grow with the audio, so the budget does too.
        request.timeoutInterval = 30 + min(seconds, Gesture.handsFreeMax) * 0.25

        let body = try await send(request, refusal: "OpenAI refused the transcription")
        let text = (body["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return Cleanup.isPromptEcho(text, prompt: prompt) ? "" : text
    }

    /** The cleanup pass on a small model with reasoning off — about a second. */
    static func clean(_ text: String, dictionary: [String], key: String) async throws -> String {
        let payload: [String: Any] = [
            "model": "gpt-5.4-nano",
            "instructions": Cleanup.instructions(dictionary: dictionary),
            "input": text,
            "reasoning": ["effort": "none"],
            "max_output_tokens": max(256, text.count),
            "store": false
        ]
        var request = URLRequest(url: URL(string: "https://api.openai.com/v1/responses")!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)
        request.timeoutInterval = 15

        let body = try await send(request, refusal: "OpenAI refused the cleanup")
        guard body["status"] as? String == "completed" else { throw Failure(message: "cleanup did not complete") }
        let output = body["output"] as? [[String: Any]] ?? []
        return output
            .filter { $0["type"] as? String == "message" }
            .flatMap { $0["content"] as? [[String: Any]] ?? [] }
            .filter { $0["type"] as? String == "output_text" }
            .compactMap { $0["text"] as? String }
            .joined()
    }

    private static func send(_ request: URLRequest, refusal: String) async throws -> [String: Any] {
        let (data, response) = try await URLSession.shared.data(for: request)
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let detail = (json["error"] as? [String: Any])?["message"] as? String
            throw Failure(message: detail ?? "\(refusal) (HTTP \(status))")
        }
        return json
    }
}

/** multipart/form-data, just enough of it. */
nonisolated private struct Multipart {
    private let boundary = "whisp-\(UUID().uuidString)"
    private var body = Data()

    var contentType: String { "multipart/form-data; boundary=\(boundary)" }

    mutating func field(_ name: String, _ value: String) {
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
    }

    mutating func file(_ name: String, filename: String, type: String, data: Data) {
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"; filename=\"\(filename)\"\r\nContent-Type: \(type)\r\n\r\n".utf8))
        body.append(data)
        body.append(Data("\r\n".utf8))
    }

    mutating func finish() -> Data {
        body.append(Data("--\(boundary)--\r\n".utf8))
        return body
    }
}
