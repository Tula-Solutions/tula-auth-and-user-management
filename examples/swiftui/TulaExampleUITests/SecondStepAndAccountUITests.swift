import CryptoKit
import XCTest

// The second step, an authenticator app set up inside a sign-in, and the account screen
// (`TulaAccountView`), driven in the example app on a simulator against the real API, with
// the system's accessibility audit of each new screen in both colour schemes.
//
// The example gives its client no sheet, so no passkey sheet, no provider's sheet and no
// browser is shown by any of these tests: what they assert of a passkey is that its control
// is not drawn and that the account screen says so in words. VoiceOver is not run.

/// What an authenticator app shows for a setup key, at a time: RFC 6238 with the server's
/// defaults (SHA-1, 6 digits, 30 seconds).
enum AuthenticatorApp {
    static func code(_ setupKey: String, at time: Date) -> String {
        let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
        var bits = 0
        var value = 0
        var key = Data()
        for character in setupKey.uppercased() {
            guard let index = alphabet.firstIndex(of: character) else { continue }
            value = ((value << 5) | index) & 0xffff
            bits += 5
            if bits >= 8 {
                key.append(UInt8((value >> (bits - 8)) & 0xff))
                bits -= 8
            }
        }
        var counter = UInt64(time.timeIntervalSince1970 / 30).bigEndian
        let message = Data(bytes: &counter, count: 8)
        let mac = Array(HMAC<Insecure.SHA1>.authenticationCode(for: message, using: SymmetricKey(data: key)))
        let at = Int(mac[19] & 0x0f)
        let number =
            (UInt32(mac[at] & 0x7f) << 24) | (UInt32(mac[at + 1]) << 16) | (UInt32(mac[at + 2]) << 8)
            | UInt32(mac[at + 3])
        return String(format: "%06d", number % 1_000_000)
    }
}

final class SecondStepAndAccountUITests: ScreenTestCase {
    private func signIn(_ email: String) throws {
        try expectTitle("Sign in")
        try type(email, into: "email")
        try tapPrimary()
        try expectTitle("Enter your password")
        try type(World.password, into: "password")
        try tapPrimary()
    }

    /// The setup key the open screen shows, as a person would read it off.
    private func setupKey() throws -> String {
        let key = app.staticTexts["tula.setupKey"]
        guard key.waitForExistence(timeout: 10) else { throw SeamFailure("no setup key on the screen") }
        return key.label
    }

    /// Wait for a message of the screen, by its words.
    private func expectText(_ words: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(app.staticTexts[words].waitForExistence(timeout: 20), "not on the screen: \(words)", file: file, line: line)
    }

    private func setUpAuthenticator(audited: Bool) throws -> String {
        try expectTitle("Set up two-step verification")
        // Whichever screen asked for it shows the key, its QR code and the field.
        XCTAssertTrue(app.images["tula.qr"].waitForExistence(timeout: 10) || app.otherElements["tula.qr"].exists)
        if audited { try audit() }
        let key = try setupKey()
        try type(AuthenticatorApp.code(key, at: try world.now()), into: "code")
        try tapPrimary()
        try expectTitle("Save your backup codes")
        if audited { try audit() }
        return key
    }

    func testASignInThatSetsUpAnAuthenticatorAppShowsItsBackupCodesOnce() throws {
        let email = freshEmail()
        try world.account(email)
        try world.settings(["mfa": ["policy": "required"]])
        launch()
        try signIn(email)

        // The environment requires a second step and the account has none: said in words,
        // with the button that starts the setup. Nothing is asked of the server by arriving.
        try expectTitle("Set up two-step verification")
        try audit()
        try tapPrimary()
        let key = try setUpAuthenticator(audited: true)

        // The client is signed in by now, and the codes are still on the screen: the app is
        // told only when they are left.
        XCTAssertFalse(app.staticTexts["example.signedIn"].exists)
        XCTAssertTrue(app.buttons["tula.link.copyCodes"].exists)
        try tapPrimary()
        try expectSignedIn(as: email)
        try expectTitle("Account")

        // Signed out through the account screen, and in again: the second step is asked for.
        try tapLink("signOut")
        try signIn(email)
        try expectTitle("Two-step verification")
        try audit()

        // A wrong code is said at the field, in this screen's own words, and is not kept.
        let now = try world.now()
        let near = Set((-2...2).map { AuthenticatorApp.code(key, at: now.addingTimeInterval(Double($0) * 30)) })
        let wrong = ["000000", "111111", "222222", "333333"].first { !near.contains($0) } ?? "444444"
        try type(wrong, into: "code")
        try tapPrimary()
        let problem = NSPredicate(format: "label BEGINSWITH %@", "Error: ")
        XCTAssertTrue(app.staticTexts.matching(problem).firstMatch.waitForExistence(timeout: 20))
        XCTAssertEqual(field("code").value as? String ?? "", "")
        try audit()

        // A time step is accepted once: the app's next code, half a minute on.
        try world.advance(seconds: 60)
        try type(AuthenticatorApp.code(key, at: try world.now()), into: "code")
        try tapPrimary()
        try expectSignedIn(as: email)
    }

