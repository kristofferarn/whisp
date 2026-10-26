import Foundation

/** One pasted dictation, as the History pane lists it. */
public struct HistoryEntry: Codable, Equatable, Identifiable, Sendable {
    public var id: UUID
    public var date: Date
    public var text: String
    /** Recorded duration in seconds. */
    public var seconds: Double
    /** Which engines produced it, e.g. "On-device · Apple Intelligence". */
    public var engine: String

    public init(id: UUID = UUID(), date: Date, text: String, seconds: Double, engine: String) {
        self.id = id
        self.date = date
        self.text = text
        self.seconds = seconds
        self.engine = engine
    }
}

public struct DayStats: Codable, Equatable, Sendable {
    public var takes = 0
    public var seconds = 0.0
    public var words = 0
    public init() {}
}

/**
 * Running totals plus per-day buckets (keyed yyyy-MM-dd, local time) for the
 * last `daysKept` days. Totals never lose what pruning drops. Accrues whether
 * or not history is kept — counts say nothing about what was said.
 */
public struct Stats: Codable, Equatable, Sendable {
    public static let daysKept = 90

    public var totalTakes = 0
    public var totalSeconds = 0.0
    public var totalWords = 0
    public var days: [String: DayStats] = [:]

    public init() {}

    public static func dayKey(_ date: Date, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    public static func wordCount(_ text: String) -> Int {
        text.split(whereSeparator: \.isWhitespace).count
    }

    public mutating func record(text: String, seconds: Double, at date: Date) {
        let words = Self.wordCount(text)
        totalTakes += 1
        totalSeconds += seconds
        totalWords += words
        let key = Self.dayKey(date)
        var day = days[key] ?? DayStats()
        day.takes += 1
        day.seconds += seconds
        day.words += words
        days[key] = day
        let keys = days.keys.sorted()
        for stale in keys.prefix(max(0, keys.count - Self.daysKept)) {
            days[stale] = nil
        }
    }
}
