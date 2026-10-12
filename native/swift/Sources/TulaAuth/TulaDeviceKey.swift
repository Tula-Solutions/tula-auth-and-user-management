import CryptoKit
import Foundation

#if canImport(Security)
import Security
#endif

/// The public half of a device key: a point of the curve P-256, and nothing else.
public struct TulaDevicePublicKey: Hashable, Sendable {
    /// The point's x coordinate: 32 bytes.
    public let x: Data
    /// The point's y coordinate: 32 bytes.
    public let y: Data

    /// - Parameter rawRepresentation: The point as `x` then `y`, 32 bytes each (64 bytes):
    ///   what CryptoKit calls a P-256 public key's raw representation.
    /// - Returns: `nil` for anything that is not 64 bytes.
    public init?(rawRepresentation: Data) {
        guard rawRepresentation.count == 64 else {
            return nil
        }
        let bytes = Data(rawRepresentation)
        self.x = bytes.prefix(32)
        self.y = bytes.suffix(32)
    }
}

/// A key a session can be bound to (ADR 0043): its public half, and a way to sign with the
/// private half that never hands the private half out.
public protocol TulaDeviceKey: Sendable {
    /// The public key, sent in every proof's header.
    var publicKey: TulaDevicePublicKey { get }
    /// Sign with ECDSA over P-256 and SHA-256.
    ///
    /// - Parameter message: The bytes to sign (a proof's `header.payload`).
    /// - Returns: The signature as `r` then `s`, 32 bytes each (64 bytes).
    func sign(_ message: Data) async throws -> Data
}

/// Where the client's device key is kept.
///
/// **"There is no key" and "the key could not be had" are different answers, and the client
/// acts on the difference.** `existing()` returns `nil` only when the store knows there is no
/// key: a bound session whose key is gone is over, and the client ends it. It throws when it
/// cannot tell (a locked device, a store that failed): the client reports `device.key_failed`
/// and keeps the session, because the same call may work a moment later. Never answer `nil`
/// for a failure, and never throw for a key that is simply not there.
public protocol TulaDeviceKeyStore: Sendable {
    /// The key of this app on this device, or `nil` when there is none.
    ///
    /// - Throws: when the store cannot say whether there is a key, or cannot hand it out.
    func existing() async throws -> (any TulaDeviceKey)?
    /// Make the key and keep it. Called only after `existing()` answered `nil`; a store that
    /// finds a key was made meanwhile returns that one.
    func create() async throws -> any TulaDeviceKey
}

/// A P-256 key in the process's memory.
struct SoftwareDeviceKey: TulaDeviceKey {
    let key: P256.Signing.PrivateKey
    let publicKey: TulaDevicePublicKey

    init?(_ key: P256.Signing.PrivateKey) {
        guard let point = TulaDevicePublicKey(rawRepresentation: key.publicKey.rawRepresentation) else {
            return nil
        }
        self.key = key
        self.publicKey = point
    }

    func sign(_ message: Data) throws -> Data {
        try key.signature(for: message).rawRepresentation
    }
}

/// A device key made in software and kept in the process's memory: for tests and previews.
///
/// It proves nothing about hardware, and the key is gone when the process ends (a session
/// bound to it then cannot be refreshed by the next start). An app uses
/// `KeychainDeviceKeyStore`.
public actor SoftwareDeviceKeyStore: TulaDeviceKeyStore {
    private var key: SoftwareDeviceKey?

    /// A store with no key yet.
    public init() {}

    /// The key, or `nil` before the first `create()` and after `forget()`.
    public func existing() -> (any TulaDeviceKey)? { key }

    /// The key, made now when there is none.
    public func create() throws -> any TulaDeviceKey {
        if let key {
            return key
        }
        guard let made = SoftwareDeviceKey(P256.Signing.PrivateKey()) else {
            throw DeviceKeyStoreError.unusable
        }
        key = made
        return made
    }

    /// Lose the key, as a device that was erased has: for a test of what the client then does.
    public func forget() { key = nil }
}

/// Why a device key store could not hand out a key. It carries nothing of the key, and the
/// client keeps nothing of it: every failure is the one `device.key_failed`.
enum DeviceKeyStoreError: Error {
    /// The platform has no hardware key store here (a simulator, a Mac without one).
    case unavailable
    /// What the store holds cannot be used as a key.
    case unusable
}

/// What makes and opens a device key, so that a test can stand in for the Secure Enclave.
/// An app never implements this.
protocol DeviceKeyEnclave: Sendable {
    /// Whether keys can be made here at all.
    var isAvailable: Bool { get }
    /// Make a key and return what is kept of it: for the Secure Enclave a blob only that
    /// enclave can open, never the private key itself.
    func make(accessibility: KeychainAccessibility) throws -> Data
    /// The key behind what `make` returned.
    func open(_ kept: Data) throws -> any TulaDeviceKey
}

/// A key held in software, kept as its private scalar. Only what a simulator build uses,
/// where there is no Secure Enclave, and what the unit tests put behind the store.
struct SoftwareEnclave: DeviceKeyEnclave {
    var isAvailable: Bool { true }

