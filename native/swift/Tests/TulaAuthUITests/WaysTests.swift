import Foundation
import TulaAuth
import XCTest

@testable import TulaAuthUI

// The ways to sign in that are not typed: which of them the first screen draws (a control
// is there only where the environment has the way and the app gave what shows it), and what
// a passkey sheet, a provider's own sheet and a provider's page in the browser come to.
// Every sheet and the browser are scripted fakes: nothing is shown.
@MainActor
final class WaysTests: XCTestCase {
    private typealias Offer = TulaAuthOffer

    // MARK: Which controls are drawn

    func testAControlIsDrawnOnlyWhereTheEnvironmentHasTheWayAndTheAppGaveWhatShowsIt() async throws {
        let google: @Sendable (String) async throws -> String? = { _ in nil }
        let redirect = TulaAuthOptions(redirectURL: Wire.redirect)
        let everything = ["google", "github", "apple"]
        struct Row {
            let name: String
            let methods: [String]
            let oauth: [String]
            var passkeys = false
            var apple = false
            var browser = false
            var options = TulaAuthOptions()
            let ways: [TulaAuthWay]
        }
        let rows: [Row] = [
            Row(name: "nothing given", methods: ["password", "passkey"], oauth: everything, ways: []),
            Row(name: "a passkey sheet", methods: ["password", "passkey"], oauth: [], passkeys: true, ways: [.passkey]),
            Row(name: "a sheet, passkeys off", methods: ["password"], oauth: [], passkeys: true, ways: []),
            Row(
                name: "a browser and where to come back to", methods: ["password"], oauth: everything, browser: true,
                options: redirect, ways: [.provider(.google), .provider(.github), .provider(.apple)]),
            Row(name: "a browser alone", methods: ["password"], oauth: everything, browser: true, ways: []),
            Row(name: "a redirect URL alone", methods: ["password"], oauth: everything, options: redirect, ways: []),
            Row(
                name: "Apple's sheet", methods: ["password"], oauth: everything, apple: true,
                ways: [.provider(.apple)]),
            Row(name: "Apple's sheet, Apple off", methods: ["password"], oauth: ["github"], apple: true, ways: []),
            Row(
                name: "Google's closure", methods: ["password"], oauth: everything,
                options: TulaAuthOptions(google: google), ways: [.provider(.google)]),
            Row(
                name: "everything", methods: ["passkey", "password"], oauth: ["apple", "google"], passkeys: true,
                apple: true, browser: true, options: TulaAuthOptions(redirectURL: Wire.redirect, google: google),
                ways: [.passkey, .provider(.apple), .provider(.google)]),
            // A provider this version does not know, and one listed twice.
            Row(
                name: "names of tomorrow", methods: ["password"], oauth: ["myspace", "github", "github"],
                browser: true, options: redirect, ways: [.provider(.github)]),
        ]
        for row in rows {
            let stage = try Stage(
                passkeys: row.passkeys ? ScriptedPasskeySheet() : nil, apple: row.apple ? ScriptedAppleSheet() : nil,
                browser: row.browser ? ScriptedBrowser() : nil, options: row.options)
            XCTAssertEqual(stage.model.ways, [], "\(row.name): hidden until it is known to work here")
            XCTAssertEqual(stage.model.content.ways, [], row.name)
            await stage.configure(methods: row.methods, oauth: row.oauth)
            XCTAssertEqual(stage.model.ways, row.ways, row.name)
            XCTAssertEqual(stage.model.situation.ways, row.ways, row.name)
            let drawn = stage.model.content
            XCTAssertEqual(drawn.ways.map(\.action), row.ways.map(WaysTests.action), row.name)
            XCTAssertEqual(drawn.divider, row.ways.isEmpty ? nil : "or", row.name)
            // What is not drawn cannot be asked for either.
            let before = stage.api.routes
            for action in TulaAuthAction.allCases where !drawn.actions.contains(action) {
                await stage.model.perform(action)
            }
            if !row.ways.contains(.passkey) {
                await stage.model.usePasskey()
            }
            for provider in TulaAuthAction.providers where !row.ways.contains(.provider(provider)) {
                await stage.model.useProvider(provider)
            }
            await stage.model.retryProvider()
            XCTAssertEqual(stage.api.routes, before, row.name)
            XCTAssertNil(stage.model.formError, row.name)
            XCTAssertFalse(stage.model.isPending, row.name)
        }
    }

    private static func action(_ way: TulaAuthWay) -> TulaAuthAction {
        switch way {
        case .passkey: return .usePasskey
        case .provider(let provider): return .useProvider(provider)
        }
    }

