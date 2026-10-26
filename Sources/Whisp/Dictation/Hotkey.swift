import AppKit
import CoreGraphics
import WhispCore

/**
 * The dictation key, seen through a Quartz event tap on the main run loop.
 *
 * Modifier-only keys (Fn, Right Option) exist for the system only as
 * flagsChanged events, so the tap derives "is the key down" from the flags
 * of each one. Any keyDown while the key is held is reported as a chord —
 * the key was a modifier this time. The tap is active rather than listen-only
 * so it can swallow two things: Escape while a take is recording, and ⌃⌘V,
 * whisp's "paste the last transcript again".
 *
 * Events whisp posts itself (the ⌘V of a paste) carry `syntheticMarker` and
 * are ignored, or a paste during the next hold would cancel it as a chord.
 */
final class Hotkey {
    static let syntheticMarker: Int64 = 0x7768_6973 // "whis"

    var choice: HotkeyChoice = .fn
    var onPress: () -> Void = {}
    var onRelease: () -> Void = {}
    var onChord: () -> Void = {}
    /** Escape went down; return true to swallow it (a take was cancelled). */
    var onEscape: () -> Bool = { false }
    var onPasteLast: () -> Void = {}

    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var down = false

    var isRunning: Bool { tap != nil }

    /** False until Accessibility (and, on some setups, Input Monitoring) is granted. */
    @discardableResult
    func start() -> Bool {
        if tap != nil { return true }
        let mask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.flagsChanged.rawValue)
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: CGEventMask(mask),
            callback: hotkeyCallback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else { return false }
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        self.tap = tap
        self.source = source
        return true
    }

    /** Returns true when the event should be swallowed. */
    fileprivate func handle(type: CGEventType, event: CGEvent) -> Bool {
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return false
        case .flagsChanged:
            if event.getIntegerValueField(.eventSourceUserData) == Self.syntheticMarker { return false }
            let isDown = comboDown(event.flags)
            if isDown != down {
                down = isDown
                isDown ? onPress() : onRelease()
            }
            return false
        case .keyDown:
            if event.getIntegerValueField(.eventSourceUserData) == Self.syntheticMarker { return false }
            let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
            if keyCode == 53, onEscape() { return true }
            if down {
                onChord()
                return false
            }
            let mods = event.flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift])
            if keyCode == 9, mods == [.maskCommand, .maskControl] {
                onPasteLast()
                return true
            }
            return false
        default:
            return false
        }
    }

    private func comboDown(_ flags: CGEventFlags) -> Bool {
        switch choice {
        case .fn:
            return flags.contains(.maskSecondaryFn)
        case .rightOption:
            // NX_DEVICERALTKEYMASK: the device-dependent bit for the right Option key.
            return flags.rawValue & 0x40 != 0
        case .controlOption:
            return flags.contains(.maskControl) && flags.contains(.maskAlternate)
                && !flags.contains(.maskCommand)
        }
    }
}

/**
 * The C callback. It runs on the main thread (the tap's source is on the main
 * run loop), so it may step into the main actor without hopping.
 */
nonisolated private func hotkeyCallback(
    proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, refcon: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let pointer = refcon else { return Unmanaged.passUnretained(event) }
    nonisolated(unsafe) let event = event
    nonisolated(unsafe) let hotkey = pointer
    let swallow = MainActor.assumeIsolated {
        Unmanaged<Hotkey>.fromOpaque(hotkey).takeUnretainedValue().handle(type: type, event: event)
    }
    return swallow ? nil : Unmanaged.passUnretained(event)
}
