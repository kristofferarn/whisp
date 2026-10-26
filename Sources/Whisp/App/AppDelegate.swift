import AppKit

/**
 * Boot order: the model (settings, history), then the pill and dictation,
 * then the slower checks — which on-device speech models are installed,
 * warming Apple Intelligence — so the key works the moment the app is up.
 * First run opens the welcome window; there is nothing to dictate with until
 * the permissions are granted.
 */
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = AppModel()
    private(set) lazy var windows = WindowManager(model: model)
    private var pill: PillPanel?
    private var dictation: DictationController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        if CommandLineMode.requested {
            Task {
                let status = await CommandLineMode.run(model: model)
                exit(status)
            }
            return
        }

        let pill = PillPanel(model: model)
        let dictation = DictationController(model: model, pill: pill)
        self.pill = pill
        self.dictation = dictation
        dictation.start()

        Task {
            await model.refreshAppleModels()
            AppleCleaner.prewarm()
        }

        if !model.settings.onboarded { windows.showWelcome() }
    }
}
