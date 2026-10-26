import SwiftUI

enum SettingsPane: String, CaseIterable, Identifiable {
    case general, shortcut, engines, microphone, dictionary, history, stats

    var id: Self { self }

    var title: String {
        switch self {
        case .general: "General"
        case .shortcut: "Shortcut"
        case .engines: "Engines"
        case .microphone: "Microphone"
        case .dictionary: "Dictionary"
        case .history: "History"
        case .stats: "Stats"
        }
    }

    var symbol: String {
        switch self {
        case .general: "gearshape"
        case .shortcut: "keyboard"
        case .engines: "cpu"
        case .microphone: "mic"
        case .dictionary: "character.book.closed"
        case .history: "clock.arrow.circlepath"
        case .stats: "chart.bar.xaxis"
        }
    }
}

/** Settings in the shape of System Settings: a sidebar, and a grouped form per pane. */
struct SettingsView: View {
    @Bindable var model: AppModel
    let windows: WindowManager

    var body: some View {
        NavigationSplitView {
            List(SettingsPane.allCases, selection: $model.settingsPane) { pane in
                Label(pane.title, systemImage: pane.symbol)
            }
            .navigationSplitViewColumnWidth(min: 170, ideal: 190, max: 240)
        } detail: {
            let pane = model.settingsPane ?? .general
            Group {
                switch pane {
                case .general: GeneralPane(model: model)
                case .shortcut: ShortcutPane(model: model)
                case .engines: EnginesPane(model: model)
                case .microphone: MicrophonePane(model: model)
                case .dictionary: DictionaryPane(model: model)
                case .history: HistoryPane(model: model)
                case .stats: StatsPane(model: model)
                }
            }
            .navigationTitle(pane.title)
        }
        .task { await model.refreshAppleModels() }
    }
}
