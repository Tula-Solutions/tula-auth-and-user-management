import CryptoKit
import Foundation
import XCTest

@testable import TulaAuth

// What the journeys of passkeys, providers, device keys and the second step stand on: an
// authenticator app, a passkey authenticator and a browser, all in software. No journey
// shows a sheet, opens a browser or touches a Keychain or a Secure Enclave: the system's
// own adapters (`SystemPasskeySheet`, `SystemAppleSheet`, `SystemBrowserSession`,
// `KeychainDeviceKeyStore`) are not run by any test.

/// A switch a journey sets and a closure takes once.
final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var isSet = false

    func set() { lock.withLock { isSet = true } }

    /// Whether it was set; it is not afterwards.
    func take() -> Bool {
        lock.withLock {
            let was = isSet
            isSet = false
            return was
        }
    }
}

extension Exchange {
    /// The device proof the request carried.
    var proof: String? { headers["dpop"] }

    /// The error code of the answer.
    var code: String? {
        (try? JSONSerialization.jsonObject(with: Data(responseBody.utf8)) as? [String: Any])?["code"] as? String
    }

    /// The request's body, as JSON.
    var sent: [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(requestBody.utf8)) as? [String: Any]) ?? [:]
    }
}

extension Journey {
    static func base64url(_ data: Data) -> String { DeviceProofs.base64url(data) }

    /// The RFC 7638 thumbprint of a device key: what the server writes in `cnf.jkt`.
    static func thumbprint(_ key: TulaDevicePublicKey) -> String {
        let jwk = "{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"\(base64url(key.x))\",\"y\":\"\(base64url(key.y))\"}"
        return base64url(Data(SHA256.hash(data: Data(jwk.utf8))))
    }

    /// The authentication methods a token records, as a set.
    static func amr(_ token: String?) -> Set<String> {
        Set(claims(token)["amr"] as? [String] ?? [])
    }

    /// A backup code's shape.
    static func isBackupCode(_ code: String) -> Bool {
        let parts = code.split(separator: "-", omittingEmptySubsequences: false)
        return parts.count == 2
            && parts.allSatisfy { $0.count == 5 && $0.allSatisfy { $0.isLetter || $0.isNumber } }
    }

    /// A backup code that is none of `codes`.
    static func unknownBackupCode(_ codes: [String]) -> String {
        codes.contains("zzzzz-zzzzz") ? "yyyyy-yyyyy" : "zzzzz-zzzzz"
    }
}

/// An authenticator app: RFC 6238 with SHA-1, six digits and steps of thirty seconds.
enum Totp {
    static let step: TimeInterval = 30

    static func key(_ secret: String) -> Data {
        let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
        var bits = 0
        var value = 0
        var out = Data()
        for character in secret.uppercased() {
            guard let index = alphabet.firstIndex(of: character) else { continue }
            value = (value << 5) | index
            bits += 5
            if bits >= 8 {
                out.append(UInt8((value >> (bits - 8)) & 0xff))
                bits -= 8
            }
        }
        return out
    }

    static func code(_ secret: String, at time: Date, offset: Int = 0) -> String {
        var counter = UInt64(Int(time.timeIntervalSince1970 / step) + offset).bigEndian
        let message = Data(bytes: &counter, count: 8)
        let mac = Array(HMAC<Insecure.SHA1>.authenticationCode(for: message, using: SymmetricKey(data: key(secret))))
        let at = Int(mac[19] & 0x0f)
        let number =
            (UInt32(mac[at] & 0x7f) << 24) | (UInt32(mac[at + 1]) << 16) | (UInt32(mac[at + 2]) << 8)
            | UInt32(mac[at + 3])
        return String(format: "%06d", number % 1_000_000)
    }
}

/// A passkey authenticator in software: what packages/conformance/src/passkey.ts is to the
/// JS journeys. It makes real WebAuthn responses (a P-256 key, attestation `none`), which
/// the server verifies as it would a device's.
final class Authenticator: @unchecked Sendable {
    private struct Held {
        let id: String
        let rpId: String
        let userHandle: String
        let key: P256.Signing.PrivateKey
    }

