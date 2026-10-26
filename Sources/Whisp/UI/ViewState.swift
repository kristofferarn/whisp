import SwiftUI

/**
 * SwiftUI's `@State`, spelled so it builds without Xcode. The macOS 27 SDK
 * declares a `State` macro that shadows the property wrapper, and its plugin
 * ships only with Xcode — the Command Line Tools can't expand it. Naming the
 * wrapper type through an alias skips the macro and gets the same storage.
 */
typealias ViewState<Value> = SwiftUI.State<Value>
