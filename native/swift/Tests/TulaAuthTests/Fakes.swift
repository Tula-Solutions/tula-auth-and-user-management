import CryptoKit
import Foundation
import XCTest

@testable import TulaAuth

// Stand-ins for what the system would show or keep: a device key store, the passkey sheet,
// the Sign in with Apple sheet and the browser session. No test shows a sheet, opens a
// browser or asks a Secure Enclave.

/// What a fake throws when it is told to fail. Its text is a canary: it must never reach an
/// error the client throws.
struct LoudFailure: Error, CustomStringConvertible, LocalizedError {
    static let text = "CANARY-framework-text"
    var description: String { LoudFailure.text }
    var errorDescription: String? { LoudFailure.text }
}

/// A device key whose signing can be made to fail.
struct ScriptedKey: TulaDeviceKey {
    let key = P256.Signing.PrivateKey()
    var failing = false
    var short = false

    var publicKey: TulaDevicePublicKey {
        // A P-256 public key's raw representation is always 64 bytes.
        TulaDevicePublicKey(rawRepresentation: key.publicKey.rawRepresentation)
            ?? { fatalError("a P-256 key has a 64-byte point") }()
    }

    func sign(_ message: Data) throws -> Data {
        if failing { throw LoudFailure() }
        let signature = try key.signature(for: message).rawRepresentation
        return short ? signature.prefix(10) : signature
    }
}

/// A device key store a test scripts: whether there is a key, and which looks fail.
actor FakeKeyStore: TulaDeviceKeyStore {
    private var key: ScriptedKey?
    /// The answers of the next looks: `true` fails that look. After them every look works.
    private var failures: [Bool] = []
    private var failCreate = false
    private(set) var looks = 0
    private(set) var made = 0

    init(key: ScriptedKey? = nil) {
        self.key = key
    }

    func script(looks failures: Bool...) { self.failures = failures }
    func failCreating() { failCreate = true }
    func lose() { key = nil }
    func put(_ next: ScriptedKey) { key = next }
    var current: ScriptedKey? { key }

    func existing() async throws -> (any TulaDeviceKey)? {
        looks += 1
        if !failures.isEmpty, failures.removeFirst() {
            throw LoudFailure()
        }
        return key
    }

    func create() async throws -> any TulaDeviceKey {
        if failCreate { throw LoudFailure() }
        made += 1
        let next = ScriptedKey()
        key = next
        return next
    }
}

/// A proof as the server would read it.
struct ReadProof {
    let header: [String: Any]
    let claims: [String: Any]
    let verified: Bool

    init?(_ request: URLRequest) {
        guard let text = request.value(forHTTPHeaderField: "DPoP") else { return nil }
        let parts = text.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard
            parts.count == 3,
            let head = DeviceProofs.bytes(base64url: parts[0]),
            let body = DeviceProofs.bytes(base64url: parts[1]),
            let signature = DeviceProofs.bytes(base64url: parts[2]),
            let header = try? JSONSerialization.jsonObject(with: head) as? [String: Any],
            let claims = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
        else { return nil }
        self.header = header
        self.claims = claims
        let jwk = header["jwk"] as? [String: String] ?? [:]
        let point = (DeviceProofs.bytes(base64url: jwk["x"] ?? "") ?? Data()) + (DeviceProofs.bytes(base64url: jwk["y"] ?? "") ?? Data())
        if let key = try? P256.Signing.PublicKey(rawRepresentation: point),
            let parsed = try? P256.Signing.ECDSASignature(rawRepresentation: signature)
        {
            verified = key.isValidSignature(parsed, for: Data("\(parts[0]).\(parts[1])".utf8))
        } else {
            verified = false
        }
    }

    var jwk: [String: String] { header["jwk"] as? [String: String] ?? [:] }
    var nonce: String? { claims["nonce"] as? String }
}

