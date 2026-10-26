import Foundation

/**
 * The dictation key's gestures, as a pure state machine: the hotkey feeds it
 * presses, releases and "another key went down", a timer feeds it ticks, and
 * it answers with what the take should do. No clocks, no audio, no windows —
 * which is what lets every rule below be tested.
 *
 * - Hold to talk; release to finish.
 * - A press of at most `tapMax` might be half of a double-tap, so it keeps
 *   the take rolling for `doubleTapWindow` instead of ending it. The words
 *   spoken in that window are kept either way.
 * - Two taps latch the take into hands-free: it records with nothing held,
 *   and the next tap ends it. Hands-free stops itself after `handsFreeMax`,
 *   since nothing physical reminds you it is running.
 * - Another key pressed while the dictation key is held means it was used as
 *   a modifier (Fn+arrows, Fn+Delete, Fn+E): a take that hold started is
 *   cancelled, and a tap meant to end hands-free is not one.
 * - Escape cancels whatever is recording.
 */
public struct Gesture: Sendable {
    public enum Action: Equatable, Sendable {
        /** Open the microphone for a new take. */
        case start
        /** Stop recording; transcribe and paste what was said. */
        case finish
        /** Stop recording and throw the audio away. */
        case cancel
        /** The take is now hands-free. */
        case latch
        /** Hands-free hit its time limit (always follows a `.finish`). */
        case capped
    }

    public static let tapMax: TimeInterval = 0.3
    public static let doubleTapWindow: TimeInterval = 0.4
    public static let handsFreeMax: TimeInterval = 5 * 60

    public var handsFree: Bool

    /** The dictation key is physically down. */
    public private(set) var holding = false
    /** A take is recording — held, latched, or waiting out a double-tap window. */
    public private(set) var takeOpen = false
    /** The take is hands-free. */
    public private(set) var latched = false

    private var holdSince: TimeInterval = 0
    /** This hold is the second press of a would-be double-tap. */
    private var secondPress = false
    /** This hold began while hands-free; its release ends the session. */
    private var endingPress = false
    /** This hold no longer drives anything (muted, chorded or cancelled). */
    private var inert = false
    /** A tap's release time while its double-tap window is open. */
    private var tapAt: TimeInterval?
    private var latchedSince: TimeInterval = 0

    public init(handsFree: Bool = true) {
        self.handsFree = handsFree
    }

    /** Whether ticks matter right now — a timer only needs to run while true. */
    public var needsTicks: Bool { tapAt != nil || latched }

    public mutating func press(at now: TimeInterval, muted: Bool = false) -> [Action] {
        guard !holding else { return [] }
        holding = true
        holdSince = now
        secondPress = false
        endingPress = false
        inert = false
        if latched {
            // Decided at release: if this press turns out to be a modifier,
            // hands-free carries on.
            endingPress = true
            return []
        }
        if tapAt != nil {
            // The second press. Whether it latches or is just a tap followed
            // by a normal hold is decided at its release; nothing restarts.
            tapAt = nil
            secondPress = true
            return []
        }
        if muted {
            inert = true
            return []
        }
        takeOpen = true
        return [.start]
    }

    public mutating func release(at now: TimeInterval) -> [Action] {
        guard holding else { return [] }
        holding = false
        if inert { return [] }
        if endingPress {
            latched = false
            takeOpen = false
            return [.finish]
        }
        let tap = handsFree && now - holdSince <= Self.tapMax
        if tap && secondPress {
            latched = true
            latchedSince = now
            return [.latch]
        }
        if tap {
            tapAt = now
            return []
        }
        takeOpen = false
        return [.finish]
    }

    /** Another key went down while the dictation key is held. */
    public mutating func chord() -> [Action] {
        guard holding, !inert else { return [] }
        inert = true
        if endingPress { return [] }
        guard takeOpen else { return [] }
        takeOpen = false
        tapAt = nil
        return [.cancel]
    }

    public mutating func tick(at now: TimeInterval) -> [Action] {
        if let tapAt, now - tapAt > Self.doubleTapWindow {
            self.tapAt = nil
            takeOpen = false
            return [.finish]
        }
        if latched, now - latchedSince > Self.handsFreeMax {
            latched = false
            takeOpen = false
            if holding { inert = true }
            return [.finish, .capped]
        }
        return []
    }

    /** Escape, or anything else that must throw the current take away. */
    public mutating func cancel() -> [Action] {
        guard takeOpen else { return [] }
        takeOpen = false
        latched = false
        tapAt = nil
        if holding { inert = true }
        return [.cancel]
    }

    /** End the current take as a release would — e.g. muting mid-hands-free. */
    public mutating func finishNow() -> [Action] {
        guard takeOpen else { return [] }
        takeOpen = false
        latched = false
        tapAt = nil
        if holding { inert = true }
        return [.finish]
    }
}
