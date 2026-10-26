import ServiceManagement

enum LoginItem {
    static var isEnabled: Bool { SMAppService.mainApp.status == .enabled }

    static func set(_ enabled: Bool) {
        do {
            if enabled, !isEnabled { try SMAppService.mainApp.register() }
            if !enabled, isEnabled { try SMAppService.mainApp.unregister() }
        } catch {
            NSLog("whisp: launch at login could not be changed: \(error)")
        }
    }
}