    func testTheWordsOfTheWays() async throws {
        let stage = try Stage(
            passkeys: ScriptedPasskeySheet(), browser: ScriptedBrowser(),
            options: TulaAuthOptions(redirectURL: Wire.redirect))
        await stage.configure(methods: ["password", "passkey"], oauth: TulaAuthAction.providers.map(\.rawValue))
        XCTAssertEqual(
            stage.model.content.ways,
            [
                Offer("passkey", "Sign in with a passkey", .usePasskey),
                Offer("provider.google", "Continue with Google", .useProvider(.google)),
                Offer("provider.github", "Continue with GitHub", .useProvider(.github)),
                Offer("provider.apple", "Continue with Apple", .useProvider(.apple)),
                Offer("provider.microsoft", "Continue with Microsoft", .useProvider(.microsoft)),
                Offer("provider.discord", "Continue with Discord", .useProvider(.discord)),
                Offer("provider.linkedin", "Continue with LinkedIn", .useProvider(.linkedin)),
                Offer("provider.x", "Continue with X", .useProvider(.x)),
                Offer("provider.facebook", "Continue with Facebook", .useProvider(.facebook)),
            ])
        XCTAssertEqual(Set(stage.model.content.ways.map(\.identifier)).count, 9, "a control is found by its identifier")

        // A provider an app's table has no name for is not drawn: a button is never worded
        // from a server's string. Neither by the model nor by the content.
        var strings = TulaStrings.english
        strings.ways.providers["github"] = nil
        strings.ways.continueWith = "Weiter mit {provider}"
        let worded = try Stage(strings: strings, browser: ScriptedBrowser(), options: TulaAuthOptions(redirectURL: Wire.redirect))
        await worded.configure(methods: ["password"], oauth: ["github", "google"])
        XCTAssertEqual(worded.model.ways, [.provider(.google)])
        XCTAssertEqual(worded.model.content.ways.map(\.title), ["Weiter mit Google"])
        var situation = TulaAuthSituation()
        situation.ways = [.provider(.github), .provider(.google)]
        let drawn = TulaAuthContent(screen: .signInStart, strings: strings, situation: situation)
        XCTAssertEqual(drawn.ways.map(\.action), [.useProvider(.google)])
    }

    func testAWayIsOnlyOnTheFirstScreenOfASignIn() async throws {
        let stage = try Stage(passkeys: ScriptedPasskeySheet())
        await stage.configure(methods: ["password", "passkey"])
        for screen in ContentTests.everyScreen where screen != .signInStart {
            let content = TulaAuthContent(screen: screen, strings: .english, situation: stage.model.situation)
            XCTAssertEqual(content.ways, [], "\(screen)")
            XCTAssertNil(content.divider, "\(screen)")
        }
        stage.model.showSignUp()
        let before = stage.api.routes
        await stage.model.usePasskey()
        XCTAssertEqual(stage.api.routes, before)
    }

    func testWhereAPhoneNumberSignsInTheFirstFieldSaysSo() async throws {
        let stage = try Stage()
        XCTAssertFalse(stage.model.phoneSignIn)
        XCTAssertEqual(stage.model.content.fields.first?.kind, .email)
        await stage.configure(methods: ["password", "smsCode"])
        XCTAssertTrue(stage.model.phoneSignIn)
        XCTAssertTrue(stage.model.canIdentify)
        XCTAssertEqual(
            stage.model.content.fields,
            [
                TulaAuthFieldContent(
                    field: .email, kind: .identifier, label: "Email address or phone number",
                    hint: "For a phone number, include the country code, for example +1 415 555 0142.",
                    submit: .start)
            ])
    }

    func testAnEnvironmentWhoseOnlyWaysCannotBeTakenHereSaysSoInWords() async throws {
        // Passkeys and a provider, on an app that gave neither a sheet nor a browser; an
        // emailed link, which this client has no call for.
        let stage = try Stage()
        await stage.configure(methods: ["passkey", "emailLink"], oauth: ["github"])
        XCTAssertFalse(stage.model.canIdentify)
        XCTAssertEqual(stage.model.ways, [])
        XCTAssertEqual(
            stage.model.content,
            TulaAuthContent(
                title: "Sign in",
                subtitle:
                    "The ways to sign in here are ones this version of the app cannot use on this device. Update the app.",
                links: [Offer("signUp", "Create an account", .showSignUp, lead: "New here?")]))
        // No field, so nothing to start with: the keyboard's "go" of a field that is gone.
        stage.model.email = "maya@example.com"
        await stage.model.start()
        await stage.model.perform(.start)
        XCTAssertEqual(stage.api.routes, [Wire.config])
        XCTAssertEqual(stage.model.fieldErrors, [:])

        // With a sheet the same environment has a way, and is not said to have none.
        let sheet = try Stage(passkeys: ScriptedPasskeySheet())
        await sheet.configure(methods: ["passkey"])
        XCTAssertFalse(sheet.model.canIdentify)
        XCTAssertEqual(
            sheet.model.content,
            TulaAuthContent(
                title: "Sign in", subtitle: "to continue to Acme",
                links: [Offer("signUp", "Create an account", .showSignUp, lead: "New here?")],
                ways: [Offer("passkey", "Sign in with a passkey", .usePasskey)]))
        // A sign-up still has its form.
        sheet.model.showSignUp()
        XCTAssertEqual(sheet.model.content.fields.count, 2)
    }

    // MARK: A passkey

