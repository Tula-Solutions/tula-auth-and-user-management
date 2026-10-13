import Foundation
import TulaAuth
import XCTest

@testable import TulaAuthUI

// What every screen offers and what each offer does. A view draws this and nothing else,
// so this table is the test of which buttons a step has.
@MainActor
final class ContentTests: XCTestCase {
    private typealias Field = TulaAuthFieldContent
    private typealias Offer = TulaAuthOffer

    private static let identity = Offer("change", "Change", .showSignIn, lead: "Signing in as maya@example.com")

    private static func address(_ submit: TulaAuthAction) -> Field {
        Field(field: .email, kind: .email, label: "Email address", hint: nil, submit: submit)
    }

    private static func code(_ submit: TulaAuthAction) -> Field {
        Field(field: .code, kind: .code, label: "Verification code", hint: "6 digits", submit: submit)
    }

    private static func chosen(_ submit: TulaAuthAction) -> Field {
        Field(field: .newPassword, kind: .newPassword, label: "New password", hint: nil, submit: submit)
    }

    /// One screen of every case, with each case's variants. The `switch` in `expected` has
    /// no `default`: a new case does not compile until it has a row.
    private static let screens: [TulaAuthScreen] = [
        .signInStart, .signUpStart, .resetStart, .password(canEmailCode: false), .password(canEmailCode: true),
        .emailCodeOffer, .emailCode(destination: "m***@example.com", canUsePassword: false),
        .emailCode(destination: "m***@example.com", canUsePassword: true),
        .emailVerification(destination: "m***@example.com"), .newPassword(destination: "m***@example.com"),
        .expiredPassword, .signedIn, .notSupported(status: "needs_second_factor"),
    ]

    private static func expected(_ screen: TulaAuthScreen) -> TulaAuthContent {
        switch screen {
        case .signInStart:
            return TulaAuthContent(
                title: "Sign in", subtitle: "to continue to Acme", fields: [address(.start)],
                primary: Offer(primary: "Continue", .start),
                links: [Offer("signUp", "Create an account", .showSignUp, lead: "New here?")])
        case .signUpStart:
            return TulaAuthContent(
                title: "Create your account", subtitle: "Welcome! Sign up to get started.",
                fields: [
                    address(.start),
                    Field(field: .password, kind: .newPassword, label: "Password", hint: nil, submit: .start),
                ],
                primary: Offer(primary: "Continue", .start),
                links: [Offer("signIn", "Sign in", .showSignIn, lead: "Already have an account?")])
        case .resetStart:
            return TulaAuthContent(
                title: "Reset your password", subtitle: "Enter your email address and we will send you a code.",
                fields: [address(.start)], primary: Offer(primary: "Send code", .start),
                links: [Offer("signIn", "Back to sign in", .showSignIn)])
        case .password(let canEmailCode):
            return TulaAuthContent(
                title: "Enter your password", identity: identity,
                fields: [
                    Field(field: .password, kind: .password, label: "Password", hint: nil, submit: .submitPassword)
                ],
                primary: Offer(primary: "Sign in", .submitPassword),
                links: (canEmailCode ? [Offer("emailCode", "Email me a code", .sendEmailCode)] : [])
                    + [Offer("reset", "Forgot password?", .showReset)])
        case .emailCodeOffer:
            return TulaAuthContent(
                title: "Check your email", subtitle: "We will email you a 6-digit code to sign in with.",
                identity: identity, primary: Offer(primary: "Email me a code", .sendEmailCode))
        case .emailCode(_, let canUsePassword):
            return TulaAuthContent(
                title: "Check your email", subtitle: "Enter the 6-digit code we sent to m***@example.com.",
                identity: identity, fields: [code(.submitCode)], primary: Offer(primary: "Sign in", .submitCode),
                links: [Offer("resend", "Send a new email", .resendCode)]
                    + (canUsePassword ? [Offer("password", "Use your password", .usePassword)] : []))
        case .emailVerification:
            return TulaAuthContent(
                title: "Check your email", subtitle: "Enter the 6-digit code we sent to m***@example.com.",
                fields: [code(.submitCode)], primary: Offer(primary: "Verify", .submitCode),
                links: [Offer("resend", "Resend code", .resendCode), Offer("back", "Back", .startAgain)])
        case .newPassword:
            return TulaAuthContent(
                title: "Choose a new password",
                subtitle: "Enter the 6-digit code we sent to m***@example.com and a new password.",
                fields: [code(.submitNewPassword), chosen(.submitNewPassword)],
                primary: Offer(primary: "Reset password", .submitNewPassword),
                links: [Offer("resend", "Resend code", .resendCode), Offer("signIn", "Back to sign in", .showSignIn)])
        case .expiredPassword:
            return TulaAuthContent(
                title: "Your password has expired", subtitle: "Choose a new password to finish signing in.",
                fields: [chosen(.submitNewPassword)],
                primary: Offer(primary: "Save password and sign in", .submitNewPassword))
        case .signedIn:
            return TulaAuthContent(title: "You are signed in.")
        case .notSupported:
            return TulaAuthContent(
                title: "This step is not supported",
                subtitle: "This version of the app cannot continue this sign-in. Update the app, or sign in another way.",
                primary: Offer(primary: "Start again", .startAgain))
        }
    }

