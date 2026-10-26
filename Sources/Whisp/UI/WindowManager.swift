import AppKit
import SwiftUI

/**
 * whisp's two real windows: Settings and the welcome flow. whisp is a menu
 * bar app with no Dock icon, but while one of these is open it becomes a
 * regular app — in the Dock and ⌘-Tab — so the window can be found again
 * behind others. Closing the last one goes back to living in the menu bar.
 */
final class WindowManager: NSObject, NSWindowDelegate {
    private let model: AppModel
    private var settings: NSWindow?
    private var welcome: NSWindow?

    init(model: AppModel) {
        self.model = model
    }

    func showSettings(_ pane: SettingsPane? = nil) {
        if let pane { model.settingsPane = pane }
        if settings == nil {
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 860, height: 580),
                styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                backing: .buffered, defer: false
            )
            window.title = "whisp"
            window.contentViewController = NSHostingController(rootView: SettingsView(model: model, windows: self))
            window.setContentSize(NSSize(width: 860, height: 580))
            window.contentMinSize = NSSize(width: 720, height: 460)
            window.toolbarStyle = .unified
            window.isReleasedWhenClosed = false
            window.delegate = self
            window.setFrameAutosaveName("whisp.settings")
            if !window.setFrameUsingName("whisp.settings") { window.center() }
            settings = window
        }
        present(settings!)
    }

    func showWelcome() {
        if welcome == nil {
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 560, height: 520),
                styleMask: [.titled, .closable, .fullSizeContentView],
                backing: .buffered, defer: false
            )
            window.titlebarAppearsTransparent = true
            window.titleVisibility = .hidden
            window.isMovableByWindowBackground = true
            window.contentViewController = NSHostingController(rootView: WelcomeView(model: model) { [weak self] in
                self?.welcome?.close()
            })
            window.setContentSize(NSSize(width: 560, height: 520))
            window.isReleasedWhenClosed = false
            window.delegate = self
            window.center()
            welcome = window
        }
        present(welcome!)
    }

    private func present(_ window: NSWindow) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate()
        window.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        if notification.object as? NSWindow === welcome { model.settings.onboarded = true }
        DispatchQueue.main.async {
            let open = [self.settings, self.welcome].contains { $0?.isVisible == true }
            if !open { NSApp.setActivationPolicy(.accessory) }
        }
    }
}
