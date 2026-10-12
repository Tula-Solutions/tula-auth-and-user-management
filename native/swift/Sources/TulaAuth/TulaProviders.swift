import Foundation

// Signing in with a provider, the two ways a native app has (ADR 0045, ADR 0047, ADR 0044):
// handing the server an ID token the platform gave the app, and a round trip through the
// system's browser session that comes back to the app by a link.

/// A started sign-in with a provider's ID token: the nonce the token must carry, and the one
/// exchange of the token.
///
/// The attempt's secret is held inside and is never a property; the object prints as its
/// type's name. The ID token is sent once, in a JSON body, and kept nowhere.
public final class IdTokenSignIn: @unchecked Sendable, TulaRedacted {
    /// The server's nonce for this attempt. The app gives it to the provider's SDK so that
    /// the ID token carries it: Google's takes it as it is, and Apple's sheet takes its
    /// lowercase hexadecimal SHA-256 (`appleNonce`).
    public let nonce: String
    /// What Apple's request takes as its `nonce`: the lowercase hexadecimal SHA-256 of
    /// `nonce`, the one spelling the server accepts in Apple's token.
    public var appleNonce: String { sha256Hex(nonce) }

    private let attempt: FlowAttemptState

    init(nonce: String, attempt: FlowAttemptState) {
        self.nonce = nonce
        self.attempt = attempt
    }

    /// The type's name, and nothing of what it holds.
    public var description: String { "IdTokenSignIn" }

    /// Hand the server the ID token. An attempt takes one token, right or wrong: after a
    /// refusal the app starts again.
    ///
    /// - Parameters:
    ///   - idToken: The token the provider's SDK returned.
    ///   - givenName: For Apple alone: the given name the sheet handed the app. It names a
    ///     new account and nothing else.
    ///   - familyName: For Apple alone: the family name, likewise.
    /// - Returns: The sign-in, at its next step: `complete`, or a second factor.
    /// - Throws: `TulaError`: `auth.invalid_credentials` for every refusal of the token,
    ///   `service.unavailable` when the provider's keys could not be had.
    public func exchange(idToken: String, givenName: String? = nil, familyName: String? = nil) async throws
        -> SignInFlow
    {
        _ = try await attempt.step(
            TulaOperations.submitSignInIdToken,
            body: IdTokenExchangeRequest(idToken: idToken, givenName: givenName, familyName: familyName))
        return SignInFlow(attempt: attempt, operations: .signIn)
    }

    /// Leave the attempt: its secret is forgotten and a late answer is dropped.
    public func discard() {
        attempt.discard()
    }
}

/// Why a provider round trip ended without an answer of the provider being used.
public enum ProviderRefusal: Hashable, Sendable {
    /// The browser came back to an address that is not the redirect URL that was asked for.
    /// Nothing of it was read and no request was made.
    case unexpectedReturn
    /// The browser came back with neither a ticket nor an error, or there is nothing to
    /// try again.
    case noAnswer
    /// This client did not start the round trip the answer belongs to (or no longer has
    /// what it kept of it).
    case notStartedHere
    /// The provider or the API refused. `code` is a code of the contract; a code the
    /// address carried that the contract does not define is `oauth.provider_error`.
    case error(code: String)
}

/// What became of a provider round trip.
public enum ProviderOutcome: Sendable, TulaRedacted {
    /// Signed in: the flow is `complete`.
    case signedIn(SignInFlow)
    /// The provider proved the first factor and the server asks for more (a second factor).
    case needsStep(SignInFlow)
    /// The provider account is now one of the signed-in user's.
    case linked(Identity)
    /// The user closed the browser. Not an error: nothing was sent to prove anything.
    case cancelled
    /// The round trip ended without signing anyone in; see `ProviderRefusal`.
    case refused(ProviderRefusal)

    /// Which outcome it is, with the reason of a refusal (a fixed word or a code), and
    /// nothing of a flow or an identity.
    public var description: String {
        switch self {
        case .signedIn: return "ProviderOutcome.signedIn"
        case .needsStep: return "ProviderOutcome.needsStep"
        case .linked: return "ProviderOutcome.linked"
        case .cancelled: return "ProviderOutcome.cancelled"
        case .refused(let refusal): return "ProviderOutcome.refused(\(refusal))"
        }
    }
}

