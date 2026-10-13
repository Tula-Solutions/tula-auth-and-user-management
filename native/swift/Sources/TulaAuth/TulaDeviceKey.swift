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
    ///
    /// **It may be called while an earlier call is still out.** The client asks one thing at
    /// a time, but a removal drops the calls from before it without stopping them, so a
    /// `create()` (or an `existing()`) from before a removal can still be running when the
    /// next one starts. A store must tolerate two at once and end with one key, as
    /// `KeychainDeviceKeyStore` does by returning the stored key when its add finds one
    /// already there.
    func create() async throws -> any TulaDeviceKey
    /// Remove what is kept of the key; nothing there is not an error.
    ///
    /// The client calls it in one case: at a sign-out, when `existing()` threw
    /// `TulaDeviceKeyStoreError.unusable`, the store's own word for a key that will never be
    /// had again. For every other failure (a locked device, a cancellation, a deadline, an
    /// error the client does not know) it is **not** called: the failure may pass, and two
    /// clients that share one store share its key, so that removing it would end the other
    /// client's bound session. An app that knows better than the store (it has seen every
    /// start fail with `device.key_failed` since a restore, say) removes the key itself,
    /// after a sign-out, **through `TulaClient.removeDeviceKey()`**, which calls this; the
    /// next sign-in then makes a new key. Called on the store directly, the client is not
    /// told: a look of its own that is still out can then hand a later start the key that
    /// was removed.
    func remove() async throws
}

/// What a device key store throws from `existing()` for a key it **knows** will never be
/// handed out again.
///
/// It is the one failure the client acts on by itself: at a sign-out it removes what such a
/// store keeps (`TulaDeviceKeyStore.remove`). Every other error is "could not tell", and
/// leaves the store alone. A store throws it only for what cannot pass: never for a locked
/// device, an interaction that was not allowed, a cancellation, a deadline or an answer it
/// does not know. `KeychainDeviceKeyStore` throws it for nothing (its doc comment says why).
public enum TulaDeviceKeyStoreError: Error, Hashable, Sendable {
    /// What the store keeps can never be a key again.
    case unusable
}

/// A P-256 key in the process's memory.
struct SoftwareDeviceKey: TulaDeviceKey, TulaRedacted {
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
public actor SoftwareDeviceKeyStore: TulaDeviceKeyStore, TulaRedacted {
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
            throw DeviceKeyStoreError.notAKey
        }
        key = made
        return made
    }

    /// Lose the key, as a device that was erased has: for a test of what the client then does.
    public func forget() { key = nil }

    /// Remove the key; the same as `forget()`.
    public func remove() { key = nil }
}

/// Why a device key store could not hand out a key. It carries nothing of the key, and the
/// client keeps nothing of it: every failure is the one `device.key_failed`.
enum DeviceKeyStoreError: Error {
    /// The platform has no hardware key store here (a simulator, a Mac without one).
    case unavailable
    /// What was made or opened is not a P-256 key.
    case notAKey
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
            throw DeviceKeyStoreError.notAKey
        }
        return key
    }
}

#if canImport(Security)