    private let lock = NSLock()
    private var keys: [Held] = []

    /// Hold a credential nobody registered: a passkey of some other account or server.
    func holdStray(rpId: String) {
        let id = Journey.base64url(Data((0..<32).map { _ in UInt8.random(in: 0...255) }))
        lock.withLock { keys.append(Held(id: id, rpId: rpId, userHandle: "c3RyYW5nZXI", key: P256.Signing.PrivateKey())) }
    }

    private static func clientData(_ type: String, _ challenge: String, _ origin: String) throws -> Data {
        try JSONSerialization.data(
            withJSONObject: ["type": type, "challenge": challenge, "origin": origin, "crossOrigin": false],
            options: [.withoutEscapingSlashes])
    }

    private static func cborBytes(_ bytes: Data) -> Data {
        var head: [UInt8]
        if bytes.count < 24 {
            head = [0x40 + UInt8(bytes.count)]
        } else if bytes.count < 256 {
            head = [0x58, UInt8(bytes.count)]
        } else {
            head = [0x59, UInt8(bytes.count >> 8), UInt8(bytes.count & 0xff)]
        }
        return Data(head) + bytes
    }

    private static func cborText(_ text: String) -> Data {
        Data([0x60 + UInt8(text.utf8.count)]) + Data(text.utf8)
    }

    func create(_ options: PasskeyCreationOptions, origin: String) throws -> PasskeyRegistrationCredential {
        guard options.pubKeyCredParams.contains(where: { $0.alg == -7 }) else {
            throw JourneyFailure("the passkey options do not offer ES256")
        }
        let held = lock.withLock { keys.map(\.id) }
        if options.excludeCredentials.contains(where: { held.contains($0.id) }) {
            throw TulaSheetError.alreadyOnDevice
        }
        let key = P256.Signing.PrivateKey()
        let credentialId = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        let id = Journey.base64url(credentialId)
        lock.withLock { keys.append(Held(id: id, rpId: options.rp.id, userHandle: options.user.id, key: key)) }
        let point = key.publicKey.rawRepresentation
        let cose =
            Data([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21]) + Authenticator.cborBytes(point.prefix(32))
            + Data([0x22]) + Authenticator.cborBytes(point.suffix(32))
        // User present, user verified, attested credential data; a counter of zero.
        var authData = Data(SHA256.hash(data: Data(options.rp.id.utf8))) + Data([0x45, 0, 0, 0, 0])
        authData += Data(count: 16) + Data([UInt8(credentialId.count >> 8), UInt8(credentialId.count & 0xff)])
        authData += credentialId + cose
        let attestation =
            Data([0xa3]) + Authenticator.cborText("fmt") + Authenticator.cborText("none")
            + Authenticator.cborText("attStmt") + Data([0xa0]) + Authenticator.cborText("authData")
            + Authenticator.cborBytes(authData)
        return PasskeyRegistrationCredential(
            id: id, rawId: id,
            response: PasskeyRegistrationCredentialResponse(
                clientDataJSON: Journey.base64url(
                    try Authenticator.clientData("webauthn.create", options.challenge, origin)),
                attestationObject: Journey.base64url(attestation), transports: ["internal"]))
    }

    func get(_ options: PasskeyRequestOptions, origin: String) throws -> PasskeyAssertionCredential {
        let allowed = options.allowCredentials?.map(\.id)
        let found = lock.withLock {
            keys.reversed().first { held in
                allowed.map { $0.contains(held.id) } ?? (held.rpId == options.rpId)
            }
        }
        guard let found else {
            throw JourneyFailure("this authenticator holds no credential the options accept")
        }
        let client = try Authenticator.clientData("webauthn.get", options.challenge, origin)
        let authData = Data(SHA256.hash(data: Data(options.rpId.utf8))) + Data([0x05, 0, 0, 0, 0])
        let signature = try found.key.signature(for: authData + Data(SHA256.hash(data: client)))
        return PasskeyAssertionCredential(
            id: found.id, rawId: found.id,
            response: PasskeyAssertionCredentialResponse(
                clientDataJSON: Journey.base64url(client), authenticatorData: Journey.base64url(authData),
                signature: Journey.base64url(signature.derRepresentation), userHandle: found.userHandle))
    }
}

