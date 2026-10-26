import SwiftUI

/**
 * The pill. On a screen with a notch it is an island: a black shape that
 * grows out of the notch (black, because that is what the notch is), with
 * the state on the left, the microphone level on the right, and the words
 * heard so far underneath. Elsewhere it is a Liquid Glass capsule just
 * under the menu bar with the same content in one row.
 */
struct PillView: View {
    let model: AppModel
    let geometry: PillGeometry

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var animation: Animation {
        reduceMotion ? .easeInOut(duration: 0.15) : .spring(response: 0.38, dampingFraction: 0.78)
    }

    /** The line under the island: a message, or the live words. */
    private var caption: String? {
        if let flash = model.flash { return flash }
        if model.phase != .idle, !model.liveText.isEmpty { return model.liveText }
        return nil
    }

    var body: some View {
        VStack(spacing: 0) {
            if let notch = geometry.notch {
                island(notch: notch)
            } else {
                capsule
                    .padding(.top, geometry.menuBarHeight + 6)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(animation, value: model.pillShown)
        .animation(animation, value: caption != nil)
        .animation(animation, value: model.phase)
        .animation(animation, value: model.flash)
    }

    // MARK: Notch island

    private func island(notch: CGSize) -> some View {
        let shown = model.pillShown
        let ear: CGFloat = 64
        let width = shown ? notch.width + ear * 2 : notch.width
        let captionHeight: CGFloat = shown && caption != nil ? 30 : 0
        let radius: CGFloat = shown ? 18 : 10
        return ZStack(alignment: .top) {
            UnevenRoundedRectangle(bottomLeadingRadius: radius, bottomTrailingRadius: radius, style: .continuous)
                .fill(.black)
            if shown {
                VStack(spacing: 0) {
                    HStack {
                        StatusGlyph(model: model)
                            .frame(width: ear, alignment: .center)
                        Spacer(minLength: notch.width)
                        Group {
                            if model.phase == .listening || model.phase == .handsFree {
                                LevelBars(levels: model.levels, color: .white)
                            } else {
                                Color.clear
                            }
                        }
                        .frame(width: ear, alignment: .center)
                    }
                    .frame(height: notch.height)
                    if let caption {
                        CaptionLine(text: caption, isMessage: model.flash != nil)
                            .padding(.horizontal, 18)
                            .frame(height: captionHeight - 4)
                    }
                }
                .transition(.opacity)
            }
        }
        .frame(width: width, height: notch.height + captionHeight)
        .environment(\.colorScheme, .dark)
    }

    // MARK: Glass capsule

    @ViewBuilder
    private var capsule: some View {
        if model.pillShown {
            HStack(spacing: 10) {
                StatusGlyph(model: model)
                if model.phase == .listening || model.phase == .handsFree {
                    LevelBars(levels: model.levels, color: .primary)
                }
                if let caption {
                    CaptionLine(text: caption, isMessage: model.flash != nil)
                        .frame(maxWidth: 320)
                }
            }
            .padding(.horizontal, 16)
            .frame(height: 38)
            .glassEffect(.regular, in: .capsule)
            .transition(.scale(scale: 0.6, anchor: .top).combined(with: .opacity))
        }
    }
}

/** What the take is doing, as one symbol. */
private struct StatusGlyph: View {
    let model: AppModel

    var body: some View {
        Group {
            if model.flash != nil {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.yellow)
            } else {
                switch model.phase {
                case .listening:
                    Image(systemName: "mic.fill")
                        .foregroundStyle(.red)
                        .symbolEffect(.pulse, options: .repeating)
                case .handsFree:
                    Image(systemName: "infinity")
                        .foregroundStyle(.orange)
                        .symbolEffect(.pulse, options: .repeating)
                case .transcribing:
                    Image(systemName: "ellipsis")
                        .symbolEffect(.variableColor.iterative, options: .repeating)
                case .idle:
                    Image(systemName: "checkmark")
                }
            }
        }
        .font(.system(size: 13, weight: .semibold))
        .contentTransition(.symbolEffect(.replace))
    }
}

/** The microphone's recent loudness, newest on the right. */
private struct LevelBars: View {
    let levels: [Float]
    let color: Color
    private let count = 9

    var body: some View {
        HStack(alignment: .center, spacing: 2.5) {
            ForEach(Array(levels.suffix(count).enumerated()), id: \.offset) { _, level in
                Capsule()
                    .fill(color)
                    .frame(width: 3, height: 3 + CGFloat(level) * 15)
            }
        }
        .frame(height: 18)
        .animation(.linear(duration: 1.0 / 30), value: levels)
    }
}

/** One line of text; live words keep their newest end visible. */
private struct CaptionLine: View {
    let text: String
    let isMessage: Bool

    var body: some View {
        Text(text)
            .font(.system(size: 12.5, weight: isMessage ? .medium : .regular))
            .foregroundStyle(isMessage ? .primary : .secondary)
            .lineLimit(1)
            .truncationMode(isMessage ? .tail : .head)
            .contentTransition(.interpolate)
    }
}
