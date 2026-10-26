import Testing
@testable import WhispCore

struct GestureTests {
    @Test func holdAndRelease() {
        var g = Gesture()
        #expect(g.press(at: 0) == [.start])
        #expect(g.release(at: 2) == [.finish])
        #expect(!g.takeOpen)
    }
}
