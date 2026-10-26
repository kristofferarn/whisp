/**
 * Pastes happen in the order things were said, not the order the network
 * answers. Takes overlap on purpose — holding the key again starts the next
 * take while the last one is still transcribing — so a short second take can
 * resolve before a long first one. Each take is owed when it stops recording
 * and settled exactly once (with its text, or "" for silence, cancel or
 * error), and `next()` only hands out the front of the line, so one lost take
 * can never hold the rest back forever and none can overtake another.
 */
public struct TakeQueue: Sendable {
    private var owed: [Int] = []
    private var resolved: [Int: String] = [:]

    public init() {}

    public var isEmpty: Bool { owed.isEmpty }
    public var pendingCount: Int { owed.count }

    public mutating func owe(_ take: Int) {
        owed.append(take)
    }

    /** Settling a take that is not owed (already settled, never owed) does nothing. */
    public mutating func settle(_ take: Int, text: String) {
        guard owed.contains(take), resolved[take] == nil else { return }
        resolved[take] = text
    }

    /**
     * The next take whose turn has come, with its text — skipping over
     * settled-but-empty ones. Nil while the front of the line is unresolved.
     */
    public mutating func next() -> (take: Int, text: String)? {
        while let front = owed.first, let text = resolved[front] {
            owed.removeFirst()
            resolved[front] = nil
            if !text.isEmpty { return (front, text) }
        }
        return nil
    }
}
