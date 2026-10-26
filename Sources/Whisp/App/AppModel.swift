import Foundation
import Observation
import WhispCore

/** What dictation is doing right now, as everything visible shows it. */
enum Phase: Equatable {
    case idle
    case listening
    case handsFree
    case transcribing
}

/**
 * The app's observable state: what the menu bar, the pill and Settings all
 * read. Settings, history and stats persist through `Store`; the rest lives
 * only as long as the process.
 */
@Observable
final class AppModel {
    @ObservationIgnored private let store = Store()

    var settings: WhispSettings {
        didSet {
            guard settings != oldValue else { return }
            store.save("settings.json", settings)
            if settings.launchAtLogin != oldValue.launchAtLogin { LoginItem.set(settings.launchAtLogin) }
            if !settings.keepHistory, !history.isEmpty { clearHistory() }
            onSettingsChanged?(oldValue)
        }
    }

    private(set) var history: [HistoryEntry]
    private(set) var stats: Stats

    var phase: Phase = .idle
    /** The pill is expanded on screen (the panel animates to and from this). */
    var pillShown = false
    /** Which Settings pane is showing. */
    var settingsPane: SettingsPane? = .general
    /** A short message the pill shows instead of the phase, then forgets. */
    var flash: String?
    /** Session-only on purpose: a restart unmutes, so whisp can't stay deaf for a week. */
    var muted = false {
        didSet { if muted != oldValue { onMutedChanged?(muted) } }
    }
    /** Recent microphone levels, oldest first, for the pill's bars. */
    var levels: [Float] = Array(repeating: 0, count: AppModel.levelCount)
    /** What the on-device recognizer has heard so far in the current take. */
    var liveText = ""
    /** The last pasted text, for ⌃⌘V — kept even when history is off. */
    var lastTranscript: String?

    var appleModels: [DictationLanguage: AppleSpeech.ModelState] = [:]
    var downloading: Set<DictationLanguage> = []
    private(set) var keyLast4: String?
    /** The event tap is running — false means a permission is missing. */
    var hotkeyActive = false

    @ObservationIgnored var onSettingsChanged: ((WhispSettings) -> Void)?
    @ObservationIgnored var onMutedChanged: ((Bool) -> Void)?

    static let levelCount = 28

    init() {
        settings = store.load("settings.json", as: WhispSettings.self) ?? WhispSettings()
        history = store.load("history.json", as: [HistoryEntry].self) ?? []
        stats = store.load("stats.json", as: Stats.self) ?? Stats()
        lastTranscript = history.first?.text
        keyLast4 = Keychain.read().map { String($0.suffix(4)) }
    }

    var hasKey: Bool { keyLast4 != nil }

    var appleModelState: AppleSpeech.ModelState {
        appleModels[settings.appleLanguage] ?? .notInstalled
    }

    func setKey(_ key: String?) {
        Keychain.write(key)
        keyLast4 = Keychain.read().map { String($0.suffix(4)) }
    }

    func record(text: String, seconds: Double, engine: String) {
        let now = Date()
        lastTranscript = text
        stats.record(text: text, seconds: seconds, at: now)
        store.save("stats.json", stats)
        guard settings.keepHistory else { return }
        history.insert(HistoryEntry(date: now, text: text, seconds: seconds, engine: engine), at: 0)
        if history.count > Store.historyMax { history.removeLast(history.count - Store.historyMax) }
        store.save("history.json", history)
    }

    func deleteHistory(_ ids: Set<HistoryEntry.ID>) {
        history.removeAll { ids.contains($0.id) }
        store.save("history.json", history)
    }

    func clearHistory() {
        history = []
        store.save("history.json", history)
    }

    func pushLevel(_ level: Float) {
        levels.removeFirst()
        levels.append(level)
    }

    func resetLevels() {
        levels = Array(repeating: 0, count: Self.levelCount)
    }

    func refreshAppleModels() async {
        for language in DictationLanguage.allCases where !downloading.contains(language) {
            appleModels[language] = await AppleSpeech.state(language)
        }
    }

    func downloadAppleModel(_ language: DictationLanguage) async {
        guard !downloading.contains(language) else { return }
        downloading.insert(language)
        appleModels[language] = .downloading
        do {
            try await AppleSpeech.install(language)
        } catch {
            NSLog("whisp: model download failed: \(error)")
        }
        downloading.remove(language)
        appleModels[language] = await AppleSpeech.state(language)
    }
}