    func testTheAccountScreen() throws {
        let email = freshEmail()
        // The account is made by a client of this test's own: that session is "another
        // device" to the app's.
        try world.account(email)
        launch()
        try signIn(email)
        try expectSignedIn(as: email)
        try expectTitle("Account")

        // Where the user is signed in, with this device marked in words.
        expectText("This device")
        expectText("iPhone or iPad app")
        // The example gave its client no passkey sheet: no button, and the reason in words.
        XCTAssertFalse(app.buttons["tula.link.passkeyAdd"].exists)
        try audit()

        // A form that is cancelled says, quietly, that nothing was changed.
        try tapLink("changePassword")
        try expectTitle("Password")
        try audit()
        try tapLink("cancel")
        try expectTitle("Account")
        expectText("Nothing was changed.")

        try tapLink("signOutOthers")
        expectText("Signed out of 1 other device.")
        XCTAssertFalse(app.buttons["tula.link.signOutOthers"].exists)

        // An authenticator app, set up from the account: the same key, QR code and codes.
        try tapLink("turnOn")
        _ = try setUpAuthenticator(audited: false)
        XCTAssertTrue(app.buttons["tula.link.copyCodes"].exists)
        try tapPrimary()
        try expectTitle("Account")
        expectText("Two-step verification is on.")
        try audit()

        try tapLink("signOut")
        try expectTitle("Sign in")
    }

    func testTheAccountScreenAsksForProofWhereTheServerRequiresIt() throws {
        let email = freshEmail()
        try world.account(email)
        launch()
        try signIn(email)
        try expectTitle("Account")

        // An hour on, the sign-in is no longer recent: turning two-step verification on
        // needs proof that it is the user.
        try world.advance(seconds: 3600)
        try tapLink("turnOn")
        try expectTitle("Confirm it is you")
        try audit()

        // A wrong password is said at the field, and the step-up stays.
        try type("not-the-password-1!", into: "password")
        try tapPrimary()
        expectText("Error: That password is incorrect.")
        try expectTitle("Confirm it is you")

        // The right one: what was asked for is done, without being asked for again.
        try type(World.password, into: "password")
        try tapPrimary()
        try expectTitle("Set up two-step verification")
        try tapLink("cancel")
        try expectTitle("Account")
    }

    func testAPhoneNumberIsAddedWithATextedCode() throws {
        try world.settings(["sms": ["enabled": true, "allowedCountries": ["US"]]])
        let email = freshEmail()
        let number = "+14155550142"
        try world.account(email)
        launch()
        try signIn(email)
        try expectTitle("Account")

        try tapLink("phoneAdd")
        try expectTitle("Phone number")
        try audit()
        // Nothing is texted by opening the form.
        XCTAssertEqual(try world.texts(number).count, 0)
        try type(number, into: "phoneNumber")
        try tapPrimary()

        XCTAssertTrue(field("code").waitForExistence(timeout: 20))
        try audit()
        try type(try world.textedCode(number), into: "code")
        try tapPrimary()
        try expectTitle("Account")
        expectText("Your phone number was added.")
        // The number is said in its section, with what is known of it.
        let said = NSPredicate(format: "label CONTAINS %@", number)
        XCTAssertTrue(app.staticTexts.matching(said).firstMatch.waitForExistence(timeout: 10))
        try audit()
    }

    func testTheNewScreensInTheDarkScheme() throws {
        let email = freshEmail()
        try world.account(email)
        try world.settings(["mfa": ["policy": "required"]])
        launch(dark: true)
        try signIn(email)
        try expectTitle("Set up two-step verification")
        try audit()
        try tapPrimary()
        let key = try setUpAuthenticator(audited: true)
        try tapPrimary()
        try expectTitle("Account")
        try audit()

        try tapLink("changePassword")
        try expectTitle("Password")
        try audit()
        try tapLink("cancel")

        try tapLink("signOut")
        try signIn(email)
        try expectTitle("Two-step verification")
        try audit()
        try world.advance(seconds: 60)
        try type(AuthenticatorApp.code(key, at: try world.now()), into: "code")
        try tapPrimary()
        try expectSignedIn(as: email)
    }
}
