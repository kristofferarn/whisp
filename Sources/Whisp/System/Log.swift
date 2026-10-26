import os

/**
 * whisp's unified-log categories. To watch a session:
 *
 *     log stream --level info --predicate 'subsystem BEGINSWITH "com.kristofferarn.whisp"'
 */
nonisolated enum Log {
    private static let subsystem = "com.kristofferarn.whisp"
    static let hotkey = Logger(subsystem: subsystem, category: "hotkey")
    static let audio = Logger(subsystem: subsystem, category: "audio")
    static let take = Logger(subsystem: subsystem, category: "take")
}
