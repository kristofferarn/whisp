import Charts
import SwiftUI
import WhispCore

struct StatsPane: View {
    let model: AppModel

    /** Typing speed the "time saved" figure compares against. */
    private static let typingWPM = 40.0

    private struct Day: Identifiable {
        let date: Date
        let words: Int
        var id: Date { date }
    }

    private var lastDays: [Day] {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: .now)
        return (0..<30).reversed().compactMap { offset in
            guard let date = calendar.date(byAdding: .day, value: -offset, to: today) else { return nil }
            return Day(date: date, words: model.stats.days[Stats.dayKey(date)]?.words ?? 0)
        }
    }

    var body: some View {
        let stats = model.stats
        let minutes = stats.totalSeconds / 60
        let wpm = minutes > 0 ? Double(stats.totalWords) / minutes : 0
        let saved = max(0, Double(stats.totalWords) / Self.typingWPM - minutes)

        Form {
            Section {
                Grid(horizontalSpacing: 24, verticalSpacing: 16) {
                    GridRow {
                        Figure(value: stats.totalWords.formatted(), label: "words dictated")
                        Figure(value: stats.totalTakes.formatted(), label: "dictations")
                    }
                    GridRow {
                        Figure(value: "\(Int(wpm.rounded()))", label: "words per minute")
                        Figure(value: Duration.seconds(saved * 60).formatted(.units(allowed: [.hours, .minutes], width: .abbreviated)), label: "saved vs. typing at 40 wpm")
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            }
            Section("Words per day, last 30 days") {
                Chart(lastDays) { day in
                    BarMark(x: .value("Day", day.date, unit: .day), y: .value("Words", day.words))
                        .foregroundStyle(.tint)
                        .clipShape(.rect(cornerRadius: 3))
                }
                .chartXAxis {
                    AxisMarks(values: .stride(by: .day, count: 7)) {
                        AxisValueLabel(format: .dateTime.day().month(.abbreviated))
                    }
                }
                .frame(height: 180)
                .padding(.vertical, 6)
            }
        }
        .formStyle(.grouped)
    }
}

private struct Figure: View {
    let value: String
    let label: String

    var body: some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.system(.title, design: .rounded, weight: .semibold))
                .monospacedDigit()
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }
}
