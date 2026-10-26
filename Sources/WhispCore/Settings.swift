import Foundation

/**
 * Everything a person can change, as one value. Persisted as settings.json;
 * decoding is forgiving (a missing or unknown field takes its default) so an
 * older file never resets the rest, and a newer field never needs a migration.
 */
public struct WhispSettings: Codable, Equatable, Sendable {
    /** Who turns audio into words. */
    public var transcriber: TranscriberEngine = .apple
    /** Who turns spoken words into written ones — or nobody. */
    public var cleaner: CleanerEngine = .apple
    /** Which OpenAI model transcribes when `transcriber` is `.openai`. */
    public var openAIModel: OpenAITranscribeModel = .full
    /**
     * The language the on-device engine listens for. Apple's recognizers
     * don't detect language, so this is a choice, switchable from the menu
     * bar. OpenAI hears `languages` instead and picks among them itself.
     */
    public var appleLanguage: DictationLanguage = .en
    /** The pool OpenAI picks from — the cure for Norwegian heard as Swedish. */
    public var languages: [DictationLanguage] = [.en, .no]
    /** Names and jargon the transcriber would otherwise mishear. */
    public var dictionary: [String] = []
    public var hotkey: HotkeyChoice = .fn
    /** Double-tap the key to keep listening with nothing held. */
    public var handsFree = true
    /** A soft tick when the microphone opens. */
    public var chime = true
    /** A CoreAudio device UID, or nil to follow the system's default input. */
    public var microphoneUID: String?
    /** Turn other audio down while the microphone is open. */
    public var lowerAudio = true
    public var keepHistory = true
    public var launchAtLogin = false
    /** Set once the welcome flow has been finished or dismissed. */
    public var onboarded = false

    public init() {}

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = WhispSettings()
        transcriber = (try? c.decodeIfPresent(TranscriberEngine.self, forKey: .transcriber)) ?? d.transcriber
        cleaner = (try? c.decodeIfPresent(CleanerEngine.self, forKey: .cleaner)) ?? d.cleaner
        openAIModel = (try? c.decodeIfPresent(OpenAITranscribeModel.self, forKey: .openAIModel)) ?? d.openAIModel
        appleLanguage = (try? c.decodeIfPresent(DictationLanguage.self, forKey: .appleLanguage)) ?? d.appleLanguage
        languages = (try? c.decodeIfPresent([DictationLanguage].self, forKey: .languages)) ?? d.languages
        dictionary = Self.sanitizeDictionary((try? c.decodeIfPresent([String].self, forKey: .dictionary)) ?? d.dictionary)
        hotkey = (try? c.decodeIfPresent(HotkeyChoice.self, forKey: .hotkey)) ?? d.hotkey
        handsFree = (try? c.decodeIfPresent(Bool.self, forKey: .handsFree)) ?? d.handsFree
        chime = (try? c.decodeIfPresent(Bool.self, forKey: .chime)) ?? d.chime
        microphoneUID = (try? c.decodeIfPresent(String.self, forKey: .microphoneUID)) ?? d.microphoneUID
        lowerAudio = (try? c.decodeIfPresent(Bool.self, forKey: .lowerAudio)) ?? d.lowerAudio
        keepHistory = (try? c.decodeIfPresent(Bool.self, forKey: .keepHistory)) ?? d.keepHistory
        launchAtLogin = (try? c.decodeIfPresent(Bool.self, forKey: .launchAtLogin)) ?? d.launchAtLogin
        onboarded = (try? c.decodeIfPresent(Bool.self, forKey: .onboarded)) ?? d.onboarded
    }

    /**
     * Dictionary words as the transcribers can take them: trimmed, at most 64
     * characters, no angle brackets or line breaks (gpt-transcribe rejects a
     * whole request over one), deduplicated ignoring case, at most 100 — the
     * list rides every request.
     */
    public static func sanitizeDictionary(_ words: [String]) -> [String] {
        var seen = Set<String>()
        var clean: [String] = []
        for word in words {
            let stripped = word.filter { !"<>\r\n".contains($0) }
            let trimmed = String(stripped.trimmingCharacters(in: .whitespaces).prefix(64))
            let fold = trimmed.lowercased()
            if trimmed.isEmpty || seen.contains(fold) { continue }
            seen.insert(fold)
            clean.append(trimmed)
        }
        return Array(clean.prefix(100))
    }
}

public enum TranscriberEngine: String, Codable, CaseIterable, Sendable {
    case apple, openai

    public var label: String {
        switch self {
        case .apple: "On-device"
        case .openai: "OpenAI"
        }
    }
}

public enum CleanerEngine: String, Codable, CaseIterable, Sendable {
    case off, apple, openai

    public var label: String {
        switch self {
        case .off: "Off"
        case .apple: "Apple Intelligence"
        case .openai: "OpenAI"
        }
    }
}

public enum OpenAITranscribeModel: String, Codable, CaseIterable, Sendable {
    /** Cheaper, but its API takes a single language hint and no keyword list. */
    case mini = "gpt-4o-mini-transcribe"
    /** Takes the whole language set and the dictionary as keywords. */
    case full = "gpt-transcribe"

    public var label: String {
        switch self {
        case .mini: "gpt-4o-mini-transcribe"
        case .full: "gpt-transcribe"
        }
    }
}

public enum DictationLanguage: String, Codable, CaseIterable, Sendable {
    case en, no

    public var label: String {
        switch self {
        case .en: "English"
        case .no: "Norwegian"
        }
    }

    /** The locale the on-device recognizers are asked for. */
    public var locale: Locale {
        switch self {
        case .en: Locale(identifier: "en_US")
        case .no: Locale(identifier: "nb_NO")
        }
    }
}

public enum HotkeyChoice: String, Codable, CaseIterable, Sendable {
    case fn, rightOption, controlOption

    public var label: String {
        switch self {
        case .fn: "🌐 Fn"
        case .rightOption: "Right ⌥ Option"
        case .controlOption: "⌃ Control + ⌥ Option"
        }
    }
}
