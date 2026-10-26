import SwiftUI

@main
struct WhispApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        MenuBarExtra {
            MenuBarPopover(model: delegate.model, windows: delegate.windows)
        } label: {
            MenuBarIcon(model: delegate.model)
        }
        .menuBarExtraStyle(.window)
    }
}

/** A template symbol: filled while recording, slashed while muted or unable to hear the key. */
private struct MenuBarIcon: View {
    let model: AppModel

    var body: some View {
        let name: String = if model.muted || !model.hotkeyActive {
            "waveform.slash"
        } else if model.phase == .listening || model.phase == .handsFree {
            "waveform.circle.fill"
        } else {
            "waveform"
        }
        Image(systemName: name)
    }
}
