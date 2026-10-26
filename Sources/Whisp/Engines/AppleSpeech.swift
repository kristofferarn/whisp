import AVFoundation
import Speech
import WhispCore

/**
 * On-device transcription with SpeechAnalyzer. English uses SpeechTranscriber
 * (Apple's newest model); Norwegian uses DictationTranscriber, the model
 * behind system dictation, because SpeechTranscriber doesn't speak it.
 * Neither detects language, so the language is chosen up front.
 */
nonisolated enum AppleSpeech {
    enum ModelState: Equatable, Sendable {
        case unsupported, notInstalled, downloading, installed
    }

    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    fileprivate static func module(_ language: DictationLanguage) -> any SpeechModule {
        switch language {
        case .en:
            SpeechTranscriber(
                locale: language.locale, transcriptionOptions: [],
                reportingOptions: [.volatileResults], attributeOptions: []
            )
        case .no:
            DictationTranscriber(
                locale: language.locale, contentHints: [],
                transcriptionOptions: [.punctuation], reportingOptions: [.volatileResults], attributeOptions: []
            )
        }
    }

    static func state(_ language: DictationLanguage) async -> ModelState {
        switch await AssetInventory.status(forModules: [module(language)]) {
        case .installed: .installed
        case .downloading: .downloading
        case .supported: .notInstalled
        default: .unsupported
        }
    }

    /** Downloads the language's model (a few hundred MB, once). */
    static func install(_ language: DictationLanguage) async throws {
        let modules = [module(language)]
        if let request = try await AssetInventory.assetInstallationRequest(supporting: modules) {
            try await request.downloadAndInstall()
        }
    }
}

/**
 * One take's live recognition. Started when the take starts; audio arrives
 * from the capture (backlog first), and partial results stream out for the
 * pill while you speak. `finish()` waits for the final words after the
 * microphone closes — usually a fraction of a second, since most of the work
 * happened while you were talking.
 */
nonisolated final class AppleSpeechSession: @unchecked Sendable {
    private let analyzer: SpeechAnalyzer
    private let input: AsyncStream<AnalyzerInput>.Continuation
    private let format: AVAudioFormat
    private let converter: AVAudioConverter?
    private let results: Task<String, Error>
    private let lock = NSLock()

    private init(
        analyzer: SpeechAnalyzer, input: AsyncStream<AnalyzerInput>.Continuation,
        format: AVAudioFormat, results: Task<String, Error>
    ) {
        self.analyzer = analyzer
        self.input = input
        self.format = format
        self.results = results
        converter = format == TakeCapture.format ? nil : AVAudioConverter(from: TakeCapture.format, to: format)
    }

    static func start(
        language: DictationLanguage, dictionary: [String], capture: TakeCapture,
        onPartial: @escaping @Sendable (String) -> Void
    ) async throws -> AppleSpeechSession {
        let module = AppleSpeech.module(language)
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module]) else {
            throw AppleSpeech.Failure(message: "The \(language.label) speech model isn't downloaded — see Settings › Engines")
        }
        let analyzer = SpeechAnalyzer(modules: [module])
        if !dictionary.isEmpty {
            let context = AnalysisContext()
            context.contextualStrings[.general] = dictionary
            try? await analyzer.setContext(context)
        }
        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()

        let results: Task<String, Error>
        switch module {
        case let transcriber as SpeechTranscriber:
            results = Task { try await collect(transcriber.results, text: { $0.text }, isFinal: { $0.isFinal }, onPartial) }
        case let transcriber as DictationTranscriber:
            results = Task { try await collect(transcriber.results, text: { $0.text }, isFinal: { $0.isFinal }, onPartial) }
        default:
            throw AppleSpeech.Failure(message: "unexpected speech module")
        }

        try await analyzer.start(inputSequence: stream)
        let session = AppleSpeechSession(analyzer: analyzer, input: continuation, format: format, results: results)
        capture.attach { buffer in session.feed(buffer) }
        return session
    }

    private func feed(_ buffer: AVAudioPCMBuffer) {
        guard let converter else {
            input.yield(AnalyzerInput(buffer: buffer))
            return
        }
        let ratio = format.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 64)
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
        var fed = false
        var error: NSError?
        let status = lock.withLock {
            converter.convert(to: out, error: &error) { _, inputStatus in
                if fed {
                    inputStatus.pointee = .noDataNow
                    return nil
                }
                fed = true
                inputStatus.pointee = .haveData
                return buffer
            }
        }
        if status != .error, out.frameLength > 0 { input.yield(AnalyzerInput(buffer: out)) }
    }

    /** The microphone has closed: finalize and return everything heard. */
    func finish() async throws -> String {
        input.finish()
        try await analyzer.finalizeAndFinishThroughEndOfInput()
        return try await results.value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func cancel() {
        input.finish()
        results.cancel()
        Task { await analyzer.cancelAndFinishNow() }
    }

    private static func collect<S: AsyncSequence>(
        _ sequence: S, text: (S.Element) -> AttributedString, isFinal: (S.Element) -> Bool,
        _ onPartial: @Sendable (String) -> Void
    ) async throws -> String {
        var finalized = ""
        for try await result in sequence {
            let piece = String(text(result).characters)
            if isFinal(result) {
                finalized = join(finalized, piece)
                onPartial(finalized)
            } else {
                onPartial(join(finalized, piece))
            }
        }
        return finalized
    }

    /** Result segments don't promise their own spacing. */
    private static func join(_ head: String, _ tail: String) -> String {
        guard !head.isEmpty, let first = tail.first, !first.isWhitespace,
              let last = head.last, !last.isWhitespace
        else { return head + tail }
        return head + " " + tail
    }
}
