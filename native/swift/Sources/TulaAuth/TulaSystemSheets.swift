import Foundation

// The system's own sheets, behind the client's three protocols: the passkey sheet, the
// Sign in with Apple sheet and the browser session (AuthenticationServices).
//
// **None of the three has been shown by anybody**: no test of this repository puts a sheet or
// a browser up, and nothing here was tried on a device or a simulator
// (docs/plans/phase-2-unverified.md). What can be decided without the framework is in
// `SystemSheetWire`. The tests build the framework's requests and read them, and stand in
// for the one step that shows something (`AuthorizationRun.Perform`, `SheetRun`,
// `SystemBrowserSession.Launch`); what the system answers with on success cannot be made by
// a test, so those lines are run by nobody.

/// What the system sheets decide without the framework: how an error is called, how raw
/// bytes become the API's JSON forms, and how a redirect URL is listened for.
enum SystemSheetWire {
    /// The domain and the codes of the framework's errors that the client tells apart.
    /// Written as numbers so that a code newer than the deployment target needs no
    /// availability check: 1001 is `ASAuthorizationError.canceled`, 1006 is
    /// `.matchedExcludedCredential`.
    static let authorizationDomain = "com.apple.AuthenticationServices.AuthorizationError"
    static let browserDomain = "com.apple.AuthenticationServices.WebAuthenticationSession"

    /// The word for what a sheet failed with. Only the domain and the code are read: the
    /// error's own text is never kept.
    static func word(for error: Error) -> TulaSheetError {
        let failure = error as NSError
        switch (failure.domain, failure.code) {
        case (authorizationDomain, 1001), (browserDomain, 1): return .dismissed
        case (authorizationDomain, 1006): return .alreadyOnDevice
        default: return .failed
        }
    }

    static func registration(id: Data, clientData: Data, attestation: Data?) -> PasskeyRegistrationCredential? {
        guard let attestation, !id.isEmpty else {
            return nil
        }
        let text = DeviceProofs.base64url(id)
        return PasskeyRegistrationCredential(
            id: text, rawId: text,
            response: PasskeyRegistrationCredentialResponse(
                clientDataJSON: DeviceProofs.base64url(clientData),
                attestationObject: DeviceProofs.base64url(attestation), transports: ["internal"]))
    }

    static func assertion(id: Data, clientData: Data, authenticatorData: Data?, signature: Data?, userID: Data?)
        -> PasskeyAssertionCredential?
    {
        guard let authenticatorData, let signature, !id.isEmpty else {
            return nil
        }
        let text = DeviceProofs.base64url(id)
        return PasskeyAssertionCredential(
            id: text, rawId: text,
            response: PasskeyAssertionCredentialResponse(
                clientDataJSON: DeviceProofs.base64url(clientData),
                authenticatorData: DeviceProofs.base64url(authenticatorData),
                signature: DeviceProofs.base64url(signature),
                userHandle: userID.flatMap { $0.isEmpty ? nil : DeviceProofs.base64url($0) }))
    }

    static func apple(identityToken: Data?, name: PersonNameComponents?) -> TulaAppleCredential? {
        guard let identityToken, let token = String(data: identityToken, encoding: .utf8), !token.isEmpty else {
            return nil
        }
        return TulaAppleCredential(idToken: token, givenName: name?.givenName, familyName: name?.familyName)
    }

    /// How the browser session is told where the round trip ends.
    enum Callback: Equatable {
        /// A custom scheme of the app.
        case scheme(String)
        /// An app link: a host and a path.
        case https(host: String, path: String)
    }

    /// What a browser session's answer means: the address it was sent back to, `nil` for a
    /// browser the user closed, and a failure for anything else. The error's own text is
    /// never kept.
    static func browserAnswer(_ returned: URL?, _ error: Error?) -> Result<String?, TulaSheetError> {
        if let returned {
            return .success(returned.absoluteString)
        }
        if let error, word(for: error) != .dismissed {
            return .failure(.failed)
        }
        return .success(nil)
    }

    static func callback(for redirectURL: String) -> Callback? {
        guard let parts = URLComponents(string: redirectURL), let scheme = parts.scheme?.lowercased() else {
            return nil
        }
        if scheme == "https" {
            guard let host = parts.host, !host.isEmpty else {
                return nil
            }
            return .https(host: host, path: parts.path)
        }
        return scheme == "http" ? nil : .scheme(scheme)
    }
}

#if canImport(AuthenticationServices)
import AuthenticationServices

/// One request to the system's authorization controller, and its one answer.
@MainActor
final class AuthorizationRun: NSObject, ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding
{
    /// The step that puts the sheet up. A test stands in for it and shows nothing.
    typealias Perform = @MainActor (ASAuthorizationController) -> Void

    private var waiting: CheckedContinuation<ASAuthorization, Error>?
    private var controller: ASAuthorizationController?
    private let anchor: ASPresentationAnchor
    private let perform: Perform

    init(anchor: ASPresentationAnchor, perform: @escaping Perform = { $0.performRequests() }) {
        self.anchor = anchor
        self.perform = perform
    }