/// What a client keeps of a provider round trip, in memory and nowhere else: the binding
/// the starting client was given, and a ticket whose exchange got no answer.
final class ProviderRoundTrip: @unchecked Sendable, TulaRedacted {
    /// How long a ticket whose exchange got no answer is kept for another try. The API
    /// honours a ticket for 60 seconds.
    static let ticketHold: TimeInterval = 60

    enum Intent: Sendable {
        case signIn
        case link
    }

    struct Kept: Sendable, TulaRedacted {
        let attemptId: String
        let binding: String
        let intent: Intent
    }

    struct Held: Sendable, TulaRedacted {
        let ticket: String
        let until: Date
    }

    private let lock = NSLock()
    private var kept: Kept?
    private var held: Held?

    func keep(_ next: Kept) {
        lock.withLock {
            kept = next
            held = nil
        }
    }

    func hold(_ next: Held) {
        lock.withLock { held = next }
    }

    var current: (kept: Kept, held: Held)? {
        lock.withLock {
            guard let kept, let held else {
                return nil
            }
            return (kept, held)
        }
    }

    var binding: Kept? { lock.withLock { kept } }

    func forget() {
        lock.withLock {
            kept = nil
            held = nil
        }
    }

    /// What the fragment of a returned address says: a ticket and its attempt, or an error.
    struct Answer: Equatable {
        var ticket: String?
        var attemptId: String?
        var error: String?
    }

    /// Read a returned address, **only when it is the redirect URL that was asked for,
    /// character for character, followed by `#`**. Neither side is normalised.
    ///
    /// - Returns: The fragment's answer; `.noAnswer` for an address with no fragment or one
    ///   with neither a ticket nor an error; `.unexpectedReturn` for any other address.
    static func read(_ returned: String, redirectURL: String) -> Result<Answer, ProviderRefusalError> {
        guard let at = returned.firstIndex(of: "#") else {
            return .failure(ProviderRefusalError(refusal: .noAnswer))
        }
        guard returned[..<at] == redirectURL[...] else {
            return .failure(ProviderRefusalError(refusal: .unexpectedReturn))
        }
        var answer = Answer()
        for pair in returned[returned.index(after: at)...].split(separator: "&") {
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard parts.count == 2, let value = String(parts[1]).removingPercentEncoding, !value.isEmpty else {
                continue
            }
            switch parts[0] {
            case "tula_ticket": answer.ticket = answer.ticket ?? value
            case "tula_attempt": answer.attemptId = answer.attemptId ?? value
            case "tula_error": answer.error = answer.error ?? value
            default: continue
            }
        }
        if answer.ticket == nil, answer.error == nil {
            return .failure(ProviderRefusalError(refusal: .noAnswer))
        }
        return .success(answer)
    }

    /// The code of an error the address carried. The address is untrusted: only a code the
    /// contract defines is passed on.
    static func known(_ code: String) -> String {
        if case .unknown = ErrorCode(rawValue: code) {
            return "oauth.provider_error"
        }
        return code
    }
}

/// A refusal on its way out of the code that read an address.
struct ProviderRefusalError: Error, Equatable {
    let refusal: ProviderRefusal
}

extension FlowContext {
    func begin(_ started: FlowAttempt) async throws -> FlowAttemptState {
        let attempt = try FlowAttemptState(context: self, started: started)
        try await attempt.accept(started)
        return attempt
    }

