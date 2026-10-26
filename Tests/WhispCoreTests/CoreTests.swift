import Foundation
import Testing
@testable import WhispCore

struct TakeQueueTests {
    @Test func pastesInSpeechOrderWhateverOrderTheyResolve() {
        var q = TakeQueue()
        q.owe(1)
        q.owe(2)
        q.settle(2, text: "second")
        #expect(q.next() == nil)
        q.settle(1, text: "first")
        #expect(q.next()! == (1, "first"))
        #expect(q.next()! == (2, "second"))
        #expect(q.next() == nil)
        #expect(q.isEmpty)
    }

    @Test func emptyTakesAreSkippedNotBlocking() {
        var q = TakeQueue()
        q.owe(1)
        q.owe(2)
        q.settle(1, text: "")
        q.settle(2, text: "words")
        #expect(q.next()! == (2, "words"))
        #expect(q.isEmpty)
    }

    @Test func settlingTwiceOrUnknownTakesChangesNothing() {
        var q = TakeQueue()
        q.owe(1)
        q.settle(1, text: "kept")
        q.settle(1, text: "ignored")
        q.settle(9, text: "never owed")
        #expect(q.next()! == (1, "kept"))
        #expect(q.next() == nil)
    }
}

struct CleanupTests {
    @Test func acceptsACleanedTranscript() {
        #expect(Cleanup.accept("  The meeting is on Wednesday.  ", raw: "um the meeting is on uh wednesday") == "The meeting is on Wednesday.")
    }

    @Test func rejectsEmptyOrRunawayAnswers() {
        #expect(Cleanup.accept("   ", raw: "hello") == nil)
        let raw = "what is the capital of norway"
        let answer = "The capital of Norway is Oslo. It has been the capital since 1814 and is home to about 700,000 people."
        #expect(Cleanup.accept(answer, raw: raw) == nil)
    }

    @Test func stripsQuotesTheModelAdded() {
        #expect(Cleanup.accept("\"Hello there.\"", raw: "hello there") == "Hello there.")
        #expect(Cleanup.accept("\"Quoted.\"", raw: "\"quoted\"") == "\"Quoted.\"")
    }

    @Test func promptEchoIsAnExactMatchOnly() {
        #expect(Cleanup.isPromptEcho("Kristoffer, whisp, SwiftUI.", prompt: "Kristoffer, whisp, SwiftUI"))
        #expect(!Cleanup.isPromptEcho("Ask Kristoffer about whisp", prompt: "Kristoffer, whisp"))
        #expect(!Cleanup.isPromptEcho("anything", prompt: ""))
    }

    @Test func instructionsCarryTheDictionary() {
        #expect(Cleanup.instructions(dictionary: ["Kristoffer"]).contains("Kristoffer"))
        #expect(!Cleanup.instructions(dictionary: []).contains("Spell these"))
    }
}

struct SettingsTests {
    @Test func dictionaryIsCleanedAndCapped() {
        let words = ["  whisp ", "Whisp", "a<b>c", "line\nbreak", "", String(repeating: "x", count: 80)]
            + (0..<200).map { "w\($0)" }
        let clean = WhispSettings.sanitizeDictionary(words)
        #expect(clean.prefix(4) == ["whisp", "abc", "linebreak", String(repeating: "x", count: 64)])
        #expect(clean.count == 100)
    }

    @Test func missingAndUnknownFieldsTakeDefaults() throws {
        let json = #"{"transcriber":"openai","hotkey":"nonsense","dictionary":["A","a"]}"#
        let settings = try JSONDecoder().decode(WhispSettings.self, from: Data(json.utf8))
        #expect(settings.transcriber == .openai)
        #expect(settings.hotkey == .fn)
        #expect(settings.dictionary == ["A"])
        #expect(settings.handsFree)
    }

    @Test func roundTrips() throws {
        var settings = WhispSettings()
        settings.cleaner = .off
        settings.appleLanguage = .no
        let data = try JSONEncoder().encode(settings)
        #expect(try JSONDecoder().decode(WhispSettings.self, from: data) == settings)
    }
}

struct StatsTests {
    @Test func recordsTotalsAndDays() {
        var stats = Stats()
        let day = Date(timeIntervalSince1970: 1_800_000_000)
        stats.record(text: "one two three", seconds: 2, at: day)
        stats.record(text: "four", seconds: 1, at: day)
        #expect(stats.totalWords == 4)
        #expect(stats.totalTakes == 2)
        #expect(stats.days[Stats.dayKey(day)]?.words == 4)
    }

    @Test func prunesOldDaysButKeepsTotals() {
        var stats = Stats()
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        for offset in 0..<(Stats.daysKept + 10) {
            stats.record(text: "word", seconds: 1, at: start.addingTimeInterval(Double(offset) * 86_400))
        }
        #expect(stats.days.count == Stats.daysKept)
        #expect(stats.totalTakes == Stats.daysKept + 10)
    }
}