    func run(_ request: ASAuthorizationRequest) async throws -> ASAuthorization {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                waiting = continuation
                let controller = ASAuthorizationController(authorizationRequests: [request])
                controller.delegate = self
                controller.presentationContextProvider = self
                self.controller = controller
                perform(controller)
            }
        } onCancel: {
            Task { @MainActor in self.controller?.cancel() }
        }
    }

    func authorizationController(
        controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        waiting?.resume(returning: authorization)
        waiting = nil
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        waiting?.resume(throwing: SystemSheetWire.word(for: error))
        waiting = nil
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor { anchor }
}

/// Show one request's sheet and hand back the credential the system answered with.
typealias SheetRun = @MainActor @Sendable (ASAuthorizationRequest, ASPresentationAnchor) async throws
    -> ASAuthorizationCredential?

extension SystemSheetWire {
    /// The system's own run of a request.
    static let systemRun: SheetRun = { request, anchor in
        try await AuthorizationRun(anchor: anchor).run(request).credential
    }

    /// The system's request for a new passkey; `nil` for options whose bytes are not base64url.
    static func registrationRequest(_ options: PasskeyCreationOptions)
        -> ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest?
    {
        guard let challenge = DeviceProofs.bytes(base64url: options.challenge),
            let user = DeviceProofs.bytes(base64url: options.user.id)
        else {
            return nil
        }
        let request = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: options.rp.id)
            .createCredentialRegistrationRequest(challenge: challenge, name: options.user.name, userID: user)
        request.displayName = options.user.displayName
        request.userVerificationPreference = .required
        if #available(iOS 17.4, macOS 14.4, *) {
            request.excludedCredentials = options.excludeCredentials.compactMap {
                DeviceProofs.bytes(base64url: $0.id).map(ASAuthorizationPlatformPublicKeyCredentialDescriptor.init)
            }
        }
        return request
    }

    /// The system's request for one of the user's passkeys.
    static func assertionRequest(_ options: PasskeyRequestOptions)
        -> ASAuthorizationPlatformPublicKeyCredentialAssertionRequest?
    {
        guard let challenge = DeviceProofs.bytes(base64url: options.challenge) else {
            return nil
        }
        let request = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: options.rpId)
            .createCredentialAssertionRequest(challenge: challenge)
        request.userVerificationPreference = .required
        request.allowedCredentials = (options.allowCredentials ?? []).compactMap {
            DeviceProofs.bytes(base64url: $0.id).map(ASAuthorizationPlatformPublicKeyCredentialDescriptor.init)
        }
        return request
    }

    /// The Sign in with Apple request: the name and the address, and the hashed nonce.
    static func appleRequest(hashedNonce: String) -> ASAuthorizationAppleIDRequest {
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.fullName, .email]
        request.nonce = hashedNonce
        return request
    }
}

/// The system's passkey sheet (`ASAuthorizationPlatformPublicKeyCredentialProvider`): passkeys
/// of this device and of the user's iCloud Keychain.
///
/// The app needs the Associated Domains entitlement with `webcredentials:<the relying
/// party's domain>`, and the environment the app registered as a native app
/// (docs/native-apps.md). Not run on a device or a simulator by this repository.
public struct SystemPasskeySheet: TulaPasskeySheet {
    private let anchor: @MainActor @Sendable () -> ASPresentationAnchor
    private let run: SheetRun

    /// - Parameter anchor: The window the sheet is shown over. A new, empty anchor by default.
    public init(anchor: @escaping @MainActor @Sendable () -> ASPresentationAnchor = { ASPresentationAnchor() }) {
        self.init(anchor: anchor, run: SystemSheetWire.systemRun)
    }

    init(anchor: @escaping @MainActor @Sendable () -> ASPresentationAnchor, run: @escaping SheetRun) {
        self.anchor = anchor
        self.run = run
    }

    /// Make a passkey for the signed-in user.
    @MainActor
    public func create(_ options: PasskeyCreationOptions) async throws -> PasskeyRegistrationCredential {
        guard let request = SystemSheetWire.registrationRequest(options) else {
            throw TulaSheetError.failed
        }
        let made = try await run(request, anchor()) as? ASAuthorizationPlatformPublicKeyCredentialRegistration
        guard
            let made,
            let credential = SystemSheetWire.registration(
                id: made.credentialID, clientData: made.rawClientDataJSON, attestation: made.rawAttestationObject)
        else {
            throw TulaSheetError.failed
        }
        return credential
    }

    /// Ask for one of the user's passkeys.
    @MainActor
    public func get(_ options: PasskeyRequestOptions) async throws -> PasskeyAssertionCredential {
        guard let request = SystemSheetWire.assertionRequest(options) else {
            throw TulaSheetError.failed
        }
        let found = try await run(request, anchor()) as? ASAuthorizationPlatformPublicKeyCredentialAssertion
        guard
            let found,
            let credential = SystemSheetWire.assertion(
                id: found.credentialID, clientData: found.rawClientDataJSON,
                authenticatorData: found.rawAuthenticatorData, signature: found.signature, userID: found.userID)
        else {
            throw TulaSheetError.failed
        }
        return credential
    }
}