    func testWhatEveryScreenOffersAndWhatEachOfferDoes() {
        for screen in ContentTests.screens {
            let content = TulaAuthContent(
                screen: screen, strings: .english, appName: "Acme", passwordOptional: false, email: "maya@example.com")
            XCTAssertEqual(content, ContentTests.expected(screen), "\(screen)")
            // The fields are the screen's own, in its order, and the keyboard's "go" is the
            // main button.
            XCTAssertEqual(content.fields.map(\.field), screen.fields, "\(screen)")
            for field in content.fields {
                XCTAssertEqual(field.submit, content.primary?.action, "\(screen)")
            }
            XCTAssertEqual(
                Set((content.links + [content.identity].compactMap { $0 }).map(\.identifier)).count,
                content.links.count + (content.identity == nil ? 0 : 1), "a control is found by its identifier")
            XCTAssertEqual(content.primary?.identifier, content.primary == nil ? nil : "tula.primary")
        }
    }

    func testTheWordsThatDependOnTheEnvironment() {
        let unnamed = TulaAuthContent(screen: .signInStart, strings: .english)
        XCTAssertEqual(unnamed.subtitle, "Welcome back")
        let optional = TulaAuthContent(screen: .signUpStart, strings: .english, passwordOptional: true)
        XCTAssertEqual(optional.fields.last?.label, "Password (optional)")
        XCTAssertEqual(optional.fields.last?.hint, "Leave it empty to sign in with a code we email you instead.")

        var strings = TulaStrings.english
        strings.signInSubmit = "Weiter"
        strings.signingInAs = "Anmelden als {email}"
        let worded = TulaAuthContent(screen: .password(canEmailCode: false), strings: strings, email: "{appName}")
        XCTAssertEqual(worded.primary?.title, "Weiter")
        XCTAssertEqual(worded.identity?.lead, "Anmelden als {appName}", "a value is put in once and not read again")
    }

    func testASignedInScreenAndNoOtherOffersNothing() {
        for screen in ContentTests.screens {
            let actions = TulaAuthContent(screen: screen, strings: .english).actions
            XCTAssertEqual(actions.isEmpty, screen == .signedIn, "\(screen)")
        }
    }

    // MARK: What each action does