    private func withPasskeys(
        _ sheet: ScriptedPasskeySheet, storage: any TulaTokenStorage = MemoryTokenStorage()
    ) async throws -> Stage {
        let stage = try Stage(storage: storage, passkeys: sheet)
        await stage.configure(methods: ["password", "passkey"])
        stage.api.on(Wire.passkeyStart, Wire.passkeyStarted)
        return stage
    }

    func testAPasskeySignsInWithoutAnAddress() async throws {
        let sheet = ScriptedPasskeySheet()
        let stage = try await withPasskeys(sheet)
        stage.api.on(Wire.passkeySubmit, Wire.flow("sign_in", Wire.complete))
        await stage.model.perform(.usePasskey)
        XCTAssertEqual(sheet.asked, 1)
        XCTAssertEqual(stage.api.count(Wire.signIns), 0, "the passkey says who it is")
        XCTAssertNotNil(stage.api.body(Wire.passkeySubmit)["credential"])
        XCTAssertEqual(stage.model.screen, .signedIn)
        XCTAssertEqual(stage.heard.signedIn, 1)
        XCTAssertEqual(stage.model.fieldErrors, [:], "an empty address is not missing")
    }

    func testAClosedPasskeySheetIsSaidQuietlyNobodyIsSignedInAndTheButtonWorksAgain() async throws {
        let sheet = ScriptedPasskeySheet()
        sheet.answer(.failure(TulaSheetError.dismissed))
        let stage = try await withPasskeys(sheet)
        await stage.model.usePasskey()
        XCTAssertEqual(
            stage.model.notice, "The passkey request was cancelled. Nothing was changed; you can try again.")
        XCTAssertEqual(stage.heard.said, [stage.model.notice ?? ""], "announced, once")
        XCTAssertNil(stage.model.formError, "never an error")
        XCTAssertEqual(stage.model.fieldErrors, [:])
        XCTAssertNil(stage.model.status)
        XCTAssertFalse(stage.model.isPending)
        XCTAssertEqual(stage.model.screen, .signInStart)
        XCTAssertEqual(stage.api.count(Wire.passkeySubmit), 0)
        let signedIn = await stage.isSignedIn
        XCTAssertFalse(signedIn)
        XCTAssertEqual(stage.heard.signedIn, 0)

        sheet.answer(.success(ScriptedPasskeySheet.assertion))
        stage.api.on(Wire.passkeySubmit, Wire.flow("sign_in", Wire.complete))
        await stage.model.usePasskey()
        XCTAssertEqual(sheet.asked, 2)
        XCTAssertEqual(stage.model.screen, .signedIn)
        XCTAssertEqual(stage.heard.signedIn, 1)
    }

    func testAPasskeySheetThatFailedAndAPasskeyThatWasRefusedAreSaidAboveTheForm() async throws {
        for thrown in [TulaSheetError.failed as Error, LoudSheetFailure()] {
            let sheet = ScriptedPasskeySheet()
            sheet.answer(.failure(thrown))
            let stage = try await withPasskeys(sheet)
            await stage.model.usePasskey()
            XCTAssertEqual(stage.model.formError, "The passkey could not be used. Try again.")
            XCTAssertNil(stage.model.notice)
            XCTAssertFalse(stage.model.isPending)
            XCTAssertFalse(stage.everything.contains(LoudSheetFailure.text))
        }

        // The server refuses every passkey alike, with the code of a wrong password: said
        // about the passkey, and not under the address nobody typed.
        let stage = try await withPasskeys(ScriptedPasskeySheet())
        stage.api.on(Wire.passkeySubmit, Reply.error(401, "auth.invalid_credentials"))
        let asked = stage.model.focusRequests
        await stage.model.usePasskey()
        XCTAssertEqual(stage.model.formError, "That passkey did not sign you in. Try again, or sign in another way.")
        XCTAssertEqual(stage.model.fieldErrors, [:])
        XCTAssertEqual(stage.model.focusRequests, asked, "the focus is not moved to a field nobody used")
        XCTAssertFalse(stage.shown.contains("password"))
        XCTAssertFalse(stage.shown.contains(Canary.serverText))
        XCTAssertEqual(stage.model.screen, .signInStart)
    }

    func testASheetThatIsStillOpenIsSaidQuietlyAndNothingIsSent() async throws {
        let sheet = ScriptedPasskeySheet()
        let gate = Gate()
        sheet.hold(gate)
        let stage = try await withPasskeys(sheet)
        // The same client, somewhere else in the app.
        let client = stage.client
        let other = Task { _ = try? await client.signInWithPasskey() }
        await eventually("the other sheet is out") { sheet.asked == 1 }
        let sent = stage.api.routes

        await stage.model.usePasskey()
        XCTAssertEqual(stage.model.notice, "Another sign-in window is still open. Finish or close it first.")
        XCTAssertNil(stage.model.formError)
        XCTAssertFalse(stage.model.isPending)
        XCTAssertEqual(stage.api.routes, sent)
        XCTAssertEqual(sheet.asked, 1)

        sheet.answer(.failure(TulaSheetError.dismissed))
        gate.open()
        await other.value
    }

