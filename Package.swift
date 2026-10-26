// swift-tools-version: 6.2
import PackageDescription

// whisp builds with SwiftPM alone — no Xcode project. scripts/build.sh turns
// the Whisp executable into a signed whisp.app; `swift test` runs the core
// logic's tests. WhispCore holds everything that is pure decision-making
// (gestures, the take queue, settings, the cleanup prompt) so it can be
// tested without a microphone, a keyboard or a window server.
let package = Package(
    name: "Whisp",
    platforms: [.macOS("26.0")],
    targets: [
        .target(
            name: "WhispCore",
            path: "Sources/WhispCore"
        ),
        .executableTarget(
            name: "Whisp",
            dependencies: ["WhispCore"],
            path: "Sources/Whisp",
            swiftSettings: [.defaultIsolation(MainActor.self)]
        ),
        .testTarget(
            name: "WhispCoreTests",
            dependencies: ["WhispCore"],
            path: "Tests/WhispCoreTests"
        )
    ]
)