    func testEveryActionIsPerformedThroughTheOneDoor() async throws {
        let start = try Stage()
        start.api.on(Wire.signIns, Wire.flow("sign_in", Wire.needsPassword, start: true))
        start.model.email = "maya@example.com"
        await start.model.perform(.start)
        XCTAssertEqual(start.api.count(Wire.signIns), 1)
        XCTAssertEqual(start.model.screen, .password(canEmailCode: false))

        start.api.on(Wire.password, Reply.error(401, "auth.invalid_credentials"))
        start.model.password = Canary.password
        await start.model.perform(.submitPassword)
        XCTAssertEqual(start.api.count(Wire.password), 1)
        await start.model.perform(.showReset)
        XCTAssertEqual(start.model.screen, .resetStart)
        await start.model.perform(.showSignIn)
        XCTAssertEqual(start.model.screen, .signInStart)
        await start.model.perform(.showSignUp)
        XCTAssertEqual(start.model.screen, .signUpStart)

        let both = try Stage()
        await both.signIn(to: Wire.both)
        both.api.on(Wire.prepare, Wire.flow("sign_in", Wire.bothPrepared))
        await both.model.perform(.sendEmailCode)
        XCTAssertEqual(both.api.count(Wire.prepare), 1)
        XCTAssertEqual(both.model.screen, .emailCode(destination: "m***@example.com", canUsePassword: true))
        await both.model.perform(.resendCode)
        XCTAssertEqual(both.api.count(Wire.prepare), 2)
        XCTAssertEqual(both.model.status, "A new email is on its way.")
        both.api.on(Wire.attempt, Reply.error(401, "auth.invalid_credentials"))
        both.model.setText("12 34 56 78", of: .code)
        XCTAssertEqual(both.model.text(of: .code), "123456")
        await both.model.perform(.submitCode)
        XCTAssertEqual(both.api.body(Wire.attempt)["code"] as? String, "123456")
        await both.model.perform(.usePassword)
        XCTAssertEqual(both.model.screen, .password(canEmailCode: true))

        let reset = try Stage()
        reset.model.showReset()
        reset.api.on(Wire.resets, Wire.flow("password_reset", Wire.reset, start: true))
        reset.model.setText("maya@example.com", of: .email)
        await reset.model.perform(.start)
        reset.api.on(Wire.resetSubmit, Reply.error(422, "password.too_short"))
        reset.model.setText("123456", of: .code)
        reset.model.setText("short", of: .newPassword)
        await reset.model.perform(.submitNewPassword)
        XCTAssertEqual(reset.api.count(Wire.resetSubmit), 1)
        XCTAssertEqual(reset.model.text(of: .newPassword), "short")

        let unknown = try Stage()
        await unknown.signIn(to: Wire.secondFactor)
        XCTAssertEqual(unknown.model.screen, .notSupported(status: "needs_second_factor"))
        await unknown.model.perform(.startAgain)
        XCTAssertEqual(unknown.model.screen, .signInStart)
    }

    func testAnActionTheOpenScreenDoesNotOfferDoesNothing() async throws {
        // On the password step: nothing a link of another screen does can be asked for.
        let stage = try Stage()
        await stage.signIn(to: Wire.needsPassword)
        stage.model.setText(Canary.password, of: .password)
        let offered = stage.model.content.actions
        XCTAssertEqual(offered, [.submitPassword, .showReset, .showSignIn])
        let before = stage.api.routes
        for action in TulaAuthAction.allCases where !offered.contains(action) {
            await stage.model.perform(action)
            XCTAssertEqual(stage.model.screen, .password(canEmailCode: false), "\(action)")
            XCTAssertEqual(stage.api.routes, before, "\(action)")
            XCTAssertNil(stage.model.formError, "\(action)")
            XCTAssertEqual(stage.model.fieldErrors, [:], "\(action)")
            XCTAssertEqual(stage.model.text(of: .password), Canary.password, "\(action)")
        }

        // On a step with no screen: no action of the model sends anything.
        let unknown = try Stage()
        await unknown.signIn(to: Wire.secondFactor)
        let sent = unknown.api.routes
        for action in TulaAuthAction.allCases where action != .startAgain {
            await unknown.model.perform(action)
        }
        XCTAssertEqual(unknown.api.routes, sent)
        XCTAssertEqual(unknown.model.screen, .notSupported(status: "needs_second_factor"))
    }

    // MARK: What a view reads for a problem

    func testAProblemIsWordedAsOneForTheEyeAndForVoiceOver() async throws {
        let stage = try Stage()
        await stage.signIn(to: Wire.needsPassword)
        let field = try XCTUnwrap(stage.model.content.fields.first)
        XCTAssertEqual(stage.model.spokenLabel(of: field), "Password")
        XCTAssertEqual(stage.model.problems(of: .password), [])
        XCTAssertNil(stage.model.formProblem)

        await stage.model.perform(.submitPassword)
        XCTAssertEqual(stage.model.problems(of: .password), ["Error: This field is required."])
        XCTAssertEqual(stage.model.spokenLabel(of: field), "Password, invalid: This field is required.")

        stage.api.on(Wire.password, Reply.error(503, "service.unavailable"))
        stage.model.password = Canary.password
        await stage.model.perform(.submitPassword)
        XCTAssertEqual(stage.model.formProblem, stage.model.formError.map { "Error: \($0)" })
        XCTAssertNotNil(stage.model.formProblem)

        var strings = TulaStrings.english
        strings.errorPrefix = "Fehler: {message}"
        strings.fieldInvalid = "{label}: {message}"
        let worded = try Stage(strings: strings)
        await worded.model.perform(.start)
        let address = try XCTUnwrap(worded.model.content.fields.first)
        XCTAssertEqual(worded.model.problems(of: .email), ["Fehler: This field is required."])
        XCTAssertEqual(worded.model.spokenLabel(of: address), "Email address: This field is required.")
    }