    func testAPasskeyAnsweredAfterItsScreenWasLeft() async throws {
        // Closed while the sheet was out, and the sheet was then closed: nothing is said.
        let dismissed = ScriptedPasskeySheet()
        let first = Gate()
        dismissed.hold(first)
        let quiet = try await withPasskeys(dismissed)
        let closing = Task { await quiet.model.usePasskey() }
        await eventually("the sheet is out") { dismissed.asked == 1 }
        XCTAssertTrue(quiet.model.isPending)
        quiet.model.showSignUp()
        dismissed.answer(.failure(TulaSheetError.dismissed))
        first.open()
        await closing.value
        XCTAssertNil(quiet.model.notice)
        XCTAssertEqual(quiet.model.screen, .signUpStart)

        // Left, and the sheet then failed: not said on a screen that did not ask.
        let failing = ScriptedPasskeySheet()
        let second = Gate()
        failing.hold(second)
        let failed = try await withPasskeys(failing)
        let asking = Task { await failed.model.usePasskey() }
        await eventually("the sheet is out") { failing.asked == 1 }
        failed.model.showSignUp()
        failing.answer(.failure(TulaSheetError.failed))
        second.open()
        await asking.value
        XCTAssertNil(failed.model.formError)

        // Left, and the passkey then signed in: somebody is signed in, and the app is told.
        let sheet = ScriptedPasskeySheet()
        let third = Gate()
        sheet.hold(third)
        let stage = try await withPasskeys(sheet)
        stage.api.on(Wire.passkeySubmit, Wire.flow("sign_in", Wire.complete))
        let signing = Task { await stage.model.usePasskey() }
        await eventually("the sheet is out") { sheet.asked == 1 }
        stage.model.showSignUp()
        third.open()
        await signing.value
        let signedIn = await stage.isSignedIn
        XCTAssertTrue(signedIn)
        XCTAssertEqual(stage.model.screen, .signedIn)
        XCTAssertEqual(stage.heard.signedIn, 1)
    }

    // MARK: A provider's own sheet

    private func withApple(
        _ sheet: ScriptedAppleSheet, storage: any TulaTokenStorage = MemoryTokenStorage()
    ) async throws -> Stage {
        let stage = try Stage(storage: storage, apple: sheet)
        await stage.configure(methods: ["password"], oauth: ["apple"])
        stage.api.on(Wire.idTokens, Wire.idTokenStarted)
        return stage
    }

    func testApplesSheetSignsIn() async throws {
        let sheet = ScriptedAppleSheet()
        let stage = try await withApple(sheet)
        stage.api.on(Wire.idTokenExchange, Wire.flow("sign_in", Wire.complete))
        await stage.model.perform(.useProvider(.apple))
        XCTAssertEqual(sheet.nonces.count, 1)
        XCTAssertNotEqual(sheet.nonces.first, "server-nonce", "the sheet is shown with the nonce's hash")
        XCTAssertEqual(stage.api.body(Wire.idTokens)["provider"] as? String, "apple")
        XCTAssertEqual(stage.api.body(Wire.idTokenExchange)["idToken"] as? String, "CANARY-id-token")
        XCTAssertEqual(stage.model.screen, .signedIn)
        XCTAssertEqual(stage.heard.signedIn, 1)
        XCTAssertFalse(stage.everything.contains("CANARY"), "nothing of the token is shown or said")
    }

    func testApplesSheetClosedFailedAndRefused() async throws {
        let closed = ScriptedAppleSheet()
        closed.answer(.failure(TulaSheetError.dismissed))
        let quiet = try await withApple(closed)
        await quiet.model.useProvider(.apple)
        XCTAssertEqual(quiet.model.notice, "Sign-in was cancelled. Nothing was changed; you can try again.")
        XCTAssertNil(quiet.model.formError)
        XCTAssertEqual(quiet.api.count(Wire.idTokenExchange), 0)
        XCTAssertFalse(quiet.model.isPending)
        XCTAssertEqual(quiet.heard.signedIn, 0)

        let broken = ScriptedAppleSheet()
        broken.answer(.failure(LoudSheetFailure()))
        let failed = try await withApple(broken)
        await failed.model.useProvider(.apple)
        XCTAssertEqual(failed.model.formError, "The sign-in could not be shown. Try again.")
        XCTAssertNil(failed.model.notice)
        XCTAssertFalse(failed.everything.contains(LoudSheetFailure.text))

        // A token the server refused: the code of a wrong password, said about the sign-in.
        let refused = try await withApple(ScriptedAppleSheet())
        refused.api.on(Wire.idTokenExchange, Reply.error(401, "auth.invalid_credentials"))
        await refused.model.useProvider(.apple)
        XCTAssertEqual(refused.model.formError, "We could not sign you in. Nothing was changed; start again.")
        XCTAssertEqual(refused.model.fieldErrors, [:])
        XCTAssertFalse(refused.shown.contains("password"))
        XCTAssertFalse(refused.model.isPending)

        // The account is another's to sign in to: said by its own code, above the form.
        let exists = try await withApple(ScriptedAppleSheet())
        exists.api.on(Wire.idTokenExchange, Reply.error(409, "oauth.account_exists"))
        await exists.model.useProvider(.apple)
        XCTAssertEqual(exists.model.formError, exists.model.strings.message(code: "oauth.account_exists"))
        XCTAssertFalse(exists.shown.contains(Canary.serverText))
    }

