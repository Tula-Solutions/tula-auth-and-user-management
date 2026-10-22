import XCTest

// The screen captures of the documentation (docs/swift.md, "What the screens look like"): the
// same screens the other UI tests drive, photographed one by one in both colour schemes.
//
// These run only for `bun run native/swift/fixture/ui-tests.ts --screenshots <dir>`, which
// hands the directory over as TULA_CAPTURE_DIR; without it every test here is skipped, so a
// normal run is unchanged. Each picture is the simulator's own screenshot, named
// `<screen>.<step>.<theme>.png`; the script turns them into the files the documentation
// serves and writes the manifest that says what made them. Nothing is drawn or edited here.

final class CaptureUITests: ScreenTestCase {
    private var captureDirectory: URL?

    override func setUpWithError() throws {
        guard let directory = ProcessInfo.processInfo.environment["TULA_CAPTURE_DIR"], !directory.isEmpty else {
            throw XCTSkip("not a capture run: start it with `bun run native/swift/fixture/ui-tests.ts --screenshots <dir>`")
        }
        captureDirectory = URL(fileURLWithPath: directory)
        try super.setUpWithError()
    }

    /// Photograph the open screen once it has stopped moving and the keyboard is away.
    private func capture(_ screen: String, _ step: String, dark: Bool) throws {
        try putKeyboardAway()
        // The step's own transition and the focus ring settle in well under this.
        Thread.sleep(forTimeInterval: 0.8)
        let theme = dark ? "dark" : "light"
        let file = captureDirectory!.appendingPathComponent("\(screen).\(step).\(theme).png")
        try XCUIScreen.main.screenshot().pngRepresentation.write(to: file)
    }

    private func signIn(_ email: String) throws {
        try type(email, into: "email")
        try tapPrimary()
        try expectTitle("Enter your password")
        try type(World.password, into: "password")
        try tapPrimary()
    }

    // MARK: Tours

    private func tourSignInAndReset(dark: Bool) throws {
        let email = freshEmail()
        try world.account(email)
        launch(dark: dark)
        try expectTitle("Sign in")
        try capture("sign-in", "email", dark: dark)
        try type(email, into: "email")
        try tapPrimary()
        try expectTitle("Enter your password")
        try capture("sign-in", "password", dark: dark)
        try tapLink("reset")
        try expectTitle("Reset your password")
        try capture("reset", "request", dark: dark)
        try tapPrimary()
        try expectTitle("Choose a new password")
        try capture("reset", "new-password", dark: dark)
    }

    private func tourSignUp(dark: Bool) throws {
        let email = freshEmail()
        launch(dark: dark)
        try expectTitle("Sign in")
        try tapLink("signUp")
        try expectTitle("Create your account")
        try capture("sign-up", "create", dark: dark)
        try type(email, into: "email")
        try reveal("password")
        try type(World.password, into: "password")
        try tapPrimary()
        try expectTitle("Check your email")
        try capture("sign-up", "verify", dark: dark)
    }

    private func tourSecondStepAndAccount(dark: Bool) throws {
        let email = freshEmail()
        try world.account(email)
        try world.settings(["mfa": ["policy": "required"]])
        launch(dark: dark)
        try expectTitle("Sign in")
        try signIn(email)
        try expectTitle("Set up two-step verification")
        try capture("second-step", "setup", dark: dark)
        try tapPrimary()
        let key = app.staticTexts["tula.setupKey"]
        guard key.waitForExistence(timeout: 10) else { throw SeamFailure("no setup key on the screen") }
        try capture("second-step", "authenticator", dark: dark)
        try type(AuthenticatorApp.code(key.label, at: try world.now()), into: "code")
        try tapPrimary()
        try expectTitle("Save your backup codes")
        try capture("second-step", "backup-codes", dark: dark)
        try tapPrimary()
        try expectSignedIn(as: email)
        try expectTitle("Account")
        XCTAssertTrue(app.staticTexts["This device"].waitForExistence(timeout: 20))
        try capture("account", "overview", dark: dark)
        try tapLink("signOut")
        try expectTitle("Sign in")
        try signIn(email)
        try expectTitle("Two-step verification")
        try capture("second-step", "verify", dark: dark)
    }

    func testSignInAndResetLight() throws { try tourSignInAndReset(dark: false) }
    func testSignInAndResetDark() throws { try tourSignInAndReset(dark: true) }
    func testSignUpLight() throws { try tourSignUp(dark: false) }
    func testSignUpDark() throws { try tourSignUp(dark: true) }
    func testSecondStepAndAccountLight() throws { try tourSecondStepAndAccount(dark: false) }
    func testSecondStepAndAccountDark() throws { try tourSecondStepAndAccount(dark: true) }
}
