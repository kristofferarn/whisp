import Foundation
import Security

/**
 * The OpenAI API key, in the login Keychain as a generic password. It never
 * reaches the UI: Settings sees only "configured, ends in …abcd".
 */
nonisolated enum Keychain {
    private static var service: String { Bundle.main.bundleIdentifier ?? "com.kristofferarn.whisp" }
    private static let account = "openai-api-key"

    static func read() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let key = String(data: data, encoding: .utf8),
              !key.isEmpty
        else { return nil }
        return key
    }

    /** Stores the key, or removes it when nil or blank. */
    static func write(_ key: String?) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(base as CFDictionary)
        guard let key = key?.trimmingCharacters(in: .whitespacesAndNewlines), !key.isEmpty else { return }
        var item = base
        item[kSecValueData as String] = Data(key.utf8)
        item[kSecAttrLabel as String] = "whisp OpenAI API key"
        let status = SecItemAdd(item as CFDictionary, nil)
        if status != errSecSuccess { NSLog("whisp: keychain write failed: \(status)") }
    }
}