    /// A stage whose app gave Google's own sheet as a closure.
    private func withGoogle(
        _ calls: Calls, storage: any TulaTokenStorage = MemoryTokenStorage(),
        _ sheet: @escaping @Sendable (String) async throws -> String?
    ) async throws -> Stage {
        let stage = try Stage(
            storage: storage,
            options: TulaAuthOptions(google: { nonce in
                calls.note(nonce)
                return try await sheet(nonce)
            }))
        await stage.configure(methods: ["password"], oauth: ["google"])
        stage.api.on(Wire.idTokens, Wire.idTokenStarted)
        return stage
    }

    func testGooglesClosureIsHandedTheServersNonceAndItsTokenSignsIn() async throws {
        let calls = Calls()
        let stage = try await withGoogle(calls) { _ in "CANARY-google-token" }
        stage.api.on(Wire.idTokenExchange, Wire.flow("sign_in", Wire.complete))
        await stage.model.perform(.useProvider(.google))
        XCTAssertEqual(calls.seen, ["server-nonce"], "as it is: Google's sheet takes no hash")
        XCTAssertEqual(stage.api.body(Wire.idTokens)["provider"] as? String, "google")
        XCTAssertEqual(stage.api.body(Wire.idTokenExchange)["idToken"] as? String, "CANARY-google-token")
        XCTAssertEqual(stage.model.screen, .signedIn)
        XCTAssertEqual(stage.heard.signedIn, 1)
        XCTAssertFalse(stage.everything.contains("CANARY"))
    }

    func testGooglesClosureReturningNothingIsSaidQuietly() async throws {
        let calls = Calls()
        let stage = try await withGoogle(calls) { _ in nil }
        await stage.model.useProvider(.google)
        XCTAssertEqual(stage.model.notice, "Sign-in was cancelled. Nothing was changed; you can try again.")
        XCTAssertNil(stage.model.formError)
        XCTAssertEqual(stage.api.count(Wire.idTokenExchange), 0, "no token, no exchange")
        XCTAssertFalse(stage.model.isPending)
        XCTAssertEqual(stage.heard.signedIn, 0)
        // And the button works again.
        await stage.model.useProvider(.google)
        XCTAssertEqual(calls.seen.count, 2)
    }

    func testWhatGooglesClosureThrowsIsSaidInFixedWordsAndNothingOfItIsKept() async throws {
        let calls = Calls()
        let stage = try await withGoogle(calls) { _ in throw LoudSheetFailure() }
        await stage.model.useProvider(.google)
        XCTAssertEqual(stage.model.formError, "The sign-in could not be shown. Try again.")
        XCTAssertEqual(stage.heard.said, ["The sign-in could not be shown. Try again."])
        XCTAssertNil(stage.model.notice)
        XCTAssertFalse(stage.model.isPending)
        XCTAssertEqual(stage.api.count(Wire.idTokenExchange), 0)
        var dumped = ""
        dump(stage.model, to: &dumped)
        XCTAssertFalse((stage.everything + dumped).contains(LoudSheetFailure.text))
        XCTAssertEqual(stage.model.screen, .signInStart)
    }

    func testAGoogleTokenTheServerRefusedAndAStartThatFailed() async throws {
        let stage = try await withGoogle(Calls()) { _ in "CANARY-google-token" }
        stage.api.on(Wire.idTokenExchange, Reply.error(401, "auth.invalid_credentials"))
        await stage.model.useProvider(.google)
        XCTAssertEqual(stage.model.formError, "We could not sign you in. Nothing was changed; start again.")
        XCTAssertEqual(stage.model.fieldErrors, [:])
        XCTAssertFalse(stage.everything.contains("CANARY"))

        // The start itself refused: the sheet is never shown.
        let calls = Calls()
        let off = try await withGoogle(calls) { _ in "CANARY-google-token" }
        off.api.on(Wire.idTokens, Reply.error(403, "auth.method_disabled"))
        off.api.on(Wire.idTokens, Reply.error(403, "auth.method_disabled"))
        await off.model.useProvider(.google)
        await off.model.useProvider(.google)
        XCTAssertNotNil(off.model.formError)
        XCTAssertFalse(off.model.textedOff, "nothing here is a texted code")
        XCTAssertEqual(off.model.screen, .signInStart)
    }

    func testGooglesSheetClosedAfterItsScreenWasLeftSaysNothing() async throws {
        let gate = Gate()
        let calls = Calls()
        let stage = try await withGoogle(calls) { _ in
            await gate.wait()
            throw LoudSheetFailure()
        }
        let asking = Task { await stage.model.useProvider(.google) }
        await eventually("the sheet is out") { calls.seen.count == 1 }
        stage.model.showSignUp()
        gate.open()
        await asking.value
        XCTAssertNil(stage.model.formError)
        XCTAssertEqual(stage.model.screen, .signUpStart)
    }

