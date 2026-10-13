import CryptoKit
import Foundation

/// How something the system showed the user ended: it gave an answer, or the user put it
/// away.
///
/// **A dismissed sheet is not an error and not a success.** Nothing was sent to prove
/// anything, nobody is signed in, and the same call works again: an app goes back to where
/// it was and says nothing, or says so in a neutral tone.
public enum TulaCeremony<Value: Sendable>: Sendable, TulaRedacted {
    /// The sheet answered and the server accepted what it returned.
    case finished(Value)
    /// The user closed the sheet, or it never answered (the client stops waiting after
    /// five minutes, the lifetime of a challenge).
    case dismissed

    /// The value of a ceremony that finished; `nil` for one that was dismissed.
    public var value: Value? {
        if case .finished(let value) = self { return value }
        return nil
    }

    /// Which of the two it is, and nothing of the value.
    public var description: String {
        switch self {
        case .finished: return "TulaCeremony.finished"
        case .dismissed: return "TulaCeremony.dismissed"
        }
    }
}

/// What a sheet reports instead of an answer. A sheet throws one of these four words and
/// nothing else: the client drops everything else an adapter throws (a framework's own
/// error text is the platform's, and an app logs what it catches).
public enum TulaSheetError: Error, Hashable, Sendable {
    /// The user closed the sheet. Not a failure: the call returns `dismissed`.
    case dismissed
    /// A passkey of this account is already on this device (a registration only).
    case alreadyOnDevice
    /// This device or this version of the system cannot show the sheet.
    case unsupported
    /// Anything else.
    case failed
}

/// The system's passkey sheet: what makes a passkey and what signs in with one.
///
/// The options and the credentials are WebAuthn's JSON forms, exactly as the API sends and
/// takes them (every binary value is base64url text). An app passes `SystemPasskeySheet`;
/// a test passes a fake, and no test of this repository shows a sheet.
public protocol TulaPasskeySheet: Sendable {
    /// Make a passkey for the signed-in user.
    ///
    /// - Throws: `TulaSheetError`.
    func create(_ options: PasskeyCreationOptions) async throws -> PasskeyRegistrationCredential
    /// Ask for one of the user's passkeys.
    ///
    /// - Throws: `TulaSheetError`.
    func get(_ options: PasskeyRequestOptions) async throws -> PasskeyAssertionCredential
}

/// What the Sign in with Apple sheet returned.
///
/// It prints as its type's name: the token signs a user in.
public struct TulaAppleCredential: Sendable, TulaRedacted {
    /// Apple's identity token (a JWT), as text. The client sends it once and keeps it nowhere.
    public let idToken: String
    /// The given name the sheet handed the app. Apple hands it over on the first
    /// authorization only, and never in the token.
    public let givenName: String?
    /// The family name, likewise.
    public let familyName: String?

    /// - Parameters:
    ///   - idToken: The identity token.
    ///   - givenName: The given name, when the sheet gave one.
    ///   - familyName: The family name, when the sheet gave one.
    public init(idToken: String, givenName: String? = nil, familyName: String? = nil) {
        self.idToken = idToken
        self.givenName = givenName
        self.familyName = familyName
    }
}

/// The Sign in with Apple sheet. An app passes `SystemAppleSheet`; a test passes a fake.
public protocol TulaAppleSheet: Sendable {
    /// Ask Apple for an identity token.
    ///
    /// - Parameter hashedNonce: What goes into the request's `nonce`: the lowercase
    ///   hexadecimal SHA-256 of the server's nonce, which the client has already taken.
    /// - Throws: `TulaSheetError`.
    func authorize(hashedNonce: String) async throws -> TulaAppleCredential
}

