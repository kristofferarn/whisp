import AppKit
import AVFoundation
import ApplicationServices

/** The three grants whisp needs, and where to send someone to give them. */
enum Permissions {
    static var microphone: AVAuthorizationStatus {
        AVCaptureDevice.authorizationStatus(for: .audio)
    }

    static func requestMicrophone() async -> Bool {
        await AVCaptureDevice.requestAccess(for: .audio)
    }

    /** Needed both to see the dictation key (an active event tap) and to send ⌘V. */
    static var accessibility: Bool { AXIsProcessTrusted() }

    /** Shows the system prompt that offers to open the Accessibility list. */
    static func promptAccessibility() {
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
    }

    /** Some setups also want Input Monitoring before a keyboard tap will open. */
    static var inputMonitoring: Bool { CGPreflightListenEventAccess() }

    static func requestInputMonitoring() {
        _ = CGRequestListenEventAccess()
    }

    enum Pane: String {
        case microphone = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        case accessibility = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        case inputMonitoring = "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
        case keyboard = "x-apple.systempreferences:com.apple.Keyboard-Settings.extension"
        case appleIntelligence = "x-apple.systempreferences:com.apple.Siri-Settings.extension"
    }

    static func open(_ pane: Pane) {
        if let url = URL(string: pane.rawValue) { NSWorkspace.shared.open(url) }
    }
}
