import SwiftUI
import WhispCore

struct DictionaryPane: View {
    @Bindable var model: AppModel
    @ViewState private var draft = ""

    var body: some View {
        Form {
            Section {
                HStack {
                    TextField("Add a word or name", text: $draft)
                        .onSubmit(add)
                    Button("Add", action: add)
                        .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            } footer: {
                Text("Names, products and jargon whisp should spell your way. They guide the transcriber (on-device and gpt-transcribe) and the cleanup pass. Up to 100.")
            }
            if !model.settings.dictionary.isEmpty {
                Section("\(model.settings.dictionary.count) words") {
                    FlowLayout(spacing: 6) {
                        ForEach(model.settings.dictionary, id: \.self) { word in
                            WordToken(word: word) { remove(word) }
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
        }
        .formStyle(.grouped)
    }

    private func add() {
        let words = draft.split(separator: ",").map(String.init)
        model.settings.dictionary = WhispSettings.sanitizeDictionary(model.settings.dictionary + words)
        draft = ""
    }

    private func remove(_ word: String) {
        model.settings.dictionary.removeAll { $0 == word }
    }
}

private struct WordToken: View {
    let word: String
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            Text(word)
            Button(action: remove) {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .help("Remove \(word)")
        }
        .padding(.leading, 10)
        .padding(.trailing, 6)
        .padding(.vertical, 4)
        .background(.tint.opacity(0.15), in: .capsule)
    }
}

/** Wraps its children onto as many lines as they need. */
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(subviews, width: proposal.width ?? .infinity)
        let height = rows.last.map { $0.y + $0.height } ?? 0
        let width = rows.map(\.width).max() ?? 0
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for row in arrange(subviews, width: bounds.width) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: bounds.minY + row.y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
        }
    }

    private struct Row {
        var indices: [Int] = []
        var y: CGFloat = 0
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func arrange(_ subviews: Subviews, width: CGFloat) -> [Row] {
        var rows = [Row()]
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            if !rows[rows.count - 1].indices.isEmpty, rows[rows.count - 1].width + spacing + size.width > width {
                let last = rows[rows.count - 1]
                rows.append(Row(y: last.y + last.height + spacing))
            }
            var row = rows[rows.count - 1]
            row.width += (row.indices.isEmpty ? 0 : spacing) + size.width
            row.height = max(row.height, size.height)
            row.indices.append(index)
            rows[rows.count - 1] = row
        }
        return rows
    }
}