    // MARK: A provider's page in the system's browser

    private func withBrowser(
        _ browser: ScriptedBrowser, storage: any TulaTokenStorage = MemoryTokenStorage()
    ) async throws -> Stage {
        let stage = try Stage(storage: storage, browser: browser, options: TulaAuthOptions(redirectURL: Wire.redirect))
        await stage.configure(methods: ["password"], oauth: ["github", "google", "apple"])
        stage.api.on(Wire.oauth, Wire.oauthStarted)
        return stage
    }

    func testAProvidersPageSignsIn() async throws {
        let browser = ScriptedBrowser()
        browser.returns(fragment: Wire.ticket)
        let stage = try await withBrowser(browser)
        stage.api.on(Wire.oauthExchange, Wire.flow("sign_in", Wire.complete))
        await stage.model.perform(.useProvider(.github))
        XCTAssertEqual(browser.opened.count, 1)
        XCTAssertEqual(browser.opened.first?.redirect, Wire.redirect)
        XCTAssertEqual(stage.api.body(Wire.oauth)["provider"] as? String, "github")
        XCTAssertEqual(stage.api.body(Wire.oauth)["redirectUrl"] as? String, Wire.redirect)
        XCTAssertEqual(stage.api.body(Wire.oauthExchange)["ticket"] as? String, "CANARY-ticket")
        XCTAssertEqual(stage.model.screen, .signedIn)
        XCTAssertEqual(stage.heard.signedIn, 1)
        XCTAssertFalse(stage.everything.contains("CANARY"))

        // Without their own sheets Apple and Google go through the browser too.
        for provider in [OAuthProvider.apple, .google] {
            let other = ScriptedBrowser()
            other.returns(fragment: Wire.ticket)
            let through = try await withBrowser(other)
            through.api.on(Wire.oauthExchange, Wire.flow("sign_in", Wire.complete))
            await through.model.useProvider(provider)
            XCTAssertEqual(through.api.body(Wire.oauth)["provider"] as? String, provider.rawValue)
            XCTAssertEqual(through.api.count(Wire.idTokens), 0)
            XCTAssertEqual(through.model.screen, .signedIn)
        }
    }

    func testAProviderSignInThatNeedsAnotherStepGoesOnToIt() async throws {
        let browser = ScriptedBrowser()
        browser.returns(fragment: Wire.ticket)
        let stage = try await withBrowser(browser)
        stage.api.on(Wire.oauthExchange, Wire.flow("sign_in", Wire.secondFactor, start: true))
        await stage.model.useProvider(.github)
        XCTAssertEqual(stage.model.screen, .secondFactor(.totp, others: [.backupCode], sent: nil))
        XCTAssertEqual(stage.heard.signedIn, 0)
        stage.api.on(Wire.secondFactorRoute, Wire.flow("sign_in", Wire.complete))
        stage.model.code = "123456"
        await stage.model.submitCode()
        XCTAssertEqual(stage.model.screen, .signedIn)
        XCTAssertEqual(stage.heard.signedIn, 1)
    }

    func testAClosedBrowserIsSaidQuietly() async throws {
        let browser = ScriptedBrowser()
        let stage = try await withBrowser(browser)
        await stage.model.useProvider(.github)
        XCTAssertEqual(stage.model.notice, "Sign-in was cancelled. Nothing was changed; you can try again.")
        XCTAssertEqual(stage.heard.said.last, stage.model.notice)
        XCTAssertNil(stage.model.formError)
        XCTAssertFalse(stage.model.isPending)
        XCTAssertFalse(stage.model.canRetryProvider)
        XCTAssertEqual(stage.api.count(Wire.oauthExchange), 0)
        XCTAssertEqual(stage.heard.signedIn, 0)
        // And the button works again.
        browser.returns(fragment: Wire.ticket)
        stage.api.on(Wire.oauthExchange, Wire.flow("sign_in", Wire.complete))
        await stage.model.useProvider(.github)
        XCTAssertEqual(stage.model.screen, .signedIn)
    }