/// The passkey sheet of a journey's app: an authenticator behind it, the origin the platform
/// is taken to write in a response, and whether the user dismisses it.
final class SoftwareSheet: TulaPasskeySheet, @unchecked Sendable {
    private let lock = NSLock()
    private var authenticator: Authenticator
    private var origin: String
    private var dismisses = false
    private var shown = 0

    init(_ authenticator: Authenticator, origin: String) {
        self.authenticator = authenticator
        self.origin = origin
    }

    /// Put another authenticator behind the sheet, or change what the user does with it.
    func plugIn(_ next: Authenticator, origin: String? = nil, dismiss: Bool = false) {
        lock.withLock {
            authenticator = next
            self.origin = origin ?? self.origin
            dismisses = dismiss
        }
    }

    /// How often the sheet was put up.
    var times: Int { lock.withLock { shown } }

    private func asked() throws -> (Authenticator, String) {
        try lock.withLock {
            shown += 1
            if dismisses { throw TulaSheetError.dismissed }
            return (authenticator, origin)
        }
    }

    func create(_ options: PasskeyCreationOptions) async throws -> PasskeyRegistrationCredential {
        let (authenticator, origin) = try asked()
        return try authenticator.create(options, origin: origin)
    }

    func get(_ options: PasskeyRequestOptions) async throws -> PasskeyAssertionCredential {
        let (authenticator, origin) = try asked()
        return try authenticator.get(options, origin: origin)
    }
}

/// The Sign in with Apple sheet of a journey's app: the journey is Apple.
final class ScriptedApple: TulaAppleSheet, @unchecked Sendable {
    typealias Script = @Sendable (_ hashedNonce: String) async throws -> TulaAppleCredential
    private let script: Script

    init(_ script: @escaping Script) { self.script = script }

    func authorize(hashedNonce: String) async throws -> TulaAppleCredential {
        try await script(hashedNonce)
    }
}

/// The browser session of a journey's app: the journey is the user at the provider.
final class ScriptedBrowser: TulaBrowserSession, @unchecked Sendable {
    typealias Script = @Sendable (_ url: String, _ redirectURL: String) async throws -> String?
    private let lock = NSLock()
    private var script: Script
    private var seen: [[String]] = []

    init(_ script: @escaping Script = { _, _ in nil }) { self.script = script }

    func browse(_ next: @escaping Script) { lock.withLock { script = next } }

    /// Every address the browser was opened at, with the redirect URL it waited for.
    var opened: [[String]] { lock.withLock { seen } }

    func open(url: String, redirectURL: String) async throws -> String? {
        let script = lock.withLock {
            seen.append([url, redirectURL])
            return self.script
        }
        return try await script(url, redirectURL)
    }
}

/// A browser that follows no redirect: a journey reads where each answer points.
private final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? {
        nil
    }
}

extension Server {
    static let loopbackRedirect = "http://localhost:5173/oauth/callback"
    static let schemeRedirect = "com.example.journeys:/oauth/callback"
    static let appLink = "https://app.example.com/oauth/callback"
    static let relyingParty = "localhost"
    /// The origin the platform is taken to write in an iOS app's passkey response.
    static let iosOrigin = "https://localhost"

    /// The time the server's clock shows.
    func serverNow() async throws -> Date {
        let answer = try await control("GET", "now") as? [String: Any]
        return Date(timeIntervalSince1970: (answer?["now"] as? Double ?? 0) / 1000)
    }

    /// The deployment tier: outside `local` a loopback page is no redirect URL by itself.
    func tier(_ tier: String) async throws {
        _ = try await control("POST", "tier", body: ["tier": tier])
    }

