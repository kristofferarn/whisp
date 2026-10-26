import Foundation
import WhispCore

/**
 * whisp's files: settings.json, history.json and stats.json in Application
 * Support. The dev build keeps its own folder, so a dev run never touches
 * the installed app's settings or history. Loaded once at launch; the app is
 * the only writer, so memory is the truth and the files are its shadow.
 * Writes go to a serial queue, atomically, latest state wins.
 */
struct Store {
    static let historyMax = 500

    let directory: URL
    private let queue = DispatchQueue(label: "whisp.store")

    init() {
        let isDev = Bundle.main.bundleIdentifier?.hasSuffix(".dev") ?? true
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        directory = base.appendingPathComponent(isDev ? "whisp-dev" : "whisp", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    func load<T: Decodable>(_ name: String, as type: T.Type) -> T? {
        guard let data = try? Data(contentsOf: directory.appendingPathComponent(name)) else { return nil }
        return try? Self.decoder.decode(T.self, from: data)
    }

    func save<T: Encodable>(_ name: String, _ value: T) {
        guard let data = try? Self.encoder.encode(value) else { return }
        let url = directory.appendingPathComponent(name)
        queue.async {
            do {
                try data.write(to: url, options: .atomic)
            } catch {
                NSLog("whisp: failed to write \(name): \(error)")
            }
        }
    }

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        e.dateEncodingStrategy = .iso8601
        return e
    }()

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()
}