    func make(accessibility: KeychainAccessibility) throws -> Data {
        P256.Signing.PrivateKey().rawRepresentation
    }

    func open(_ kept: Data) throws -> any TulaDeviceKey {
        guard let key = SoftwareDeviceKey(try P256.Signing.PrivateKey(rawRepresentation: kept)) else {
            throw DeviceKeyStoreError.unusable
        }
        return key
    }
}

#if canImport(Security)

/// A key of the device's Secure Enclave.
struct EnclaveDeviceKey: TulaDeviceKey {
    let key: SecureEnclave.P256.Signing.PrivateKey
    let publicKey: TulaDevicePublicKey

    func sign(_ message: Data) throws -> Data {
        try key.signature(for: message).rawRepresentation
    }
}

/// The Secure Enclave, through CryptoKit. The private key never leaves the enclave: what is
/// kept is a blob that only this device's enclave can turn back into a key.
struct SecureEnclaveKeys: DeviceKeyEnclave {
    var isAvailable: Bool { SecureEnclave.isAvailable }

    func make(accessibility: KeychainAccessibility) throws -> Data {
        var failure: Unmanaged<CFError>?
        guard
            let access = SecAccessControlCreateWithFlags(nil, accessibility.attribute, [.privateKeyUsage], &failure)
        else {
            failure?.release()
            throw DeviceKeyStoreError.unavailable
        }
        return try SecureEnclave.P256.Signing.PrivateKey(accessControl: access).dataRepresentation
    }

    func open(_ kept: Data) throws -> any TulaDeviceKey {
        let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: kept)
        guard let point = TulaDevicePublicKey(rawRepresentation: key.publicKey.rawRepresentation) else {
            throw DeviceKeyStoreError.unusable
        }
        return EnclaveDeviceKey(key: key, publicKey: point)
    }
}

/// The device key of an app: a P-256 key of the Secure Enclave, which signs and cannot be
/// read, with what the enclave needs to find it again kept in the Keychain.
///
/// The Keychain item is a generic password that is never synchronised and stays on this
/// device (one of the two `ThisDeviceOnly` classes of `KeychainAccessibility`); it holds a
/// blob that only this device's enclave can open, not a private key. **A build for the
/// simulator, which has no Secure Enclave, keeps a software key there instead**: that is for
/// development only and protects nothing.
///
/// `existing()` answers `nil` only for the Keychain's "no such item". Every other answer is
/// thrown (a locked device, an entitlement that is missing, a blob the enclave will not
/// open), so that the client keeps the session and says `device.key_failed`.
public struct KeychainDeviceKeyStore: TulaDeviceKeyStore {
    private let service: String
    private let name: String
    private let accessibility: KeychainAccessibility
    private let items: any KeychainItems
    private let enclave: any DeviceKeyEnclave

    /// - Parameters:
    ///   - service: The Keychain service the item is filed under.
    ///   - name: The item's account. Two clients of one app that must not share a key (two
    ///     environments, say) are given two names.
    ///   - accessibility: When the key can be used. An app that refreshes in the background
    ///     takes `.afterFirstUnlock`, for this store and for its token storage alike.
    public init(
        service: String = "dev.tula.auth.device-key",
        name: String = "default",
        accessibility: KeychainAccessibility = .whenUnlocked
    ) {
        self.init(
            service: service, name: name, accessibility: accessibility,
            items: SystemKeychainItems(), enclave: KeychainDeviceKeyStore.platformEnclave())
    }

    init(
        service: String, name: String, accessibility: KeychainAccessibility,
        items: any KeychainItems, enclave: any DeviceKeyEnclave
    ) {
        self.service = service
        self.name = name
        self.accessibility = accessibility
        self.items = items
        self.enclave = enclave
    }

    static func platformEnclave() -> any DeviceKeyEnclave {
        #if targetEnvironment(simulator)
        return SoftwareEnclave()
        #else
        return SecureEnclaveKeys()
        #endif
    }

    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: name,
            kSecAttrSynchronizable as String: false,
            kSecUseDataProtectionKeychain as String: true,
        ]
    }

    private func kept() throws -> Data? {
        var query = self.query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        let (status, data) = items.copyMatching(query)
        if status == errSecItemNotFound {
            return nil
        }
        // An item that is there and cannot be read is a failure, not "no key": answering nil
        // would end a session for something that may pass.
        guard status == errSecSuccess, let data, !data.isEmpty else {
            throw KeychainError(status: status == errSecSuccess ? errSecDecode : status)
        }
        return data
    }

    /// The key, or `nil` when the Keychain has no such item. Throws for every other answer.
    public func existing() async throws -> (any TulaDeviceKey)? {
        guard let kept = try kept() else {
            return nil
        }
        return try enclave.open(kept)
    }

    /// Make the key in the enclave and keep what finds it again. A key another caller made
    /// between the look and the write is the one returned: a client has one key.
    public func create() async throws -> any TulaDeviceKey {
        guard enclave.isAvailable else {
            throw DeviceKeyStoreError.unavailable
        }
        let made = try enclave.make(accessibility: accessibility)
        var attributes = query
        attributes[kSecValueData as String] = made
        attributes[kSecAttrAccessible as String] = accessibility.attribute
        let status = items.add(attributes)
        if status == errSecDuplicateItem, let kept = try kept() {
            return try enclave.open(kept)
        }
        guard status == errSecSuccess else {
            throw KeychainError(status: status)
        }
        return try enclave.open(made)
    }

    /// Remove the key. A session bound to it can no longer be refreshed: the client ends it
    /// at its next refresh. Nothing there is not an error.
    public func remove() async throws {
        let status = items.delete(query)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError(status: status)
        }
    }
}