    func testWhatAProvidersPageCameBackWithAndCannotBeFinishedIsSaidAboveTheForm() async throws {
        let fallback = "We could not sign you in. Nothing was changed; start again."
        let denied = TulaStrings.english.message(code: "oauth.access_denied")
        XCTAssertNotEqual(denied, "Something went wrong. Try again.", "the contract has a sentence for it")
        let rows: [(String, String)] = [
            // A code of the contract: said by its sentence.
            ("\(Wire.redirect)#tula_error=oauth.access_denied&tula_attempt=att_1", denied),
            // Something that is not the address that was asked for, or holds no answer.
            ("https://evil.example/#\(Wire.ticket)", fallback), ("\(Wire.redirect)#other=1", fallback),
            ("\(Wire.redirect)#tula_ticket=t&tula_attempt=att_other", fallback),
        ]
        for (returned, words) in rows {
            let browser = ScriptedBrowser()
            browser.returns { _, _ in returned }
            let stage = try await withBrowser(browser)
            await stage.model.useProvider(.github)
            XCTAssertEqual(stage.model.formError, words, returned)
            XCTAssertEqual(stage.heard.said.last, words, returned)
            XCTAssertNil(stage.model.notice, returned)
            XCTAssertEqual(stage.api.count(Wire.oauthExchange), 0, "\(returned): refused without a request")
            XCTAssertFalse(stage.model.isPending, returned)
            XCTAssertFalse(stage.model.canRetryProvider, returned)
            XCTAssertEqual(stage.model.screen, .signInStart, returned)
            XCTAssertFalse(stage.everything.contains("evil.example"), returned)
        }

        // A code the page made up is not a code of the contract, and is never shown.
        let browser = ScriptedBrowser()
        browser.returns(fragment: "tula_error=CANARY%20made%20up")
        let stage = try await withBrowser(browser)
        await stage.model.useProvider(.github)
        XCTAssertNotNil(stage.model.formError)
        XCTAssertFalse(stage.everything.contains("CANARY"))

        // The server's refusal of the redirect URL is the server's to say, by its code.
        let unlisted = try await withBrowser(ScriptedBrowser())
        unlisted.api.on(Wire.oauth, Reply.error(400, "request.redirect_not_allowed"))
        unlisted.api.on(Wire.oauth, Reply.error(400, "request.redirect_not_allowed"))
        await unlisted.model.useProvider(.github)
        await unlisted.model.useProvider(.github)
        XCTAssertNotNil(unlisted.model.formError)
        XCTAssertFalse(unlisted.model.canRetryProvider, "nothing was shown: nothing to send again")
        XCTAssertFalse(unlisted.shown.contains(Canary.serverText))
    }

    func testAnAnswerThatWasLostCanBeSentAgainWithoutAnotherTripToTheProvider() async throws {
        let browser = ScriptedBrowser()
        browser.returns(fragment: Wire.ticket)
        let stage = try await withBrowser(browser)
        stage.api.on(Wire.oauthExchange) { _ in throw URLError(.notConnectedToInternet) }
        await stage.model.useProvider(.github)
        XCTAssertEqual(stage.model.formError, "Could not reach the server. Check your connection and try again.")
        XCTAssertTrue(stage.model.canRetryProvider)
        XCTAssertFalse(stage.model.isPending)
        XCTAssertEqual(
            stage.model.content.links.first, Offer("providerRetry", "Try again", .retryProvider),
            "the link is drawn while there is something to send again")
        XCTAssertEqual(stage.model.screen, .signInStart)

        // Sent again and limited: still there, with the wait in words.
        stage.api.on(Wire.oauthExchange, Reply.error(429, "rate_limited", headers: ["retry-after": "2"]))
        await stage.model.perform(.retryProvider)
        XCTAssertTrue(stage.model.canRetryProvider)
        XCTAssertTrue(stage.model.formError?.hasSuffix("Try again in 2s.") == true, stage.model.formError ?? "")

        stage.api.on(Wire.oauthExchange, Wire.flow("sign_in", Wire.complete))
        await stage.model.perform(.retryProvider)
        XCTAssertEqual(stage.api.count(Wire.oauthExchange), 3)
        XCTAssertEqual(stage.api.body(Wire.oauthExchange, 2)["ticket"] as? String, "CANARY-ticket")
        XCTAssertEqual(browser.opened.count, 1, "a retry opens no browser")
        XCTAssertEqual(stage.model.screen, .signedIn)
        XCTAssertEqual(stage.heard.signedIn, 1)
        XCTAssertFalse(stage.model.canRetryProvider)
        XCTAssertFalse(stage.everything.contains("CANARY"))
    }

    func testTryAgainGoesOnceTheTicketWasAnsweredOrItsScreenWasLeft() async throws {
        func lost() async throws -> (Stage, ScriptedBrowser) {
            let browser = ScriptedBrowser()
            browser.returns(fragment: Wire.ticket)
            let stage = try await withBrowser(browser)
            stage.api.on(Wire.oauthExchange) { _ in throw URLError(.timedOut) }
            await stage.model.useProvider(.github)
            XCTAssertTrue(stage.model.canRetryProvider)
            return (stage, browser)
        }

        // An answer about the ticket that is not a sign-in: the client has forgotten the
        // ticket, so the link would only ever say "could not sign you in".
        let (answered, _) = try await lost()
        answered.api.on(Wire.oauthExchange, Reply.error(500, "internal"))
        await answered.model.retryProvider()
        XCTAssertNotNil(answered.model.formError)
        XCTAssertFalse(answered.model.canRetryProvider)
        XCTAssertFalse(answered.model.content.actions.contains(.retryProvider))

        let (refused, _) = try await lost()
        refused.api.on(Wire.oauthExchange, Reply.error(409, "oauth.account_exists"))
        await refused.model.retryProvider()
        XCTAssertEqual(refused.model.formError, TulaStrings.english.message(code: "oauth.account_exists"))
        XCTAssertFalse(refused.model.canRetryProvider)

        // Left: the ticket is for a sign-in nobody is on any more, and the client drops it.
        let (left, browser) = try await lost()
        left.model.showSignUp()
        XCTAssertFalse(left.model.canRetryProvider)
        left.model.showSignIn()
        XCTAssertFalse(left.model.content.actions.contains(.retryProvider))
        let sent = left.api.count(Wire.oauthExchange)
        await left.model.retryProvider()
        await left.model.perform(.retryProvider)
        XCTAssertEqual(left.api.count(Wire.oauthExchange), sent)
        guard case .refused = try await left.client.retryProviderSignIn() else {
            return XCTFail("the client still held a ticket of a screen that was left")
        }
        XCTAssertEqual(left.api.count(Wire.oauthExchange), sent)
        XCTAssertEqual(browser.opened.count, 1)

        // Closed, the same.
        let (closed, _) = try await lost()
        closed.model.close()
        XCTAssertFalse(closed.model.canRetryProvider)
    }

