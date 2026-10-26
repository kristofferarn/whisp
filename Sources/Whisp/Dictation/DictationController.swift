import AppKit
import WhispCore

/**
 * whisp's core: the dictation key in, pasted text out.
 *
 * The gesture rules live in `Gesture`; this carries out what it decides.
 * A take starts recording the moment the key goes down (and, on-device,
 * starts recognizing too), stops when the gesture says so, and is then
 * transcribed and cleaned in the background while the next take may
 * already be recording. Finished takes paste in speech order via
 * `TakeQueue`, one at a time, so two pastes never interleave their
 * clipboard swaps.
 *
 * A hands-free session pauses pasting. Releasing a take and immediately
 * double-tapping to keep going leaves the earlier take resolving a moment
 * later — by which time you may be off reading something else, and its text
 * would land wherever you were passing through. So it waits for the tap that
 * ends the session and lands with it, where you deliberately came back to.
 */
final class DictationController {
    private struct Take {
        let id: Int
        let capture: TakeCapture
        let plan: EnginePlan
        let apple: Task<AppleSpeechSession, Error>?
    }

    private let model: AppModel
    private let pill: PillPanel
    private var hotkey: Hotkey!
    private let recorder = Recorder()
    private let inserter = Inserter()
    private let ducker = AudioDucker()

    private var gesture = Gesture()
    private var current: Take?
    private var takeCounter = 0
    private var queue = TakeQueue()
    private var transcribing = 0
    private var flushing = false
    private var ticker: Timer?
    private var meter: Timer?
    private var permissionRetry: Task<Void, Never>?
    private var flashTask: Task<Void, Never>?
    private var duckTask: Task<Void, Never>?
    private var meterTicks = 0

    private var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

    init(model: AppModel, pill: PillPanel) {
        self.model = model
        self.pill = pill
    }

    func start() {
        hotkey = Hotkey { [unowned self] edge in handle(edge) }
        hotkey.choice = model.settings.hotkey
        gesture.handsFree = model.settings.handsFree
        model.onSettingsChanged = { [unowned self] _ in
            hotkey.choice = model.settings.hotkey
            gesture.handsFree = model.settings.handsFree
        }
        model.onMutedChanged = { [unowned self] muted in
            // A held key says someone is mid-sentence, so a held take finishes;
            // a hands-free take has no such tell, and recording on behind a
            // muted icon is exactly what mute promises not to do.
            if muted, gesture.latched { apply(gesture.finishNow()) }
        }
        startHotkey()
    }