    // MARK: No button is silent

    func testTheMainButtonOfAClosedScreenSaysWhatIsMissing() async throws {
        let stage = try Stage()
        await stage.signIn(to: Wire.needsPassword)
        stage.model.close()
        let primary = try XCTUnwrap(stage.model.content.primary)
        XCTAssertEqual(primary.action, .start, "a closed screen offers the start, not the step it was on")
        await stage.model.perform(primary.action)
        XCTAssertEqual(stage.model.fieldErrors[.email], ["This field is required."])
        XCTAssertEqual(stage.heard.said.last, "This field is required.")

        // And with an address it signs in: the view that came back works.
        stage.api.on(Wire.signIns, Wire.flow("sign_in", Wire.needsPassword, start: true))
        stage.model.email = "maya@example.com"
        await stage.model.perform(primary.action)
        XCTAssertEqual(stage.model.screen, .password(canEmailCode: false))
        XCTAssertEqual(stage.api.count(Wire.signIns), 2)
    }

    func testAnActionWhoseFlowIsGoneLandsOnTheStartWithWords() async throws {
        // Nothing in the model leaves a step open without its flow; `leave()` alone does,
        // and only a test calls it alone. What is pinned is that such a button, should one
        // ever be reached, says so instead of doing nothing.
        func password() async throws -> Stage {
            let stage = try Stage()
            await stage.signIn(to: Wire.both)
            return stage
        }
        func emailed() async throws -> Stage {
            let stage = try Stage()
            await stage.signIn(to: Wire.codeOnlyPrepared)
            return stage
        }
        func signUp() async throws -> Stage {
            let stage = try Stage(mode: .signUp)
            stage.api.on(Wire.signUps, Wire.flow("sign_up", Wire.verification, start: true))
            stage.model.email = "maya@example.com"
            stage.model.password = Canary.password
            await stage.model.start()
            return stage
        }
        func reset() async throws -> Stage {
            let stage = try Stage()
            stage.model.showReset()
            stage.api.on(Wire.resets, Wire.flow("password_reset", Wire.reset, start: true))
            stage.model.email = "maya@example.com"
            await stage.model.start()
            return stage
        }
        func expired() async throws -> Stage {
            let stage = try Stage()
            await stage.signIn(to: Wire.needsPassword)
            stage.api.on(Wire.password, Wire.flow("sign_in", Wire.expired))
            stage.model.password = Canary.password
            await stage.model.submitPassword()
            XCTAssertEqual(stage.model.screen, .expiredPassword)
            return stage
        }
        let rows: [(String, () async throws -> Stage, TulaAuthAction, TulaAuthScreen)] = [
            ("the password", password, .submitPassword, .signInStart),
            ("asking for a code", password, .sendEmailCode, .signInStart),
            ("a sign-in code", emailed, .submitCode, .signInStart),
            ("another sign-in email", emailed, .resendCode, .signInStart),
            ("a sign-up's code", signUp, .submitCode, .signUpStart),
            ("another sign-up code", signUp, .resendCode, .signUpStart),
            ("a reset", reset, .submitNewPassword, .resetStart),
            ("another reset code", reset, .resendCode, .resetStart),
            ("an expired password", expired, .submitNewPassword, .signInStart),
        ]
        for (name, make, action, start) in rows {
            let stage = try await make()
            XCTAssertTrue(stage.model.content.actions.contains(action), name)
            stage.model.leave()
            let sent = stage.api.routes
            stage.model.setText("123456", of: .code)
            stage.model.setText(Canary.password, of: .password)
            stage.model.setText(Canary.password, of: .newPassword)
            await stage.model.perform(action)
            XCTAssertEqual(stage.model.screen, start, name)
            XCTAssertEqual(stage.model.formError, "That attempt is no longer open. Start again.", name)
            XCTAssertEqual(stage.heard.said.last, "That attempt is no longer open. Start again.", name)
            XCTAssertEqual(stage.api.routes, sent, "\(name): nothing is sent on a guess")
            XCTAssertEqual(
                [stage.model.password, stage.model.code, stage.model.newPassword], ["", "", ""], name)
            XCTAssertFalse(stage.model.isPending, name)
        }
    }

