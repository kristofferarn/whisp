import AppKit
import SwiftUI

/** Where the pill sits on a screen, and whether there is a notch to grow from. */
struct PillGeometry: Equatable {
    /** Notch size, or nil on screens without one. */
    var notch: CGSize?
    /** Height of the menu bar, for placing the capsule just under it. */
    var menuBarHeight: CGFloat

    static func of(_ screen: NSScreen) -> PillGeometry {
        let menuBar = max(0, screen.frame.maxY - screen.visibleFrame.maxY)
        if screen.safeAreaInsets.top > 0,
           let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
            let width = screen.frame.width - left.width - right.width
            return PillGeometry(notch: CGSize(width: width, height: screen.safeAreaInsets.top), menuBarHeight: menuBar)
        }
        return PillGeometry(notch: nil, menuBarHeight: menuBar)
    }
}

/**
 * The window the pill lives in: borderless, transparent, above everything
 * (full-screen apps included), on every Space, never key, never in the way
 * of a click. It is sized for the pill's largest state and pinned to the top
 * centre of the screen the pointer is on; the SwiftUI view inside animates
 * between collapsed and expanded, and the window only leaves the screen once
 * the collapse has played.
 */
final class PillPanel {
    private static let size = CGSize(width: 520, height: 140)

    private let model: AppModel
    private var panel: NSPanel?
    private var geometry = PillGeometry(notch: nil, menuBarHeight: 24)
    private var hideTask: Task<Void, Never>?

    init(model: AppModel) {
        self.model = model
    }

    private var wanted: Bool { model.phase != .idle || model.flash != nil }

    func sync() {
        if wanted { show() } else { hide() }
    }

    private func show() {
        hideTask?.cancel()
        hideTask = nil
        let screen = Self.pointerScreen()
        let panel = self.panel ?? makePanel()
        let geometry = PillGeometry.of(screen)
        if geometry != self.geometry || !panel.isVisible {
            self.geometry = geometry
            panel.contentView = NSHostingView(rootView: PillView(model: model, geometry: geometry))
        }
        let frame = NSRect(
            x: screen.frame.midX - Self.size.width / 2,
            y: screen.frame.maxY - Self.size.height,
            width: Self.size.width, height: Self.size.height
        )
        if panel.frame != frame { panel.setFrame(frame, display: false) }
        panel.orderFrontRegardless()
        if !model.pillShown {
            // One runloop turn collapsed, so SwiftUI has a "before" to animate from.
            DispatchQueue.main.async { self.model.pillShown = self.wanted }
        }
    }

    private func hide() {
        guard model.pillShown || panel?.isVisible == true, hideTask == nil else { return }
        model.pillShown = false
        hideTask = Task {
            try? await Task.sleep(for: .milliseconds(450))
            guard !Task.isCancelled else { return }
            panel?.orderOut(nil)
            hideTask = nil
        }
    }

    private func makePanel() -> NSPanel {
        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: Self.size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: true
        )
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        self.panel = panel
        return panel
    }

    private static func pointerScreen() -> NSScreen {
        let point = NSEvent.mouseLocation
        return NSScreen.screens.first { $0.frame.contains(point) } ?? NSScreen.main ?? NSScreen.screens[0]
    }
}