    /** Opens the event tap, retrying until the permissions it needs are granted. */
    private func startHotkey() {
        model.hotkeyActive = hotkey.start()
        guard !model.hotkeyActive, permissionRetry == nil else { return }
        permissionRetry = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1.5))
                guard let self else { return }
                if self.hotkey.start() {
                    self.model.hotkeyActive = true
                    self.permissionRetry = nil
                    return
                }
            }
        }
    }

    // MARK: Gesture actions

    private func handle(_ edge: Hotkey.Edge) {
        switch edge {
        case .press(let at): apply(gesture.press(at: at, muted: model.muted))
        case .release(let at): apply(gesture.release(at: at))
        case .chord: apply(gesture.chord())
        case .escape: apply(gesture.cancel())
        case .pasteLast: pasteLast()
        }
    }

    private func apply(_ actions: [Gesture.Action]) {
        if !actions.isEmpty { Log.take.debug("gesture: \(String(describing: actions), privacy: .public)") }
        for action in actions {
            switch action {
            case .start: startTake()
            case .finish: finishTake()
            case .cancel: cancelTake()
            case .latch: break
            case .capped: flash("Hands-free stopped after 5 minutes")
            }
        }
        hotkey.recording = gesture.takeOpen
        updateTicker()
        refresh()
        if !gesture.latched { flush() }
    }

    private func startTake() {
        let settings = model.settings
        let plan: EnginePlan
        do {
            plan = try Pipeline.plan(settings, appleModel: model.appleModelState, hasKey: model.hasKey)
        } catch {
            _ = gesture.cancel()
            flash(error.localizedDescription, force: true)
            return
        }

        takeCounter += 1
        let id = takeCounter
        let asked = now
        let capture = TakeCapture { [weak self] in
            let live = ProcessInfo.processInfo.systemUptime
            Task { @MainActor in self?.microphoneLive(take: id, after: live - asked) }
        }
        recorder.start(
            microphoneUID: settings.microphoneUID, avoidBluetooth: settings.preferBuiltInMicrophone, into: capture
        ) { [weak self] _ in
            Task { @MainActor in self?.microphoneFailed(take: id) }
        }
        var apple: Task<AppleSpeechSession, Error>?
        if plan.transcriber == .apple {
            let dictionary = settings.dictionary
            apple = Task.detached { [weak self] in
                try await AppleSpeechSession.start(language: plan.language, dictionary: dictionary, capture: capture) { [weak self] text in
                    Task { @MainActor in
                        guard let self, self.current?.id == id else { return }
                        self.model.liveText = text
                    }
                }
            }
        }
        current = Take(id: id, capture: capture, plan: plan, apple: apple)
        model.liveText = ""
        flashTask?.cancel()
        model.flash = nil
        startMeter()
        Log.take.info("take \(id) started (\(plan.label, privacy: .public))")
    }

    /**
     * The first audio arrived: the microphone is really listening now. This is
     * when the chime means something — played on the press it would promise a
     * microphone that may still be switching on, and with a Bluetooth headset
     * the profile switch would swallow it anyway.
     */
    private func microphoneLive(take id: Int, after seconds: TimeInterval) {
        guard current?.id == id else { return }
        Log.audio.info("take \(id): first audio after \(Int(seconds * 1000)) ms")
        let settings = model.settings
        if settings.chime { Chime.play() }
        if settings.lowerAudio {
            // Lowering the output lowers the chime too, so let it ring first.
            duckTask = Task {
                try? await Task.sleep(for: settings.chime ? Chime.duration : .zero)
                guard !Task.isCancelled, current?.id == id else { return }
                ducker.lower()
            }
        }
    }

    private func microphoneFailed(take id: Int) {
        guard current?.id == id else { return }
        apply(gesture.cancel())
        flash(Permissions.microphone == .authorized
            ? "The microphone wouldn't open"
            : "whisp needs microphone access — see Settings", force: true)
    }

    private func finishTake() {
        guard let take = current else { return }
        current = nil
        stopRecording(take)
        queue.owe(take.id)
        transcribing += 1
        let settings = model.settings
        let key = take.plan.transcriber == .openai || take.plan.cleaner == .openai ? Keychain.read() : nil
        Task {
            let text: String
            do {
                if take.capture.hasSpeech {
                    text = try await Pipeline.run(take.plan, capture: take.capture, apple: take.apple, settings: settings, key: key)
                } else {
                    if let apple = take.apple { try? await apple.value.cancel() }
                    text = ""
                }
            } catch is CancellationError {
                text = ""
            } catch {
                Log.take.error("take \(take.id) failed: \(error.localizedDescription, privacy: .public)")
                flash(error.localizedDescription)
                text = ""
            }
            Log.take.info("take \(take.id) settled: \(text.count) characters")
            if !text.isEmpty {
                model.record(text: text, seconds: take.capture.duration, engine: take.plan.label)
            }
            settle(take.id, text)
        }
    }

    private func cancelTake() {
        guard let take = current else { return }
        current = nil
        stopRecording(take)
        if let apple = take.apple { Task { try? await apple.value.cancel() } }
    }

    private func stopRecording(_ take: Take) {
        recorder.stop()
        take.capture.close()
        duckTask?.cancel()
        duckTask = nil
        ducker.restore()
        stopMeter()
        model.resetLevels()
    }

    private func settle(_ id: Int, _ text: String) {
        transcribing -= 1
        queue.settle(id, text: text)
        if transcribing == 0, current == nil { model.liveText = "" }
        refresh()
        flush()
    }

    // MARK: Pasting

    private func flush() {
        guard !flushing else { return }
        flushing = true
        Task {
            defer {
                flushing = false
                refresh()
            }
            while !gesture.latched, let next = queue.next() {
                // Wait out a hold for the next take: its modifier is down, and
                // a paste in the middle of a sentence is a paste in the wrong
                // place anyway if focus moves before release.
                while gesture.holding { try? await Task.sleep(for: .milliseconds(25)) }
                do {
                    try await inserter.paste(next.text)
                } catch {
                    flash(error.localizedDescription)
                }
            }
        }
    }

    private func pasteLast() {
        guard let text = model.lastTranscript else { return }
        Task {
            do { try await inserter.paste(text) } catch { flash(error.localizedDescription) }
        }
    }

    // MARK: Timers and UI

    /** Ticks only while a double-tap window or a hands-free session is open. */
    private func updateTicker() {
        if gesture.needsTicks, ticker == nil {
            ticker = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.apply(self.gesture.tick(at: self.now))
                }
            }
        } else if !gesture.needsTicks, let ticker {
            ticker.invalidate()
            self.ticker = nil
        }
    }

    private func startMeter() {
        meter?.invalidate()
        meter = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let take = self.current else { return }
                self.model.pushLevel(take.capture.level)
                // A few times a second, make sure the tap hasn't missed the release.
                self.meterTicks += 1
                if self.gesture.holding, self.meterTicks % 8 == 0 { self.hotkey.resync() }
            }
        }
    }

    private func stopMeter() {
        meter?.invalidate()
        meter = nil
    }

    private func refresh() {
        if current != nil {
            model.phase = gesture.latched ? .handsFree : .listening
        } else if transcribing > 0 {
            model.phase = .transcribing
        } else {
            model.phase = .idle
        }
        pill.sync()
    }

    /**
     * A message on the pill for a moment. While you are speaking a newer take,
     * an older take's trouble stays quiet — the pill keeps saying it's
     * listening — unless `force` (the take you just tried to start failed).
     */
    private func flash(_ message: String, force: Bool = false) {
        guard force || current == nil else { return }
        flashTask?.cancel()
        model.flash = message
        pill.sync()
        flashTask = Task {
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            model.flash = nil
            pill.sync()
        }
    }
}

/** The tick that says the microphone is open. */
enum Chime {
    /** How long it rings — lowering other audio waits this long. */
    static let duration: Duration = .milliseconds(250)

    private static let sound: NSSound? = {
        let sound = NSSound(named: "Tink")
        sound?.volume = 0.6
        return sound
    }()

    static func play() {
        sound?.stop()
        sound?.play()
    }
}