    func testAStartThatCompletedWhileItsScreenWasLeftIsSaidNotDiscarded() async throws {
        // A start can complete at once. Left while its session was being stored, the
        // attempt cannot be discarded: the client is signed in.
        let gate = Gate()
        let storage = HeldStorage(gate)
        let stage = try Stage(mode: .signUp, storage: storage)
        stage.api.on(Wire.signUps, Wire.flow("sign_up", Wire.complete, start: true))
        stage.model.email = "maya@example.com"
        stage.model.password = Canary.password
        let starting = Task { await stage.model.start() }
        await eventually("the session is being stored") { await storage.writes == 1 }
        stage.model.showSignIn()
        gate.open()
        await starting.value
        let signedIn = await stage.isSignedIn
        XCTAssertTrue(signedIn)
        XCTAssertEqual(stage.model.screen, .signedIn)
        XCTAssertEqual(stage.heard.signedIn, 1)
    }
}

// The contrast of the default theme, computed from the values the screens draw with: what
// the simulator's audit measures from pixels, held here from the numbers.
final class ThemeContrastTests: XCTestCase {
    /// The relative luminance of a colour (WCAG 2.x), for a colour that is opaque.
    private func luminance(_ colour: TulaColorValue) -> Double {
        func linear(_ channel: Double) -> Double {
            channel <= 0.04045 ? channel / 12.92 : pow((channel + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(colour.red) + 0.7152 * linear(colour.green) + 0.0722 * linear(colour.blue)
    }

    private func contrast(_ one: TulaColorValue, _ other: TulaColorValue) -> Double {
        let (light, dark) = (max(luminance(one), luminance(other)), min(luminance(one), luminance(other)))
        return (light + 0.05) / (dark + 0.05)
    }

    func testTheArithmeticIsWcags() {
        let black = TulaColorValue(red: 0, green: 0, blue: 0, opacity: 1)
        let white = TulaColorValue(red: 1, green: 1, blue: 1, opacity: 1)
        XCTAssertEqual(contrast(black, white), 21, accuracy: 0.001)
        XCTAssertEqual(contrast(white, white), 1, accuracy: 0.001)
        // #767676 on white is the textbook 4.54:1.
        let grey = TulaColorValue(red: 118 / 255, green: 118 / 255, blue: 118 / 255, opacity: 1)
        XCTAssertEqual(contrast(grey, white), 4.54, accuracy: 0.01)
    }

    func testEveryTextOfTheDefaultThemeHasContrastOnWhatItIsDrawnOnInBothSchemes() {
        let theme = TulaResolvedTheme.defaults
        for (name, scheme) in [("light", theme.light), ("dark", theme.dark)] {
            // Text and the surface a screen draws it on: 4.5 to 1 (WCAG 1.4.3).
            let text: [(String, TulaColorValue, TulaColorValue)] = [
                ("the title and the labels on the background", scheme.text, scheme.background),
                ("what is typed, in a field", scheme.text, scheme.input),
                ("subtitles, hints and the last line on the background", scheme.textMuted, scheme.background),
                ("a link on the background", scheme.link, scheme.background),
                ("the main button's words", scheme.primaryText, scheme.primary),
                ("the main button's words while it is pressed", scheme.primaryText, scheme.primaryHover),
                ("a field's problem on the background", scheme.danger, scheme.background),
                ("the form's problem on its surface", scheme.danger, scheme.dangerSurface),
                ("a status on the background", scheme.success, scheme.background),
            ]
            for (what, front, behind) in text {
                XCTAssertEqual(front.opacity, 1, "\(name): \(what) is opaque")
                XCTAssertEqual(behind.opacity, 1, "\(name): \(what) is on something opaque")
                XCTAssertGreaterThanOrEqual(contrast(front, behind), 4.5, "\(name): \(what)")
            }
            // What is not text and must be told apart: 3 to 1 (WCAG 1.4.11).
            let edges: [(String, TulaColorValue, TulaColorValue)] = [
                ("a field's edge", scheme.borderStrong, scheme.background),
                ("the edge of the field with the focus", scheme.focus, scheme.background),
                ("the edge of a field with a problem", scheme.danger, scheme.input),
                ("the button that shows a password", scheme.textMuted, scheme.input),
            ]
            for (what, front, behind) in edges {
                XCTAssertGreaterThanOrEqual(contrast(front, behind), 3, "\(name): \(what)")
            }
        }
        // The pair the simulator's audit reported in the dark scheme, by the numbers.
        XCTAssertGreaterThan(contrast(theme.dark.textMuted, theme.dark.background), 7)
    }
}