/// A key of the device's Secure Enclave.
struct EnclaveDeviceKey: TulaDeviceKey, TulaRedacted {
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
            throw DeviceKeyStoreError.notAKey
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
///
/// **Some of those failures never pass, and this store cannot tell which.** A blob the
/// enclave no longer opens (a device restored from a backup, an enclave that was reset)
/// fails every time: every refresh of the session bound to it, and every start after it, is
/// `device.key_failed`. Neither the Keychain's statuses nor CryptoKit's errors are documented
/// to say "never again" (a locked device, an interaction that is not allowed and a blob from
/// another enclave are not told apart by anything Apple writes down), so this store throws
/// `TulaDeviceKeyStoreError.unusable` for **nothing**, and the client removes nothing of its
/// own accord. The way out is the app's: `signOut()`, which needs no proof, and then
/// `TulaClient.removeDeviceKey()`, after which the next sign-in makes a new key.
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
    /// at its next refresh. Nothing there is not an error. The client never calls this for
    /// this store by itself (`TulaDeviceKeyStore.remove`): an app does, for a key that never
    /// opens, through `TulaClient.removeDeviceKey()`.
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
final class DeviceProofs: @unchecked Sendable, TulaRedacted {
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
    private let looking = Shared<(any TulaDeviceKey)?>()
    private let making = Shared<any TulaDeviceKey>()

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
            if let key = try await existing() {
                return key
            }
            return use == .start ? try await create() : nil
        } catch {
            throw TulaError.client(TulaClientErrorCode.deviceKeyFailed)
        }
    }

    /// The store's look, **one at a time**: whoever asks while a look is out joins it. A
    /// caller's deadline ends its own wait and starts nothing, so a store that never answers
    /// is asked once, not once more for every refresh that gives up. The cost is stated: a
    /// look that never returns is the only look this client makes until the key is removed
    /// through the client (`remove(within:)`), and every call that needs the key ends at its
    /// deadline meanwhile.
    private func existing() async throws -> (any TulaDeviceKey)? {
        let store = self.store
        return try await looking.value { try await store.existing() }
    }

    /// The store's making of a key, one at a time as the look is. A making that answers
    /// after its caller gave up still made a key, with nothing sent: the next start finds it.
    private func create() async throws -> any TulaDeviceKey {
        let store = self.store
        return try await making.value { try await store.create() }
    }

    /// How many callers wait for the look that is out. For the tests, which have no other
    /// way to know that a caller has joined a look before they let the store answer.
    var lookWaiters: Int { looking.waiting }

    /// The key was removed: what a look or a making still out answers is used by nobody.
    private func forgetFlights() {
        looking.drop()
        making.drop()
    }

    /// A call that was still out when the key was removed. Never leaves `DeviceProofs`.
    private struct Dropped: Error {}

    /// One call at a time, shared by everyone who asks while it is out.
    ///
    /// **A waiter ends when its own task is cancelled, and the call goes on for the others**
    /// (a deadline cancels the task that waits: `ApiTransport.within`), so a call that never
    /// returns holds no task of a caller that gave up. **`drop()` ends every waiter with an
    /// error and lets the call's answer fall**: the next caller starts a new call.
    private final class Shared<Value: Sendable>: @unchecked Sendable, TulaRedacted {
        private let lock = NSLock()
        private var running = false
        /// Which call the waiters wait for; a call of an older generation answers nobody.
        private var generation = 0
        private var waiters: [Int: CheckedContinuation<Value, any Error>] = [:]
        private var lastWaiter = 0

        func value(_ work: @escaping @Sendable () async throws -> Value) async throws -> Value {
            let id = lock.withLock { () -> Int in
                lastWaiter += 1
                return lastWaiter
            }
            return try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { (waiter: CheckedContinuation<Value, any Error>) in
                    let starts: Int? = lock.withLock {
                        waiters[id] = waiter
                        guard !running else {
                            return nil
                        }
                        running = true
                        return generation
                    }
                    if let starts {
                        // Not a child of the caller: it outlives a caller that gave up, for
                        // the callers that joined it.
                        Task {
                            do {
                                self.finish(starts, .success(try await work()))
                            } catch {
                                self.finish(starts, .failure(error))
                            }
                        }
                    }
                    // A cancellation that came before the waiter was kept found nothing to end.
                    if Task.isCancelled {
                        abandon(id)
                    }
                }
            } onCancel: {
                abandon(id)
            }
        }

        /// End every waiter with an error; the call still out answers nobody.
        func drop() {
            let ended: [CheckedContinuation<Value, any Error>] = lock.withLock {
                generation += 1
                running = false
                defer { waiters = [:] }
                return Array(waiters.values)
            }
            for waiter in ended {
                waiter.resume(throwing: Dropped())
            }
        }

        /// How many callers wait for the call that is out.
        var waiting: Int { lock.withLock { waiters.count } }

        private func abandon(_ id: Int) {
            let waiter = lock.withLock { waiters.removeValue(forKey: id) }
            waiter?.resume(throwing: CancellationError())
        }

        private func finish(_ started: Int, _ result: Result<Value, any Error>) {
            let answered: [CheckedContinuation<Value, any Error>] = lock.withLock {
                guard generation == started else {
                    return []
                }
                running = false
                defer { waiters = [:] }
                return Array(waiters.values)
            }
            for waiter in answered {
                waiter.resume(with: result)
            }
        }
    }

    /// What the store says of the key after the server refused a proof.
    enum Verdict: Sendable {
        /// The store has the key: the refusal was about the proof.
        case there
        /// The store said twice that there is no key: the session cannot be refreshed again.
        case gone
        /// The store could not say whether there is a key.
        case unsure
        /// The store said "no key" once and then something else. It is not to be believed
        /// either way: the session is kept and the call is `device.key_failed`.
        case contradicted
    }

    /// Ask the store whether the key is gone, **twice**: ending a session cannot be undone,
    /// and one "no such item" is not enough to do it on (a Keychain can answer that for a
    /// moment). Only two looks that both say "no key" are `gone`. This narrows the case and
    /// does not close it: a store that is wrong twice in a row still ends the session.
    ///
    /// Each look has half of `seconds`; a look that does not answer in time could not tell.
    func verdict(within seconds: TimeInterval) async -> Verdict {
        switch await look(within: seconds / 2) {
        case .found: return .there
        case .unknown: return .unsure
        case .none: break
        }
        switch await look(within: seconds / 2) {
        case .none: return .gone
        case .found, .unknown: return .contradicted
        }
    }

    private enum Look { case found, none, unknown }

    private func look(within seconds: TimeInterval) async -> Look {
        do {
            return try await ApiTransport.within(seconds) { [self] in try await existing() } == nil ? .none : .found
        } catch {
            return .unknown
        }
    }

    /// Remove what the store keeps of the key, inside `seconds`, and forget a look or a
    /// making that is still out: its answer would be the key that was just removed, and a
    /// start that took it would bind a session to a key the store no longer holds.
    ///
    /// Who joined such a call **before** the removal is ended with `device.key_failed`, at
    /// once; who asks **after** it starts a new look.
    ///
    /// **A removal the store refused forgets nothing; one whose outcome is not known forgets
    /// as one that succeeded does.** The store did not answer in time, or the caller's task
    /// was cancelled: the store's call is not stopped by either and may remove the key
    /// afterwards, so the looks from before it are dropped all the same. Dropping for a
    /// removal that then did not happen costs one more look.
    ///
    /// - Throws: `network.timeout` when the store did not answer in time, and
    ///   `device.key_failed` when it refused or when the caller's task was cancelled: the
    ///   client has no code of its own for a cancelled call, and a cancelled look for the key
    ///   ends the same way. What the store threw is dropped.
    func remove(within seconds: TimeInterval) async throws {
        let store = self.store
        do {
            try await ApiTransport.within(seconds) { try await store.remove() }
        } catch let error as TulaError where error.code == TulaClientErrorCode.networkTimeout {
            forgetFlights()
            throw error
        } catch {
            if Task.isCancelled {
                forgetFlights()
            }
            throw TulaError.client(TulaClientErrorCode.deviceKeyFailed)
        }
        forgetFlights()
    }

    /// At a sign-out: when the store says its key will **never** be had again
    /// (`TulaDeviceKeyStoreError.unusable`, the store's own word), remove what it keeps, so
    /// that the next sign-in makes a new key instead of failing on the old one for ever.
    ///
    /// Everything else leaves the store alone: a key that can be had, a store that does not
    /// answer in time, and every other failure (a locked device, a cancellation, an error
    /// this client does not know). Such a failure may pass, and the store may be shared with
    /// another client whose session is bound to the key. Best effort: a removal that fails
    /// is left at that, and the next sign-out tries again.
    ///
    /// **A sign-out that is cancelled while the store is being asked removes nothing**, also
    /// when the store then says "never again": the wait ends with the cancellation and
    /// nobody is left to act on the answer. Cancelled once the removal was asked for, the
    /// removal is the store's to finish or not.
    func dropUnusableKey(within seconds: TimeInterval) async {
        do {
            _ = try await ApiTransport.within(seconds) { [self] in try await existing() }
        } catch TulaDeviceKeyStoreError.unusable {
            try? await remove(within: seconds)
        } catch {
            return
        }
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
                throw DeviceKeyStoreError.notAKey
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