/// A passkey sheet that answers what a test tells it to.
final class FakeSheet: TulaPasskeySheet, @unchecked Sendable {
    typealias Outcome<T> = Result<T, Error>
    private let lock = NSLock()
    private var gets: [PasskeyRequestOptions] = []
    private var creates: [PasskeyCreationOptions] = []
    var assertion: Outcome<PasskeyAssertionCredential> = .success(FakeSheet.goodAssertion)
    var registration: Outcome<PasskeyRegistrationCredential> = .success(FakeSheet.goodRegistration)
    /// When set, a request waits here before it answers.
    var hold: Gate?

    static let goodAssertion = PasskeyAssertionCredential(
        id: "Y3JlZC0x", rawId: "Y3JlZC0x",
        response: PasskeyAssertionCredentialResponse(
            clientDataJSON: "Q0FOQVJZLWNsaWVudA", authenticatorData: "Q0FOQVJZLWF1dGg", signature: "Q0FOQVJZLXNpZw",
            userHandle: "dXNyXzE"))
    static let goodRegistration = PasskeyRegistrationCredential(
        id: "Y3JlZC0x", rawId: "Y3JlZC0x",
        response: PasskeyRegistrationCredentialResponse(
            clientDataJSON: "Q0FOQVJZLWNsaWVudA", attestationObject: "Q0FOQVJZLWF0dA", transports: ["internal"]))

    var asked: [PasskeyRequestOptions] { lock.withLock { gets } }
    var made: [PasskeyCreationOptions] { lock.withLock { creates } }

    func create(_ options: PasskeyCreationOptions) async throws -> PasskeyRegistrationCredential {
        lock.withLock { creates.append(options) }
        await hold?.wait()
        return try registration.get()
    }

    func get(_ options: PasskeyRequestOptions) async throws -> PasskeyAssertionCredential {
        lock.withLock { gets.append(options) }
        await hold?.wait()
        return try assertion.get()
    }
}

/// A Sign in with Apple sheet that answers what a test tells it to.
final class FakeApple: TulaAppleSheet, @unchecked Sendable {
    private let lock = NSLock()
    private var seen: [String] = []
    var answer: Result<TulaAppleCredential, Error> = .success(
        TulaAppleCredential(idToken: "CANARY-id-token", givenName: "Maya", familyName: "Okafor"))

    var nonces: [String] { lock.withLock { seen } }

    func authorize(hashedNonce: String) async throws -> TulaAppleCredential {
        lock.withLock { seen.append(hashedNonce) }
        return try answer.get()
    }
}

/// A browser session that returns what a test tells it to.
final class FakeBrowser: TulaBrowserSession, @unchecked Sendable {
    private let lock = NSLock()
    private var seen: [(url: String, redirect: String)] = []
    var answer: @Sendable (String, String) async throws -> String? = { _, _ in nil }

    var opened: [(url: String, redirect: String)] { lock.withLock { seen } }

    func open(url: String, redirectURL: String) async throws -> String? {
        lock.withLock { seen.append((url, redirectURL)) }
        return try await answer(url, redirectURL)
    }
}

extension Fixture {
    static let requestOptions =
        #"{"challenge":"Y2hhbGxlbmdl","timeout":300000,"rpId":"example.test","userVerification":"required"}"#
    static let creationOptions =
        #"{"rp":{"id":"example.test","name":"Example"},"user":{"id":"dXNyXzE","name":"maya@example.com","displayName":"Maya"},"challenge":"Y2hhbGxlbmdl","pubKeyCredParams":[{"type":"public-key","alg":-7}],"timeout":300000,"excludeCredentials":[],"authenticatorSelection":{"residentKey":"required","requireResidentKey":true,"userVerification":"required"},"attestation":"none"}"#
    static let passkey =
        #"{"id":"pk_1","name":"iPhone","synced":true,"createdAt":"2026-01-01T00:00:00.000Z","lastUsedAt":null}"#
    static let secondFactor = #"{"status":"needs_second_factor","options":["totp","backup_code","passkey"]}"#
    static let enrolment = #"{"status":"needs_factor_enrolment","methods":["totp"]}"#
}

/// Everything an error says when it is printed, logged or reflected.
func everythingOf(_ error: Error) -> String {
    var text = "\(error) \(String(describing: error)) \(String(reflecting: error)) \(error.localizedDescription)"
    dump(error, to: &text)
    return text
}
