import Testing
@testable import WhispCore

struct GestureTests {
    @Test func holdAndReleaseIsOneTake() {
        var g = Gesture()
        #expect(g.press(at: 0) == [.start])
        #expect(g.takeOpen)
        #expect(g.release(at: 2) == [.finish])
        #expect(!g.takeOpen)
    }

    @Test func aLoneTapWaitsOutTheDoubleTapWindowThenFinishes() {
        var g = Gesture()
        #expect(g.press(at: 0) == [.start])
        #expect(g.release(at: 0.1) == [])
        #expect(g.takeOpen)
        #expect(g.needsTicks)
        #expect(g.tick(at: 0.3) == [])
        #expect(g.tick(at: 0.55) == [.finish])
        #expect(!g.needsTicks)
    }

    @Test func doubleTapLatchesAndTheNextTapFinishes() {
        var g = Gesture()
        #expect(g.press(at: 0) == [.start])
        #expect(g.release(at: 0.1) == [])
        #expect(g.press(at: 0.3) == [])
        #expect(g.release(at: 0.4) == [.latch])
        #expect(g.latched)
        #expect(g.tick(at: 30) == [])
        #expect(g.press(at: 60) == [])
        #expect(g.release(at: 60.1) == [.finish])
        #expect(!g.latched)
        #expect(!g.takeOpen)
    }

    @Test func tapThenHoldIsOneLongTake() {
        var g = Gesture()
        #expect(g.press(at: 0) == [.start])
        #expect(g.release(at: 0.1) == [])
        #expect(g.press(at: 0.3) == [])
        #expect(g.release(at: 3) == [.finish])
        #expect(!g.latched)
    }

    @Test func withoutHandsFreeEveryReleaseFinishes() {
        var g = Gesture(handsFree: false)
        #expect(g.press(at: 0) == [.start])
        #expect(g.release(at: 0.1) == [.finish])
    }

    @Test func handsFreeStopsAtTheCap() {
        var g = Gesture()
        _ = g.press(at: 0)
        _ = g.release(at: 0.1)
        _ = g.press(at: 0.2)
        #expect(g.release(at: 0.3) == [.latch])
        #expect(g.tick(at: 0.3 + Gesture.handsFreeMax - 1) == [])
        #expect(g.tick(at: 0.3 + Gesture.handsFreeMax + 1) == [.finish, .capped])
        #expect(!g.takeOpen)
    }

    @Test func aChordCancelsTheTakeItsHoldStarted() {
        var g = Gesture()
        #expect(g.press(at: 0) == [.start])
        #expect(g.chord() == [.cancel])
        #expect(!g.takeOpen)
        // The rest of that hold drives nothing.
        #expect(g.chord() == [])
        #expect(g.release(at: 0.1) == [])
        #expect(g.tick(at: 1) == [])
    }

    @Test func aChordOnTheSecondPressCancelsTheRollingTap() {
        var g = Gesture()
        _ = g.press(at: 0)
        _ = g.release(at: 0.1)
        #expect(g.press(at: 0.2) == [])
        #expect(g.chord() == [.cancel])
        #expect(g.release(at: 0.3) == [])
        #expect(!g.latched)
    }

    @Test func aChordDuringHandsFreeIsNotTheEndingTap() {
        var g = Gesture()
        _ = g.press(at: 0)
        _ = g.release(at: 0.1)
        _ = g.press(at: 0.2)
        _ = g.release(at: 0.3)
        #expect(g.press(at: 10) == [])
        #expect(g.chord() == [])
        #expect(g.release(at: 10.2) == [])
        #expect(g.latched)
        #expect(g.takeOpen)
    }

    @Test func escapeCancelsAnything() {
        var held = Gesture()
        _ = held.press(at: 0)
        #expect(held.cancel() == [.cancel])
        #expect(held.release(at: 1) == [])

        var latched = Gesture()
        _ = latched.press(at: 0)
        _ = latched.release(at: 0.1)
        _ = latched.press(at: 0.2)
        _ = latched.release(at: 0.3)
        #expect(latched.cancel() == [.cancel])
        #expect(!latched.latched)

        var idle = Gesture()
        #expect(idle.cancel() == [])
    }

    @Test func mutedPressesStartNothing() {
        var g = Gesture()
        #expect(g.press(at: 0, muted: true) == [])
        #expect(g.release(at: 2) == [])
        #expect(!g.takeOpen)
    }

    @Test func finishNowEndsHandsFree() {
        var g = Gesture()
        _ = g.press(at: 0)
        _ = g.release(at: 0.1)
        _ = g.press(at: 0.2)
        _ = g.release(at: 0.3)
        #expect(g.finishNow() == [.finish])
        #expect(!g.latched)
        #expect(g.finishNow() == [])
    }

    @Test func repeatedPressEventsAreIgnored() {
        var g = Gesture()
        #expect(g.press(at: 0) == [.start])
        #expect(g.press(at: 0.5) == [])
        #expect(g.release(at: 1) == [.finish])
        #expect(g.release(at: 1.1) == [])
    }
}