    /// What the user's authenticator app shows now.
    func totp(_ secret: String) async throws -> String {
        Totp.code(secret, at: try await serverNow())
    }

    /// A code the authenticator app does not show now, nor a step either side.
    func wrongTotp(_ secret: String) async throws -> String {
        let now = try await serverNow()
        let near = Set((-2...2).map { Totp.code(secret, at: now, offset: $0) })
        return ["000000", "111111", "222222", "333333", "444444", "555555"].first { !near.contains($0) } ?? "999999"
    }

    /// Save a provider's credentials, as an operator does.
    func provider(_ name: String, _ more: [String: Any] = [:]) async throws {
        var body: [String: Any] = ["clientId": "journey-\(name)-client", "clientSecret": "journey-\(name)-secret"]
        body.merge(more) { _, new in new }
        let saved = try await admin("PUT", "/v1/admin/oauth-providers/\(name)", body)
        XCTAssertEqual(saved.status, 200, "saving the provider \(name)")
    }

    /// Be the user at the mock provider's consent page: answer it, and follow the provider
    /// back to the API's callback. Returns where the API sends the browser then.
    func atProvider(_ authorizationURL: String, _ consent: [String: String]) async throws -> String {
        guard var components = URLComponents(string: authorizationURL) else {
            throw JourneyFailure("the authorization URL is not a URL")
        }
        XCTAssertTrue(components.path.hasSuffix("/v1/dev/oauth/authorize"))
        // The mock provider's page is at the origin of the API's address, and the fixture
        // serves each API under a path of its one port: the browser is sent to this API's.
        if components.path.hasPrefix("/v1/"), let world = URLComponents(string: baseURL)?.path {
            components.path = world + components.path
        }
        guard let page = components.url else {
            throw JourneyFailure("the authorization URL is not a URL")
        }
        var fields: [String: String] = [:]
        for item in components.queryItems ?? [] {
            fields[item.name] = item.value ?? ""
        }
        fields.merge(consent) { _, new in new }
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        let form = fields.map { key, value in
            "\(key.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")=\(value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")"
        }.joined(separator: "&")
        var post = URLRequest(url: page)
        post.httpMethod = "POST"
        post.httpBody = Data(form.utf8)
        post.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "content-type")
        let browser = URLSession(configuration: .ephemeral)
        let (said, consented) = try await browser.data(for: post, delegate: NoRedirects())
        let first = consented as? HTTPURLResponse
        XCTAssertEqual(first?.statusCode, 302, "\(authorizationURL) \(String(decoding: said, as: UTF8.self))")
        guard let back = first?.value(forHTTPHeaderField: "location"), let callback = URL(string: back) else {
            throw JourneyFailure("the provider did not send the browser back")
        }
        let (_, answered) = try await browser.data(for: URLRequest(url: callback), delegate: NoRedirects())
        let second = answered as? HTTPURLResponse
        XCTAssertEqual(second?.statusCode, 303)
        XCTAssertNil(second?.value(forHTTPHeaderField: "set-cookie"))
        return second?.value(forHTTPHeaderField: "location") ?? ""
    }

    /// An ID token of the mock provider, as Google's SDK or Apple's sheet hands an app one.
    func idToken(_ provider: String, _ claims: [String: Any], expired: Bool = false) async throws -> String {
        let answer = try await control(
            "POST", "id-token", body: ["provider": provider, "claims": claims, "expired": expired])
        return try unwrap((answer as? [String: Any])?["token"] as? String)
    }

    /// Register an iOS app as the operator's; returns its id.
    @discardableResult
    func registerIosApp(_ bundleId: String = "com.example.journeys", teamId: String = "ABCDE12345") async throws
        -> String
    {
        let made = try await admin(
            "POST", "/v1/admin/native-apps", ["platform": "ios", "teamId": teamId, "bundleId": bundleId])
        XCTAssertEqual(made.status, 201)
        return try unwrap(made.object["id"] as? String)
    }

    /// Passkeys on, with a relying party; `allowRelyingParty` lists its own origin as a
    /// page's, which is what lets an iOS app's response through.
    func passkeysOn(allowRelyingParty: Bool = true, _ more: [String: Any] = [:]) async throws {
        var sections: [String: Any] = [
            "signIn": ["methods": ["passkey": ["enabled": true]]],
            "urls": [
                "allowedOrigins": ["http://localhost:5173"] + (allowRelyingParty ? [Server.iosOrigin] : []),
                "allowedRedirectUrls": [String](),
            ],
            "passkeys": ["rpId": Server.relyingParty],
        ]
        sections.merge(more) { _, new in new }
        try await settings(sections)
    }

    /// Create a user as an operator does; returns its id.
    func adminUser(_ email: String, verified: Bool) async throws -> String {
        var body: [String: Any] = ["email": email, "password": Journey.password]
        if verified { body["emailVerified"] = true }
        let made = try await admin("POST", "/v1/admin/users", body)
        XCTAssertEqual(made.status, 201)
        return try unwrap(made.object["id"] as? String)
    }
}