    /// One round trip through the system's browser session.
    func providerRoundTrip(
        _ intent: ProviderRoundTrip.Intent, provider: OAuthProvider, redirectURL: String
    ) async throws -> ProviderOutcome {
        guard let browser else {
            throw TulaError.client(TulaClientErrorCode.providerUnsupported)
        }
        return try await gate.ceremony {
            // A new round trip replaces one that was waiting for a retry.
            roundTrip.forget()
            let body = OAuthStartRequest(provider: provider, redirectUrl: redirectURL)
            let attemptId: String
            let url: String
            let binding: String
            switch intent {
            case .signIn:
                let started = try await transport.call(TulaOperations.startOAuthSignIn, body: body, as: OAuthStart.self)
                (attemptId, url, binding) = (started.attempt.id, started.authorizationUrl, started.binding)
            case .link:
                let started = try await session.authorized(
                    TulaOperations.startIdentityLink, body: body, as: IdentityLinkStart.self)
                (attemptId, url, binding) = (started.attemptId, started.authorizationUrl, started.binding)
            }
            guard !attemptId.isEmpty, !binding.isEmpty, url.hasPrefix("https://") || url.hasPrefix("http://") else {
                throw TulaError.client(TulaClientErrorCode.responseInvalid)
            }
            roundTrip.keep(ProviderRoundTrip.Kept(attemptId: attemptId, binding: binding, intent: intent))
            let returned: String?
            do {
                returned = try await gate.sheet(.provider) { try await browser.open(url: url, redirectURL: redirectURL) }
                    .flatMap { $0 }
            } catch {
                roundTrip.forget()
                throw error
            }
            guard let returned else {
                roundTrip.forget()
                return .cancelled
            }
            switch ProviderRoundTrip.read(returned, redirectURL: redirectURL) {
            case .failure(let refused):
                roundTrip.forget()
                return .refused(refused.refusal)
            case .success(let answer):
                guard answer.error == nil, let ticket = answer.ticket else {
                    roundTrip.forget()
                    return .refused(.error(code: ProviderRoundTrip.known(answer.error ?? "")))
                }
                guard answer.attemptId == attemptId else {
                    // An answer for a round trip this client did not start: nothing is sent.
                    roundTrip.forget()
                    return .refused(.notStartedHere)
                }
                roundTrip.hold(
                    ProviderRoundTrip.Held(
                        ticket: ticket, until: clock.now().addingTimeInterval(ProviderRoundTrip.ticketHold)))
                return try await exchangeTicket()
            }
        }
    }

    /// Exchange the ticket that is held, with the binding that was kept.
    func exchangeTicket() async throws -> ProviderOutcome {
        guard let (kept, held) = roundTrip.current else {
            return .refused(.noAnswer)
        }
        guard clock.now() < held.until else {
            // The API no longer honours it: say so without asking.
            roundTrip.forget()
            return .refused(.error(code: "oauth.ticket_invalid"))
        }
        let body = OAuthExchangeRequest(ticket: held.ticket, attemptId: kept.attemptId, binding: kept.binding)
        do {
            let outcome: ProviderOutcome
            switch kept.intent {
            case .link:
                let identity = try await session.authorized(
                    TulaOperations.exchangeIdentityLinkTicket, body: body, as: Identity.self)
                guard !identity.id.isEmpty else {
                    throw TulaError.client(TulaClientErrorCode.responseInvalid)
                }
                outcome = .linked(identity)
            case .signIn:
                let next = try await transport.call(TulaOperations.exchangeOAuthTicket, body: body, as: FlowAttempt.self)
                // The ticket was answered: what follows (keeping the session) is not about it.
                roundTrip.forget()
                let flow = SignInFlow(attempt: try await begin(next), operations: .signIn)
                outcome = next.step.status == "complete" ? .signedIn(flow) : .needsStep(flow)
            }
            roundTrip.forget()
            return outcome
        } catch let error as TulaError {
            if roundTrip.current != nil, ProviderRoundTrip.retryable.contains(error.code) {
                // No answer about the ticket: it and the binding are kept for another try.
                throw error
            }
            roundTrip.forget()
            // One of the client's own codes is not an answer about the ticket to report as
            // the provider's: it is thrown. (`response.invalid` carries the answer's status.)
            if error.status == 0 || error.code == TulaClientErrorCode.responseInvalid {
                throw error
            }
            if error.code == "oauth.different_browser" {
                return .refused(.notStartedHere)
            }
            return .refused(.error(code: error.code))
        }
    }
}

extension ProviderRoundTrip {
    /// The failures of an exchange that say nothing about the ticket: the same call again
    /// may work. The last two are raised before the request about the ticket is sent (by
    /// the refresh a link's exchange may need first), so the ticket has not been presented.
    static let retryable: Set<String> = [
        TulaClientErrorCode.networkFailed, TulaClientErrorCode.networkTimeout, "rate_limited",
        TulaClientErrorCode.storageFailed, TulaClientErrorCode.deviceKeyFailed,
    ]
}
