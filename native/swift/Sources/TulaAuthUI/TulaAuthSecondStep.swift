import Foundation
import TulaAuth

// The actions of the screens that came after the first ones (TULA-60, ADR 0058): a texted
// code, the second step, setting up an authenticator app inside a sign-in, and the ways to
// sign in that are not typed (a passkey, a provider). They follow the rules of the actions
// in TulaAuthModel.swift: one at a time, an answer of a screen that was left is dropped,
// a completion is never dropped, and no action is silent.

extension TulaAuthModel {
    // MARK: A texted code

    /// "Text me a code": ask the server to text the code of the open screen. Nothing is
    /// texted by arriving at a screen: a message costs money, so a person asks.
    public func sendTextedCode() async {
        guard !isPending, !textedOff else {
            return
        }
        switch (screen, flow) {
        case (.textedSignInOffer, .signIn(let flow)):
            await perform(flow: flow) { try await flow.prepareSmsCode() }
        case (.secondFactor(.textedCode, _, nil), .some(let flow)):
            let any = flow.any
            await perform(flow: any) { try await any.prepareSmsSecondFactor() }
        case (.textedSignInOffer, _), (.secondFactor(.textedCode, _, nil), _):
            lost()
        default:
            return
        }
    }

    // MARK: The second step

    /// Open another way to take the second step, among the ones the step offers.
    ///
    /// - Parameter way: A way of the open screen's `others`.
    public func useSecondWay(_ way: TulaSecondWay) {
        guard case .secondFactor(let open, let others, _) = screen, others.contains(way), !isPending else {
            return
        }
        guard let flow else {
            lost()
            return
        }
        // The texted code's number is the step's to say: a code asked for earlier in this
        // step is still the one to type.
        var sent: String?
        if way == .textedCode, case .secondFactor(let step) = flow.any.screen {
            sent = step.prepared.flatMap { $0.method == .smsCode ? $0.destination : nil }
        }
        show(.secondFactor(way, others: [open] + others.filter { $0 != way }, sent: sent))
    }

    /// The main button of the backup code's screen. The field is emptied as the code is
    /// sent, right or wrong: a code works once.
    public func submitBackupCode() async {
        guard case .secondFactor(.backupCode, _, _) = screen, !isPending else {
            return
        }
        guard let flow else {
            lost()
            return
        }
        let typed = backupCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard require(typed.isEmpty ? [.backupCode] : [], message: strings.secondStep.backupRequired) else {
            return
        }
        backupCode = ""
        let any = flow.any
        await perform(flow: any) { try await any.submitBackupCode(typed).step }
    }

    /// "Use your passkey": show the system's sheet for the second step. A sheet that was
    /// closed is said quietly: nothing was sent, and the step is the one it was.
    public func useSecondPasskey() async {
        guard case .secondFactor(.passkey, _, _) = screen else {
            return
        }
        guard let flow else {
            if !isPending {
                lost()
            }
            return
        }
        guard let asked = begin() else {
            return
        }
        let any = flow.any
        do {
            let outcome = try await any.submitSecondFactorWithPasskey()
            guard asked == generation else {
                if screen(of: any) == .signedIn {
                    arrived()
                }
                return
            }
            isPending = false
            switch outcome {
            case .dismissed: quiet(strings.ways.passkeyDismissed)
            case .finished: show(screen(of: any))
            }
        } catch {
            if screen(of: any) == .signedIn {
                arrived(saved: false)
            } else {
                fail(error, asked, refused: strings.ways.passkeyRefused)
            }
        }
    }

    // MARK: Setting up an authenticator app inside a sign-in

    /// "Set up authenticator app": ask for the setup key and open its screen. Asking again
    /// replaces the key.
    public func startEnrolment() async {
        guard screen == .enrolmentStart, !isPending else {
            return
        }
        guard let flow else {
            lost()
            return
        }
        guard let asked = begin() else {
            return
        }
        let any = flow.any
        do {
            let enrolment = try await any.startTotpEnrolment()
            guard asked == generation else {
                return
            }
            isPending = false
            show(.totpSetup)
            setup = TulaAuthSetup(key: enrolment.secret, uri: enrolment.uri)
        } catch {
            fail(error, asked)
        }
    }

    /// "Turn on": confirm the authenticator app with the code it shows. The answer carries
    /// the backup codes, which are shown once, **before** the sign-in is reported: an app
    /// takes these screens away when it is told, and the codes with them.
    public func confirmEnrolment() async {
        guard screen == .totpSetup, !isPending else {
            return
        }
        guard let flow else {
            lost()
            return
        }
        let typed = code
        guard require(typed.count == TulaAuthModel.codeLength ? [] : [.code], message: strings.codeIncomplete) else {
            return
        }
        code = ""
        guard let asked = begin() else {
            return
        }
        let any = flow.any
        do {
            let result = try await any.confirmTotpEnrolment(code: typed)
            guard asked == generation else {
                // The screen was left while the answer was on its way: its codes are shown
                // to nobody (new ones are a button of the account screen). A sign-in that
                // completed is reported all the same.
                if screen(of: any) == .signedIn {
                    arrived(saved: result.failure == nil)
                }
                return
            }
            isPending = false
            show(.backupCodes)
            backupCodes = result.backupCodes
            sessionUnsaved = result.failure != nil
        } catch {
            fail(error, asked)
        }
    }

    /// "Copy setup key": put the key on the pasteboard, because a person asked.
    public func copySetupKey() {
        guard screen == .totpSetup, let setup else {
            return
        }
        copy(setup.key)
        copied()
    }

    /// "Copy": put the backup codes on the pasteboard, one a line, because a person asked.
    public func copyBackupCodes() {
        guard screen == .backupCodes, !backupCodes.isEmpty else {
            return
        }
        copy(backupCodes.joined(separator: "\n"))
        copied()
    }