extension Server {
    /// A user who signed up and enrolled an authenticator app: the app, the address, the
    /// app's secret and the backup codes.
    func enrolled() async throws -> (app: App, email: String, secret: String, codes: [String]) {
        let (app, email) = try await signUp()
        let secret = try await app.tula.factors.startTotp().secret
        let codes = try await app.tula.factors.confirmTotp(code: try await totp(secret))
        // The next sign-in's code is of another time step: a code is accepted once.
        try await advance(Totp.step)
        return (app, email, secret, codes)
    }

    /// Sign in with the password on a new client, as far as the second factor.
    func atSecondFactor(
        _ email: String, password: String = Journey.password, options: [SecondFactorMethod] = [.totp, .backupCode],
        passkeys: (any TulaPasskeySheet)? = nil, file: StaticString = #filePath, line: UInt = #line
    ) async throws -> (app: App, flow: SignInFlow) {
        let app = try client(passkeys: passkeys)
        let flow = try await app.tula.startSignIn(identifier: email)
        let step = try await flow.submitPassword(password)
        guard case .needsSecondFactor(let asked) = step else {
            XCTFail("the sign-in is at \(step.status), not at the second factor", file: file, line: line)
            throw JourneyFailure("not at the second factor")
        }
        XCTAssertEqual(asked.options, options, file: file, line: line)
        let state = await app.state()
        XCTAssertFalse(state.isSignedIn, file: file, line: line)
        return (app, flow)
    }

    /// One provider round trip of a new app (or of `app`): the journey is the user at the
    /// mock provider's consent page. The app's browser is this journey's script.
    func continueWith(
        _ provider: OAuthProvider = .google, _ consent: [String: String],
        redirectURL: String = Server.loopbackRedirect
    ) async throws -> (outcome: ProviderOutcome, app: App, browser: ScriptedBrowser) {
        let browser = ScriptedBrowser { url, _ in try await self.atProvider(url, consent) }
        let app = try client(browser: browser)
        let outcome = try await app.tula.signIn(with: provider, redirectURL: redirectURL)
        return (outcome, app, browser)
    }
}

extension App {
    /// The user the client is signed in as.
    func user() async -> CurrentUser? { await tula.session.state.user }

    /// The methods the session has proven, from its access token.
    func amr() async throws -> Set<String> {
        Journey.amr(try await tula.session.getToken())
    }
}

extension ProviderOutcome {
    /// The outcome's name, with the code or the reason of a refusal.
    var word: String {
        switch self {
        case .signedIn: return "signed_in"
        case .needsStep: return "needs_step"
        case .linked: return "linked"
        case .cancelled: return "cancelled"
        case .refused(.unexpectedReturn): return "unexpected_return"
        case .refused(.noAnswer): return "no_answer"
        case .refused(.notStartedHere): return "not_started_here"
        case .refused(.error(let code)): return code
        }
    }

    var flow: SignInFlow? {
        switch self {
        case .signedIn(let flow), .needsStep(let flow): return flow
        default: return nil
        }
    }
}