/// The system's browser session for a provider sign-in (`ASWebAuthenticationSession`). An
/// app passes `SystemBrowserSession`; a test passes a fake, and no test opens a browser.
public protocol TulaBrowserSession: Sendable {
    /// Open `url` and wait until the browser is sent to `redirectURL` or is closed.
    ///
    /// - Parameters:
    ///   - url: The provider's authorization page, as the API wrote it.
    ///   - redirectURL: Where the API sends the browser back to: a custom scheme of the app
    ///     or an app link.
    /// - Returns: The whole address the browser was sent to, or `nil` when the user closed
    ///   it. The client reads it only when it is `redirectURL` exactly, followed by `#`.
    /// - Throws: `TulaSheetError` when the session could not be shown.
    func open(url: String, redirectURL: String) async throws -> String?
}

/// One system sheet at a time, for a whole client.
///
/// A second ceremony while one is out is refused with `flow.busy` before any request: it is
/// never joined (its answer would be for another challenge) and never queued.
final class CeremonyGate: @unchecked Sendable {
    /// How long the client waits for a sheet: the lifetime of a WebAuthn challenge. After it
    /// the ceremony is over (`dismissed`) and a late answer is dropped, never used.
    static let sheetCeiling: TimeInterval = 300

    private let lock = NSLock()
    private var taken = false
    private let ceiling: TimeInterval

    init(ceiling: TimeInterval = CeremonyGate.sheetCeiling) {
        self.ceiling = ceiling
    }

    /// Run one ceremony, from before its first request until its last answer.
    ///
    /// - Throws: `flow.busy` when another is under way, before `body` runs.
    func ceremony<T: Sendable>(_ body: @Sendable () async throws -> T) async throws -> T {
        let free = lock.withLock {
            if taken {
                return false
            }
            taken = true
            return true
        }
        guard free else {
            throw TulaError.client(TulaClientErrorCode.flowBusy)
        }
        defer { lock.withLock { taken = false } }
        return try await body()
    }

    /// What a sheet's failure is called. Passkeys and providers have their own codes.
    enum Kind {
        case passkey
        case provider

        func code(_ error: TulaSheetError) -> String {
            switch (self, error) {
            case (.passkey, .alreadyOnDevice): return TulaClientErrorCode.passkeyAlreadyOnDevice
            case (.passkey, .unsupported): return TulaClientErrorCode.passkeyUnsupported
            case (.passkey, _): return TulaClientErrorCode.passkeyFailed
            case (.provider, .unsupported): return TulaClientErrorCode.providerUnsupported
            case (.provider, _): return TulaClientErrorCode.providerFailed
            }
        }
    }

    /// Wait for a sheet, at most the ceiling.
    ///
    /// - Returns: `nil` when the user dismissed it or it did not answer in time.
    /// - Throws: `TulaError` with one of the client's codes and nothing of what the sheet
    ///   threw.
    func sheet<T: Sendable>(_ kind: Kind, _ show: @escaping @Sendable () async throws -> T) async throws -> T? {
        do {
            return try await CeremonyGate.first(within: ceiling, show)
        } catch TulaSheetError.dismissed {
            return nil
        } catch let known as TulaSheetError {
            throw TulaError.client(kind.code(known))
        } catch {
            throw TulaError.client(kind.code(.failed))
        }
    }

    /// The answer of `work`, or `nil` when `ceiling` passed first. Whatever comes second is
    /// dropped. A caller whose task is cancelled cancels `work`.
    static func first<T: Sendable>(
        within ceiling: TimeInterval, _ work: @escaping @Sendable () async throws -> T
    ) async throws -> T? {
        let race = First<T>()
        let job = Task {
            do {
                race.finish(.success(try await work()))
            } catch {
                race.finish(.failure(error))
            }
        }
        let timer = Task {
            do {
                try await Task.sleep(nanoseconds: UInt64(max(0, ceiling) * 1_000_000_000))
            } catch {
                return
            }
            race.finish(.success(nil))
        }
        defer {
            job.cancel()
            timer.cancel()
        }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { race.wait($0) }
        } onCancel: {
            job.cancel()
        }
    }

    private final class First<T: Sendable>: @unchecked Sendable, TulaRedacted {
        private let lock = NSLock()
        private var outcome: Result<T?, Error>?
        private var waiter: CheckedContinuation<T?, Error>?

        func finish(_ result: Result<T?, Error>) {
            let resumed: CheckedContinuation<T?, Error>? = lock.withLock {
                guard outcome == nil else {
                    return nil
                }
                outcome = result
                defer { waiter = nil }
                return waiter
            }
            resumed?.resume(with: result)
        }

        func wait(_ continuation: CheckedContinuation<T?, Error>) {
            let known: Result<T?, Error>? = lock.withLock {
                if outcome == nil {
                    waiter = continuation
                }
                return outcome
            }
            if let known {
                continuation.resume(with: known)
            }
        }
    }
}

