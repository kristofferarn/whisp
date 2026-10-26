#if DEBUG
import AppKit
import SwiftUI
import WhispCore

/**
 * `Whisp --snapshot <dir>` (debug builds only): renders the windows and the
 * pill's states into PNGs, from sample data, without touching the real
 * settings or showing anything on screen. For checking layout without a
 * screen recording grant.
 */
enum Snapshots {
    static var requested: Bool { CommandLine.arguments.contains("--snapshot") }

    static func run(windows: WindowManager) async -> Int32 {
        let args = CommandLine.arguments
        guard let index = args.firstIndex(of: "--snapshot"), args.indices.contains(index + 1) else {
            print("usage: Whisp --snapshot <dir>")
            return 2
        }
        let dir = URL(fileURLWithPath: args[index + 1], isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        let model = sampleModel()
        let scheme = args.contains("--dark") ? NSAppearance(named: .darkAqua) : NSAppearance(named: .aqua)

        for pane in SettingsPane.allCases {
            model.settingsPane = pane
            save(SettingsView(model: model, windows: windows), size: CGSize(width: 860, height: 580), to: dir.appendingPathComponent("settings-\(pane.rawValue).png"), appearance: scheme)
        }
        save(MenuBarPopover(model: model, windows: windows), size: CGSize(width: 320, height: 330), to: dir.appendingPathComponent("popover.png"), appearance: scheme)
        save(WelcomeView(model: model) {}, size: CGSize(width: 560, height: 520), to: dir.appendingPathComponent("welcome.png"), appearance: scheme)

        let notch = PillGeometry(notch: CGSize(width: 185, height: 32), menuBarHeight: 32)
        let plain = PillGeometry(notch: nil, menuBarHeight: 24)
        model.pillShown = true
        model.levels = (0..<AppModel.levelCount).map { Float(0.25 + 0.6 * abs(sin(Double($0) * 0.7))) }
        let states: [(String, Phase, String, String?)] = [
            ("listening", .listening, "", nil),
            ("live", .listening, "So the meeting is on Wednesday at three, and tell Kristoffer to bring", nil),
            ("handsfree", .handsFree, "", nil),
            ("transcribing", .transcribing, "", nil),
            ("error", .idle, "", "Add your OpenAI API key in Settings › Engines")
        ]
        for (name, phase, live, flash) in states {
            model.phase = phase
            model.liveText = live
            model.flash = flash
            save(PillView(model: model, geometry: notch).background(Color.gray.opacity(0.35)), size: CGSize(width: 520, height: 140), to: dir.appendingPathComponent("pill-notch-\(name).png"), appearance: scheme)
            save(PillView(model: model, geometry: plain).background(Color.gray.opacity(0.35)), size: CGSize(width: 520, height: 140), to: dir.appendingPathComponent("pill-capsule-\(name).png"), appearance: scheme)
        }
        print("wrote snapshots to \(dir.path)")
        return 0
    }

    private static func sampleModel() -> AppModel {
        let model = AppModel(sample: true)
        model.settings.dictionary = ["Kristoffer", "whisp", "SwiftUI", "Enable", "SpeechAnalyzer"]
        model.hotkeyActive = true
        model.appleModels = [.en: .installed, .no: .notInstalled]
        let texts = [
            "The meeting is on Wednesday at 3. Tell Kristoffer to bring the slides.",
            "Can you take a look at the pull request when you have a minute?",
            "Møtet er flyttet til onsdag klokka tre."
        ]
        for (i, text) in texts.enumerated() {
            model.record(text: text, seconds: Double(4 + i * 3), engine: "On-device (English) · Apple Intelligence")
        }
        return model
    }

    private static func save<V: View>(_ view: V, size: CGSize, to url: URL, appearance: NSAppearance?) {
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = appearance
        let host = NSHostingView(rootView: view.frame(width: size.width, height: size.height))
        host.frame = NSRect(origin: .zero, size: size)
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.4))
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return }
        host.cacheDisplay(in: host.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: url)
    }
}
#endif