    private func copied() {
        status = strings.secondStep.copied
        announce(strings.secondStep.copied)
    }

    /// "I have saved these codes": forget them and go on to what the flow is at, which is
    /// normally "signed in".
    public func savedBackupCodes() {
        guard screen == .backupCodes, !isPending else {
            return
        }
        guard let flow else {
            lost()
            return
        }
        let unsaved = sessionUnsaved
        let next = screen(of: flow.any)
        show(next)
        if next == .signedIn, unsaved {
            formError = strings.sessionNotSaved
            announce(strings.sessionNotSaved)
        }
    }

    // MARK: Ways to sign in that are not typed

    /// "Sign in with a passkey": show the system's sheet. There is no address: the passkey
    /// says who it is.
    public func usePasskey() async {
        guard screen == .signInStart, ways.contains(.passkey), let asked = begin() else {
            return
        }
        let client = self.client
        await arrive(asked, dismissed: strings.ways.passkeyDismissed, refused: strings.ways.passkeyRefused) {
            try await client.signInWithPasskey()
        }
    }

    /// "Continue with …": sign in with a provider. Apple's and Google's own sheets where
    /// the app gave them, the system's browser otherwise.
    ///
    /// - Parameter provider: A provider of `ways`.
    public func useProvider(_ provider: OAuthProvider) async {
        guard screen == .signInStart, ways.contains(.provider(provider)), let asked = begin() else {
            return
        }
        let client = self.client
        let cancelled = strings.ways.providerCancelled
        if provider == .apple, client.sheets.apple {
            await arrive(asked, dismissed: cancelled) { try await client.signInWithApple() }
        } else if provider == .google, let sheet = options.google {
            await arrive(asked, dismissed: cancelled) {
                let pending = try await client.startIdTokenSignIn(provider: .google)
                let token: String?
                do {
                    token = try await sheet(pending.nonce)
                } catch {
                    // Whatever Google's SDK threw is the app's own: nothing of it is kept.
                    pending.discard()
                    throw SheetFailed()
                }
                guard let token else {
                    pending.discard()
                    return .dismissed
                }
                do {
                    return .finished(try await pending.exchange(idToken: token))
                } catch {
                    pending.discard()
                    throw error
                }
            }
        } else if let redirectURL = options.redirectURL {
            await roundTrip(asked) { try await client.signIn(with: provider, redirectURL: redirectURL) }
        } else {
            isPending = false
        }
    }

    /// "Try again": send again the last step of a provider sign-in that got no answer.
    public func retryProvider() async {
        guard screen == .signInStart, canRetryProvider, let asked = begin() else {
            return
        }
        let client = self.client
        await roundTrip(asked) { try await client.retryProviderSignIn() }
    }

    /// A sheet of the app's own that threw. It holds nothing of what was thrown.
    private struct SheetFailed: Error {}

    /// Run a sign-in that shows a sheet, and take the flow it answers.
    private func arrive(
        _ asked: Int, dismissed: String, refused: String? = nil,
        _ sheet: @escaping @Sendable () async throws -> TulaCeremony<SignInFlow>
    ) async {
        do {
            switch try await sheet() {
            case .dismissed:
                guard asked == generation else {
                    return
                }
                isPending = false
                quiet(dismissed)
            case .finished(let flow):
                adopt(flow, asked)
            }
        } catch is SheetFailed {
            guard asked == generation else {
                return
            }
            isPending = false
            formError = strings.ways.providerFailed
            announce(strings.ways.providerFailed)
        } catch {
            if await completed(by: error) {
                arrived(saved: false)
            } else {
                fail(error, asked, refused: refused ?? strings.ways.providerRefused)
            }
        }
    }

    /// Run a provider's round trip through the system's browser, and say what came back.
    private func roundTrip(_ asked: Int, _ trip: @escaping @Sendable () async throws -> ProviderOutcome) async {
        do {
            let outcome = try await trip()
            switch outcome {
            case .signedIn(let flow), .needsStep(let flow):
                adopt(flow, asked)
            case .cancelled, .refused, .linked:
                guard asked == generation else {
                    return
                }
                isPending = false
                canRetryProvider = false
                if case .cancelled = outcome {
                    quiet(strings.ways.providerCancelled)
                } else {
                    // What the provider's page came back with is said by its code where the
                    // contract has one, and in the table's own words otherwise.
                    var words = strings.ways.providerRefused
                    if case .refused(.error(let code)) = outcome {
                        words = strings.message(code: code)
                    }
                    formError = words
                    announce(words)
                }
            }
        } catch {
            if await completed(by: error) {
                arrived(saved: false)
                return
            }
            fail(error, asked, refused: strings.ways.providerRefused)
            // The page was shown and its answer is held for a minute: the last step can be
            // sent again without another trip to the provider. Any other failure is an
            // answer about the ticket, which the client has then forgotten: "Try again"
            // goes with it, also when it was there from an earlier try.
            let again = [TulaClientErrorCode.networkFailed, TulaClientErrorCode.networkTimeout, "rate_limited"]
            if asked == generation {
                canRetryProvider = (error as? TulaError).map { again.contains($0.code) } ?? false
            }
        }
    }

    /// Take a flow a sheet or a round trip answered: show its step, or, where the screen
    /// was left meanwhile, drop it (a flow that completed cannot be dropped: somebody is
    /// signed in).
    private func adopt(_ arrived: SignInFlow, _ asked: Int) {
        guard asked == generation else {
            if screen(of: arrived) == .signedIn {
                self.arrived()
            } else {
                arrived.discard()
            }
            return
        }
        flow = .signIn(arrived)
        isPending = false
        show(screen(of: arrived))
    }
}