#endif

/// The proofs of a client (RFC 9449, ADR 0043): which requests carry one, the key that signs
/// them and the server's newest nonce.
///
/// The nonce is held here, in memory, and nowhere else. A proof is made for one request and
/// never kept.
final class DeviceProofs: @unchecked Sendable {
    /// What a request needs a key for.
    enum Use: Sendable {
        /// The start of an attempt: the session it ends in is bound to the key, which is made
        /// when there is none.
        case start
        /// The refresh of a session: only a key that exists can prove it.
        case refresh
    }

    /// The requests a device key proves: the six that start an attempt and the refresh of a
    /// session. A closed set, as `@tula/core`'s `PROVEN`; the server reads a proof nowhere
    /// else.
    static let proven: [String: Use] = [
        TulaOperations.startSignUp.id: .start,
        TulaOperations.startSignIn.id: .start,
        TulaOperations.startPasswordReset.id: .start,
        TulaOperations.startPasskeySignIn.id: .start,
        TulaOperations.startOAuthSignIn.id: .start,
        TulaOperations.startIdTokenSignIn.id: .start,
        TulaOperations.refreshSession.id: .refresh,
    ]

    /// The request header a proof travels in, and the response header a nonce comes in.
    static let header = "DPoP"
    static let nonceHeader = "DPoP-Nonce"

    private let store: any TulaDeviceKeyStore
    private let lock = NSLock()
    private var newest: String?

    init(store: any TulaDeviceKeyStore) {
        self.store = store
    }

    var nonce: String? {
        get { lock.withLock { newest } }
        set { lock.withLock { newest = newValue } }
    }

    /// The key a request is proven with; `nil` for a refresh when there is no key.
    ///
    /// - Throws: `device.key_failed` when the store could not hand one out. What it threw is
    ///   dropped: its text is the platform's, and an app logs what it catches.
    func key(for use: Use) async throws -> (any TulaDeviceKey)? {
        do {
            if let key = try await store.existing() {
                return key
            }
            return use == .start ? try await store.create() : nil
        } catch {
            throw TulaError.client(TulaClientErrorCode.deviceKeyFailed)
        }
    }

    /// Whether the store says, now, that there is no key. `false` when it has one and when it
    /// cannot tell.
    func keyIsGone() async -> Bool {
        guard let found = try? await store.existing() as (any TulaDeviceKey)?? else {
            return false
        }
        return found == nil
    }

    /// A proof for one request: a JWT of type `dpop+jwt` signed by the key, with the key's
    /// public half in its header and the request's method, the API's address, the time, a
    /// unique id and the server's nonce as its claims.
    func proof(_ key: any TulaDeviceKey, method: String, url: String, now: Date) async throws -> String {
        var claims: [String: Any] = [
            "htm": method,
            "htu": url,
            "iat": Int(now.timeIntervalSince1970),
            "jti": DeviceProofs.base64url(DeviceProofs.random(16)),
        ]
        if let nonce {
            claims["nonce"] = nonce
        }
        let point = key.publicKey
        let header: [String: Any] = [
            "typ": "dpop+jwt",
            "alg": "ES256",
            "jwk": [
                "kty": "EC", "crv": "P-256",
                "x": DeviceProofs.base64url(point.x), "y": DeviceProofs.base64url(point.y),
            ],
        ]
        do {
            let signed =
                DeviceProofs.base64url(try JSONSerialization.data(withJSONObject: header, options: [.sortedKeys]))
                + "."
                + DeviceProofs.base64url(
                    try JSONSerialization.data(withJSONObject: claims, options: [.sortedKeys, .withoutEscapingSlashes]))
            let signature = try await key.sign(Data(signed.utf8))
            guard signature.count == 64 else {
                throw DeviceKeyStoreError.unusable
            }
            return signed + "." + DeviceProofs.base64url(signature)
        } catch {
            throw TulaError.client(TulaClientErrorCode.deviceKeyFailed)
        }
    }

    static func random(_ count: Int) -> Data {
        var generator = SystemRandomNumberGenerator()
        return Data((0..<count).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
    }

    static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// The bytes of unpadded base64url text; `nil` for anything else.
    static func bytes(base64url text: String) -> Data? {
        guard !text.isEmpty, text.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") })
        else {
            return nil
        }
        var padded = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        padded += String(repeating: "=", count: (4 - padded.count % 4) % 4)
        return Data(base64Encoded: padded)
    }
}