/// The checks of what a passkey sheet returned and of what the API answered, before either
/// is used: a 200 is not proof of talking to the API, and a sheet is an adapter somebody
/// wrote. Nothing here keeps what it checks.
enum PasskeyChecks {
    static func isBase64URL(_ text: String) -> Bool {
        DeviceProofs.bytes(base64url: text) != nil
    }

    static func usable(_ options: PasskeyRequestOptions) -> Bool {
        isBase64URL(options.challenge) && !options.rpId.isEmpty
    }

    static func usable(_ options: PasskeyCreationOptions) -> Bool {
        isBase64URL(options.challenge) && !options.rp.id.isEmpty && isBase64URL(options.user.id)
    }

    static func usable(_ credential: PasskeyAssertionCredential) -> Bool {
        isBase64URL(credential.id) && credential.type == "public-key"
            && isBase64URL(credential.response.clientDataJSON)
            && isBase64URL(credential.response.authenticatorData)
            && isBase64URL(credential.response.signature)
    }

    static func usable(_ credential: PasskeyRegistrationCredential) -> Bool {
        isBase64URL(credential.id) && credential.type == "public-key"
            && isBase64URL(credential.response.clientDataJSON)
            && isBase64URL(credential.response.attestationObject)
    }
}

/// What every part of a client shares: the transport, the session, the one gate of its
/// system sheets and the sheets it was given.
struct FlowContext: Sendable, TulaRedacted {
    let transport: ApiTransport
    let session: TulaSession
    var gate = CeremonyGate()
    var passkeys: (any TulaPasskeySheet)?
    var apple: (any TulaAppleSheet)?
    var browser: (any TulaBrowserSession)?
    var clock: any TulaClock = SystemClock()
    var roundTrip = ProviderRoundTrip()

    /// Ask the passkey sheet for an assertion and check it.
    ///
    /// - Returns: `nil` when the sheet was dismissed.
    /// - Throws: `passkey.unsupported` without a sheet, `response.invalid` for options that
    ///   are not options, `passkey.failed` for an answer that is not a credential.
    func assertion(_ options: PasskeyRequestOptions) async throws -> PasskeyAssertionCredential? {
        guard let sheet = passkeys else {
            throw TulaError.client(TulaClientErrorCode.passkeyUnsupported)
        }
        guard PasskeyChecks.usable(options) else {
            throw TulaError.client(TulaClientErrorCode.responseInvalid)
        }
        guard let credential = try await gate.sheet(.passkey, { try await sheet.get(options) }) else {
            return nil
        }
        guard PasskeyChecks.usable(credential) else {
            throw TulaError.client(TulaClientErrorCode.passkeyFailed)
        }
        return credential
    }

    /// The sheet, or `passkey.unsupported`: asked before any request of a passkey ceremony.
    func requirePasskeys() throws {
        guard passkeys != nil else {
            throw TulaError.client(TulaClientErrorCode.passkeyUnsupported)
        }
    }
}

/// The lowercase hexadecimal SHA-256 of a text: what Apple's sheet is given as the nonce
/// (ADR 0047), so that the token's `nonce` is the one spelling the server accepts.
func sha256Hex(_ text: String) -> String {
    SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
}
