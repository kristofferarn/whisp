import SwiftUI
import WhispCore

struct HistoryPane: View {
    @Bindable var model: AppModel
    @ViewState private var search = ""
    @ViewState private var selection = Set<HistoryEntry.ID>()
    @ViewState private var confirmClear = false

    private var entries: [HistoryEntry] {
        search.isEmpty ? model.history : model.history.filter { $0.text.localizedCaseInsensitiveContains(search) }
    }

    var body: some View {
        Group {
            if !model.settings.keepHistory {
                ContentUnavailableView(
                    "History is off",
                    systemImage: "clock.badge.xmark",
                    description: Text("Turn it on in General to keep your dictations here.")
                )
            } else if model.history.isEmpty {
                ContentUnavailableView(
                    "Nothing yet",
                    systemImage: "waveform",
                    description: Text("Hold \(model.settings.hotkey.shortName) and speak.")
                )
            } else {
                Table(entries, selection: $selection) {
                    TableColumn("When") { entry in
                        Text(entry.date, format: .relative(presentation: .named))
                            .foregroundStyle(.secondary)
                    }
                    .width(min: 80, ideal: 100, max: 140)
                    TableColumn("Text") { entry in
                        Text(entry.text).lineLimit(2)
                    }
                    TableColumn("Engine") { entry in
                        Text(entry.engine)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .width(min: 90, ideal: 160, max: 260)
                }
                .contextMenu(forSelectionType: HistoryEntry.ID.self) { ids in
                    Button("Copy") { copy(ids) }
                    Button("Delete", role: .destructive) { model.deleteHistory(ids) }
                } primaryAction: { ids in
                    copy(ids)
                }
                .onCopyCommand {
                    [NSItemProvider(object: text(of: selection) as NSString)]
                }
                .onDeleteCommand { model.deleteHistory(selection) }
            }
        }
        .searchable(text: $search, placement: .toolbar)
        .toolbar {
            Button("Clear History", systemImage: "trash") { confirmClear = true }
                .disabled(model.history.isEmpty)
        }
        .confirmationDialog("Delete all dictations from history?", isPresented: $confirmClear) {
            Button("Delete All", role: .destructive) { model.clearHistory() }
        } message: {
            Text("Stats are kept.")
        }
    }

    private func text(of ids: Set<HistoryEntry.ID>) -> String {
        model.history.filter { ids.contains($0.id) }.map(\.text).joined(separator: "\n\n")
    }

    private func copy(_ ids: Set<HistoryEntry.ID>) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text(of: ids), forType: .string)
    }
}
