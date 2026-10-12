import Foundation

#if canImport(Security)
import Security
#endif

/// Where the client keeps its refresh token: the one thing of a session that outlives the
/// process.
///
/// **A failure is thrown, never answered as "nothing stored".** A store that cannot be read
/// (a locked Keychain, a missing entitlement) is not a signed-out user: the client reports
/// `storage.failed` and keeps the session it has. Only `nil` from `get` means no token.
public protocol TulaTokenStorage: Sendable {
    /// The value under `key`, or `nil` when there is none.
    func get(_ key: String) async throws -> String?
    /// Store `value` under `key`, replacing what was there.
    func set(_ key: String, _ value: String) async throws
    /// Remove what is under `key`. Nothing there is not a failure.
    func remove(_ key: String) async throws
}

/// A store in the process's memory: for tests, and for an app that wants no session to
/// outlive it. The token is gone when the process ends.
public actor MemoryTokenStorage: TulaTokenStorage {
    private var values: [String: String] = [:]

    /// An empty storage.
    public init() {}

    /// The value under `key`, or `nil` when there is none.
    public func get(_ key: String) -> String? { values[key] }
    /// Keep `value` under `key`, over what was there.
    public func set(_ key: String, _ value: String) { values[key] = value }
    /// Forget what is under `key`.
    public func remove(_ key: String) { values[key] = nil }
}

#if canImport(Security)

/// When the Keychain hands the refresh token out. A closed pair: both keep the item on this
/// device (never in a backup that another device restores, never in iCloud Keychain).
public enum KeychainAccessibility: Sendable {
    /// Only while the device is unlocked (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`).
    /// The default. A refresh made while the device is locked fails with `storage.failed`
    /// and keeps the session.
    case whenUnlocked
    /// From the first unlock after a restart (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`):
    /// for an app that refreshes in the background.
    case afterFirstUnlock

    var attribute: CFString {
        switch self {
        case .whenUnlocked: return kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        case .afterFirstUnlock: return kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        }
    }
}

/// A Keychain call that failed. It carries the status and nothing of what was stored.
public struct KeychainError: Error, Hashable, Sendable {
    /// The `OSStatus` the Security framework answered.
    public let status: Int32
}

/// The four calls of the Security framework the store makes, so that a test can stand in for
/// the Keychain. An app never implements this.
protocol KeychainItems: Sendable {
    func copyMatching(_ query: [String: Any]) -> (status: OSStatus, data: Data?)
    func add(_ attributes: [String: Any]) -> OSStatus
    func update(_ query: [String: Any], _ attributes: [String: Any]) -> OSStatus
    func delete(_ query: [String: Any]) -> OSStatus
}

struct SystemKeychainItems: KeychainItems {
    func copyMatching(_ query: [String: Any]) -> (status: OSStatus, data: Data?) {
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        return (status, result as? Data)
    }

    func add(_ attributes: [String: Any]) -> OSStatus {
        SecItemAdd(attributes as CFDictionary, nil)
    }

    func update(_ query: [String: Any], _ attributes: [String: Any]) -> OSStatus {
        SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    }

    func delete(_ query: [String: Any]) -> OSStatus {
        SecItemDelete(query as CFDictionary)
    }
}

/// The refresh token in the Keychain: a generic password that stays on this device.
///
/// The item is never synchronised (`kSecAttrSynchronizable` false) and its accessibility is
/// one of the two `ThisDeviceOnly` classes of `KeychainAccessibility`, so it is in no backup
/// another device can restore. Nothing is cached here: every read asks the Keychain. Every
/// status but "not found" on a read is thrown as a `KeychainError`; the client reports it as
/// `storage.failed` and keeps the session.
public struct KeychainTokenStorage: TulaTokenStorage {
    private let service: String
    private let accessibility: KeychainAccessibility
    private let items: any KeychainItems

    /// - Parameters:
    ///   - service: The Keychain service the item is filed under. One per app is enough: the
    ///     client's key already names the API and the environment.
    ///   - accessibility: When the token can be read. See `KeychainAccessibility`.
    public init(service: String = "dev.tula.auth", accessibility: KeychainAccessibility = .whenUnlocked) {
        self.init(service: service, accessibility: accessibility, items: SystemKeychainItems())
    }

    init(service: String, accessibility: KeychainAccessibility, items: any KeychainItems) {
        self.service = service
        self.accessibility = accessibility
        self.items = items
    }

    private func query(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecAttrSynchronizable as String: false,
            // The iOS-style Keychain on macOS too: the file-based one has no accessibility
            // classes, and an item there could be exported with the keychain file.
            kSecUseDataProtectionKeychain as String: true,
        ]
    }

    /// The value under `key`, or `nil` when the Keychain has none. Throws `KeychainError` for any other answer of the Keychain: never `nil`.
    public func get(_ key: String) async throws -> String? {
        var query = self.query(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        let (status, data) = items.copyMatching(query)
        if status == errSecItemNotFound {
            return nil
        }
        // An item that is there and cannot be read as a token is a failure, not "no token":
        // answering nil would sign the user out for something that may pass.
        guard status == errSecSuccess, let data, let value = String(data: data, encoding: .utf8), !value.isEmpty else {
            throw KeychainError(status: status == errSecSuccess ? errSecDecode : status)
        }
        return value
    }

    /// Keep `value` under `key`, over what was there. Throws `KeychainError` when the Keychain refuses.
    public func set(_ key: String, _ value: String) async throws {
        let data = Data(value.utf8)
        // The accessibility is set again on an update, so that an item written by an earlier
        // configuration does not keep a wider class.
        let changed: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: accessibility.attribute,
        ]
        var status = items.update(query(key), changed)
        if status == errSecItemNotFound {
            status = items.add(query(key).merging(changed) { _, new in new })
            if status == errSecDuplicateItem {
                // Another writer of the same entry got there between the two calls.
                status = items.update(query(key), changed)
            }
        }
        guard status == errSecSuccess else {
            throw KeychainError(status: status)
        }
    }

    /// Remove what is under `key`; nothing there is not an error. Throws `KeychainError` when the Keychain refuses.
    public func remove(_ key: String) async throws {
        let status = items.delete(query(key))
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError(status: status)
        }
    }
}

#endif
