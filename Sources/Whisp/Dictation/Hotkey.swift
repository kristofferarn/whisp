import CoreGraphics
import Foundation
import WhispCore

/**
 * The dictation key, seen through a Quartz event tap.
 *
 * The tap runs on its own thread, never the main one. macOS disables a tap
 * whose callback is slow, and every key event until it is re-enabled is
 * simply lost — a missed press means a take never starts, a missed release
 * means one never ends. The main thread can stall for a second (opening a
 * Bluetooth microphone switches the headset's profile), so the callback here
 * does nothing but notice edges, stamp them with the time they happened, and
 * hand them to the main thread to act on.
 *
 * Modifier-only keys (Fn, Right Option) exist only as flagsChanged events,
 * so "is the key down" is derived from each one's flags. A keyDown while the
 * key is held is a chord — the key was a modifier this time. The tap is
 * active rather than listen-only so it can swallow two things: Escape while
 * a take records, and ⌃⌘V, whisp's "paste the last dictation again".
 *
 * Events whisp posts itself (the ⌘V of a paste) carry `syntheticMarker` and
 * are ignored, or a paste during the next hold would cancel it as a chord.
 */
nonisolated final class Hotkey: @unchecked Sendable {
    enum Edge: Sendable {
        /** The key went down / up, at this `systemUptime`. */
        case press(TimeInterval)
        case release(TimeInterval)
        case chord
        case escape
        case pasteLast
    }

    static let syntheticMarker: Int64 = 0x7768_6973 // "whis"

    private let handler: @MainActor @Sendable (Edge) -> Void
    private let lock = NSLock()
    private var runLoop: CFRunLoop!
    private var tap: CFMachPort?
    private var _choice: HotkeyChoice = .fn
    private var _recording = false

    // Tap thread only.
    private var down = false
    /**
     * Whether `CGEventSource.flagsState` has been seen to report this key.
     * It is the only way to notice an edge the tap missed, but it is only
     * trusted once it has agreed with a real press.
     */
    private var physicalStateReliable = false

    init(handler: @escaping @MainActor @Sendable (Edge) -> Void) {
        self.handler = handler
        let ready = DispatchSemaphore(value: 0)
        let thread = Thread { [unowned self] in
            self.runLoop = CFRunLoopGetCurrent()
            // A run loop with no sources returns at once; the port keeps it alive.
            RunLoop.current.add(NSMachPort(), forMode: .default)
            ready.signal()
            while true { RunLoop.current.run(mode: .default, before: .distantFuture) }
        }
        thread.name = "whisp.hotkey"
        thread.qualityOfService = .userInteractive
        thread.start()
        ready.wait()
    }

    var choice: HotkeyChoice {
        get { lock.withLock { _choice } }
        set { lock.withLock { _choice = newValue } }
    }

    /** Set by the main thread: Escape is only swallowed while a take records. */
    var recording: Bool {
        get { lock.withLock { _recording } }
        set { lock.withLock { _recording = newValue } }
    }

    var isRunning: Bool { lock.withLock { tap != nil } }

    /** False until Accessibility (and, on some setups, Input Monitoring) is granted. */
    @discardableResult
    func start() -> Bool {
        if isRunning { return true }
        let mask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.flagsChanged.rawValue)
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: CGEventMask(mask),
            callback: hotkeyCallback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else { return false }
        lock.withLock { self.tap = tap }
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(runLoop, source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        CFRunLoopWakeUp(runLoop)
        Log.hotkey.info("event tap started")
        return true
    }

    /**
     * Compares what the tap believes with the keyboard's actual state and
     * reports a missed edge. Cheap; the main thread calls it while a key is
     * held, as a safety net under the tap.
     */
    func resync() {
        CFRunLoopPerformBlock(runLoop, CFRunLoopMode.commonModes.rawValue) { [self] in reconcile(reason: "check") }
        CFRunLoopWakeUp(runLoop)
    }

    // MARK: Tap thread

    fileprivate func handle(type: CGEventType, event: CGEvent) -> Bool {
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            Log.hotkey.error("event tap was disabled (\(type.rawValue, privacy: .public)); re-enabling")
            if let tap = lock.withLock({ tap }) { CGEvent.tapEnable(tap: tap, enable: true) }
            reconcile(reason: "tap re-enabled")
            return false
        case .flagsChanged:
            if event.getIntegerValueField(.eventSourceUserData) == Self.syntheticMarker { return false }
            let isDown = Self.comboDown(event.flags, choice)
            guard isDown != down else { return false }
            down = isDown
            if isDown, Self.comboDown(CGEventSource.flagsState(.combinedSessionState), choice) {
                physicalStateReliable = true
            }
            emit(isDown ? .press(now) : .release(now))
            return false
        case .keyDown:
            if event.getIntegerValueField(.eventSourceUserData) == Self.syntheticMarker { return false }
            let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
            if keyCode == 53, recording {
                emit(.escape)
                return true
            }
            if down {
                emit(.chord)
                return false
            }
            let mods = event.flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift])
            if keyCode == 9, mods == [.maskCommand, .maskControl] {
                emit(.pasteLast)
                return true
            }
            return false
        default:
            return false
        }
    }

    private func reconcile(reason: StaticString) {
        guard physicalStateReliable else { return }
        let physical = Self.comboDown(CGEventSource.flagsState(.combinedSessionState), choice)
        guard physical != down else { return }
        Log.hotkey.error("missed a key \(physical ? "press" : "release", privacy: .public) (\(reason)); correcting")
        down = physical
        emit(physical ? .press(now) : .release(now))
    }

    private var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

    private func emit(_ edge: Edge) {
        Log.hotkey.debug("\(String(describing: edge), privacy: .public)")
        let handler = handler
        DispatchQueue.main.async { MainActor.assumeIsolated { handler(edge) } }
    }

    private static func comboDown(_ flags: CGEventFlags, _ choice: HotkeyChoice) -> Bool {
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

/** The C callback, on the tap's own thread. */
nonisolated private func hotkeyCallback(
    proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, refcon: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let refcon else { return Unmanaged.passUnretained(event) }
    let hotkey = Unmanaged<Hotkey>.fromOpaque(refcon).takeUnretainedValue()
    return hotkey.handle(type: type, event: event) ? nil : Unmanaged.passUnretained(event)
}