    func testAProvidersPageAnsweredAfterItsScreenWasLeft() async throws {
        // A sign-in that needs another step is nobody's: discarded, and nothing is shown.
        let gate = Gate()
        let browser = ScriptedBrowser()
        browser.returns { _, redirect in
            await gate.wait()
            return "\(redirect)#\(Wire.ticket)"
        }
        let stage = try await withBrowser(browser)
        stage.api.on(Wire.oauthExchange, Wire.flow("sign_in", Wire.secondFactor, start: true))
        let asking = Task { await stage.model.useProvider(.github) }
        await eventually("the page is out") { browser.opened.count == 1 }
        stage.model.showSignUp()
        gate.open()
        await asking.value
        XCTAssertEqual(stage.model.screen, .signUpStart)
        XCTAssertEqual(stage.heard.signedIn, 0)

        // One that was closed, and one whose answer was lost: nothing is said, and nothing
        // is offered again.
        for lost in [false, true] {
            let held = Gate()
            let page = ScriptedBrowser()
            page.returns { _, redirect in
                await held.wait()
                return lost ? "\(redirect)#\(Wire.ticket)" : nil
            }
            let left = try await withBrowser(page)
            left.api.on(Wire.oauthExchange) { _ in throw URLError(.timedOut) }
            let going = Task { await left.model.useProvider(.github) }
            await eventually("the page is out") { page.opened.count == 1 }
            left.model.showSignUp()
            held.open()
            await going.value
            XCTAssertNil(left.model.notice)
            XCTAssertNil(left.model.formError)
            XCTAssertFalse(left.model.canRetryProvider)
        }

        // One that completed: somebody is signed in, and the app is told.
        let last = Gate()
        let done = ScriptedBrowser()
        done.returns { _, redirect in
            await last.wait()
            return "\(redirect)#\(Wire.ticket)"
        }
        let signed = try await withBrowser(done)
        signed.api.on(Wire.oauthExchange, Wire.flow("sign_in", Wire.complete))
        let signing = Task { await signed.model.useProvider(.github) }
        await eventually("the page is out") { done.opened.count == 1 }
        signed.model.close()
        last.open()
        await signing.value
        XCTAssertEqual(signed.model.screen, .signedIn)
        XCTAssertEqual(signed.heard.signedIn, 1)
    }

    // MARK: A session that could not be stored

    func testASignInThroughASheetOrAPageIsSignedInAlsoWhenItsSessionCouldNotBeStored() async throws {
        let browser = ScriptedBrowser()
        browser.returns(fragment: Wire.ticket)
        let rows: [(String, String, (any TulaTokenStorage) async throws -> Stage, @MainActor (TulaAuthModel) async -> Void)] = [
            (
                "a passkey", Wire.passkeySubmit, { try await self.withPasskeys(ScriptedPasskeySheet(), storage: $0) },
                { await $0.usePasskey() }
            ),
            (
                "Apple's sheet", Wire.idTokenExchange, { try await self.withApple(ScriptedAppleSheet(), storage: $0) },
                { await $0.useProvider(.apple) }
            ),
            (
                "Google's sheet", Wire.idTokenExchange,
                { try await self.withGoogle(Calls(), storage: $0) { _ in "token" } }, { await $0.useProvider(.google) }
            ),
            (
                "a provider's page", Wire.oauthExchange, { try await self.withBrowser(browser, storage: $0) },
                { await $0.useProvider(.github) }
            ),
        ]
        for (name, route, make, finish) in rows {
            let storage = RefusingStorage()
            let stage = try await make(storage)
            stage.api.on(route, Wire.flow("sign_in", Wire.complete))
            await finish(stage.model)
            let refused = await storage.refused
            XCTAssertEqual(refused, 1, name)
            let signedIn = await stage.isSignedIn
            XCTAssertTrue(signedIn, name)
            XCTAssertEqual(stage.model.screen, .signedIn, name)
            XCTAssertEqual(stage.heard.signedIn, 1, name)
            XCTAssertEqual(stage.model.formError, stage.model.strings.sessionNotSaved, name)
            XCTAssertFalse(stage.model.isPending, name)
            XCTAssertFalse(stage.model.canRetryProvider, name)
        }
    }
}
