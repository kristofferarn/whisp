import AVFoundation
import WhispCore

/**
 * `Whisp --microphones` lists the inputs and which one a take would open.
 *
 * `Whisp --transcribe <file> [--engine apple|openai] [--cleaner off|apple|openai] [--language en|no]`
 *
 * Runs a sound file through the same pipeline a take uses and prints the raw
 * and cleaned text with timings. It exists to test the engines without a
 * microphone (pair it with `say -o take.aiff "…"`). Unset options come from
 * the app's settings.
 */
enum CommandLineMode {
    static var requested: Bool {
        CommandLine.arguments.contains("--transcribe") || CommandLine.arguments.contains("--microphones")
    }

    static func run(model: AppModel) async -> Int32 {
        let args = CommandLine.arguments
        if args.contains("--microphones") { return microphones(model.settings) }
        func value(_ flag: String) -> String? {
            args.firstIndex(of: flag).flatMap { args.indices.contains($0 + 1) ? args[$0 + 1] : nil }
        }
        guard let path = value("--transcribe") else {
            print("usage: Whisp --transcribe <file> [--engine apple|openai] [--cleaner off|apple|openai] [--language en|no]")
            return 2
        }

        var settings = model.settings
        if let engine = value("--engine").flatMap(TranscriberEngine.init(rawValue:)) { settings.transcriber = engine }
        if let cleaner = value("--cleaner").flatMap(CleanerEngine.init(rawValue:)) { settings.cleaner = cleaner }
        if let language = value("--language").flatMap(DictationLanguage.init(rawValue:)) { settings.appleLanguage = language }

        do {
            let appleState = await AppleSpeech.state(settings.appleLanguage)
            if settings.transcriber == .apple, appleState == .notInstalled {
                print("downloading the \(settings.appleLanguage.label) speech model…")
                try await AppleSpeech.install(settings.appleLanguage)
            }
            let plan = try Pipeline.plan(
                settings, appleModel: await AppleSpeech.state(settings.appleLanguage), hasKey: Keychain.read() != nil
            )
            print("engines: \(plan.label)")

            let capture = TakeCapture()
            let started = Date()
            var apple: Task<AppleSpeechSession, Error>?
            if plan.transcriber == .apple {
                let dictionary = settings.dictionary
                apple = Task.detached {
                    try await AppleSpeechSession.start(
                        language: plan.language, dictionary: dictionary, capture: capture, onPartial: { _ in }
                    )
                }
                _ = try await apple?.value
            }
            try feed(URL(fileURLWithPath: path), into: capture)
            capture.close()
            print(String(format: "audio: %.1fs, speech detected: %@", capture.duration, capture.hasSpeech ? "yes" : "no"))

            let key = Keychain.read()
            var rawPlan = plan
            rawPlan.cleaner = .off
            let raw = try await Pipeline.run(rawPlan, capture: capture, apple: apple, settings: settings, key: key)
            let transcribed = Date()
            print(String(format: "raw (%.2fs): %@", transcribed.timeIntervalSince(started), raw))
            if plan.cleaner != .off, !raw.isEmpty {
                let cleaned = await Pipeline.clean(raw, plan: plan, dictionary: settings.dictionary, key: key)
                print(String(format: "cleaned (%.2fs): %@", Date().timeIntervalSince(transcribed), cleaned))
            }
            return 0
        } catch {
            print("error: \(error.localizedDescription)")
            return 1
        }
    }

    private static func microphones(_ settings: WhispSettings) -> Int32 {
        let fallback = AudioDevices.defaultInput()
        for device in AudioDevices.inputs() {
            let kind = device.isBluetooth ? "bluetooth" : device.isBuiltIn ? "built-in" : "other"
            print("\(device.id == fallback?.id ? "*" : " ") \(device.name) [\(kind)]")
        }
        for avoid in [true, false] {
            let picked = AudioDevices.resolveInput(uid: nil, avoidBluetooth: avoid) ?? fallback
            print("system default, prefer built-in \(avoid ? "on: " : "off:") \(picked?.name ?? "none")")
        }
        let yours = AudioDevices.resolveInput(uid: settings.microphoneUID, avoidBluetooth: settings.preferBuiltInMicrophone) ?? fallback
        print("with your settings: \(yours?.name ?? "none")")
        return 0
    }

    private static func feed(_ url: URL, into capture: TakeCapture) throws {
        let file = try AVAudioFile(forReading: url)
        let format = file.processingFormat
        while file.framePosition < file.length {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4096) else { break }
            try file.read(into: buffer)
            if buffer.frameLength == 0 { break }
            capture.append(native: buffer)
        }
    }
}