/// The Sign in with Apple sheet (`ASAuthorizationAppleIDProvider`). The app needs the Sign in
/// with Apple capability. Not run on a device or a simulator by this repository.
public struct SystemAppleSheet: TulaAppleSheet {
    private let anchor: @MainActor @Sendable () -> ASPresentationAnchor
    private let run: SheetRun

    /// - Parameter anchor: The window the sheet is shown over. A new, empty anchor by default.
    public init(anchor: @escaping @MainActor @Sendable () -> ASPresentationAnchor = { ASPresentationAnchor() }) {
        self.init(anchor: anchor, run: SystemSheetWire.systemRun)
    }

    init(anchor: @escaping @MainActor @Sendable () -> ASPresentationAnchor, run: @escaping SheetRun) {
        self.anchor = anchor
        self.run = run
    }

    /// Ask Apple for an identity token whose `nonce` is `hashedNonce`.
    @MainActor
    public func authorize(hashedNonce: String) async throws -> TulaAppleCredential {
        let request = SystemSheetWire.appleRequest(hashedNonce: hashedNonce)
        let given = try await run(request, anchor()) as? ASAuthorizationAppleIDCredential
        guard let credential = SystemSheetWire.apple(identityToken: given?.identityToken, name: given?.fullName) else {
            throw TulaSheetError.failed
        }
        return credential
    }
}

/// The system's browser session (`ASWebAuthenticationSession`).
///
/// A custom-scheme redirect URL is listened for by its scheme. An app link (`https://…`) is
/// listened for by host and path, which the system offers from iOS 17.4 and macOS 14.4 and
/// needs the Associated Domains entitlement for; before those versions an app link is
/// `provider.unsupported`. Not run on a device or a simulator by this repository.
public struct SystemBrowserSession: TulaBrowserSession {
    /// The step that puts the browser up: it starts the session and says whether it
    /// started. A test stands in for it, opens nothing and answers in the browser's place.
    typealias Launch = @MainActor @Sendable (ASWebAuthenticationSession, @escaping @Sendable (URL?, Error?) -> Void)
        -> Bool

    private let anchor: @MainActor @Sendable () -> ASPresentationAnchor
    private let ephemeral: Bool
    private let launch: Launch

    /// - Parameters:
    ///   - ephemeral: Whether the browser starts with no cookies of the user's own browser,
    ///     so that the provider asks for its password every time.
    ///   - anchor: The window the browser is shown over. A new, empty anchor by default.
    public init(
        ephemeral: Bool = false,
        anchor: @escaping @MainActor @Sendable () -> ASPresentationAnchor = { ASPresentationAnchor() }
    ) {
        self.init(ephemeral: ephemeral, anchor: anchor, launch: { session, _ in session.start() })
    }

    init(
        ephemeral: Bool, anchor: @escaping @MainActor @Sendable () -> ASPresentationAnchor,
        launch: @escaping Launch
    ) {
        self.ephemeral = ephemeral
        self.anchor = anchor
        self.launch = launch
    }

    @MainActor
    private final class Context: NSObject, ASWebAuthenticationPresentationContextProviding {
        let anchor: ASPresentationAnchor
        var session: ASWebAuthenticationSession?
        init(anchor: ASPresentationAnchor) { self.anchor = anchor }
        func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { anchor }
    }

    /// One answer of a session, however often the system or a failed start gives one.
    private final class Once: @unchecked Sendable {
        private let lock = NSLock()
        private var over = false

        func first() -> Bool {
            lock.withLock {
                defer { over = true }
                return !over
            }
        }
    }

    /// Open the provider's page and wait for the redirect, or for the user to close it.
    @MainActor
    public func open(url: String, redirectURL: String) async throws -> String? {
        guard let address = URL(string: url), let callback = SystemSheetWire.callback(for: redirectURL) else {
            throw TulaSheetError.failed
        }
        let context = Context(anchor: anchor())
        let ephemeral = self.ephemeral
        let launch = self.launch
        return try await withCheckedThrowingContinuation { (waiting: CheckedContinuation<String?, Error>) in
            let once = Once()
            let done: @Sendable (URL?, Error?) -> Void = { returned, error in
                // The session and its context live until the answer; and one answer only.
                guard withExtendedLifetime(context, { once.first() }) else {
                    return
                }
                waiting.resume(with: SystemSheetWire.browserAnswer(returned, error).mapError { $0 as Error })
            }
            let session: ASWebAuthenticationSession
            switch callback {
            case .scheme(let scheme):
                session = ASWebAuthenticationSession(url: address, callbackURLScheme: scheme, completionHandler: done)
            case .https(let host, let path):
                guard #available(iOS 17.4, macOS 14.4, *) else {
                    return waiting.resume(throwing: TulaSheetError.unsupported)
                }
                session = ASWebAuthenticationSession(
                    url: address, callback: .https(host: host, path: path), completionHandler: done)
            }
            session.presentationContextProvider = context
            session.prefersEphemeralWebBrowserSession = ephemeral
            context.session = session
            if !launch(session, done) {
                done(nil, TulaSheetError.failed)
            }
        }
    }
}

#endif
