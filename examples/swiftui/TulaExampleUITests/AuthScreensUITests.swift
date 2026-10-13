import XCTest

// The Tula screens (`TulaAuthView`), driven in the example app on a simulator against the
// real API: every screen this version has, the "not supported" screen, and the system's
// accessibility audit of each in both colour schemes.
//
// What is asserted is what a person sees and what the server did. VoiceOver itself is not
// run by any of these tests.

final class AuthScreensUITests: ScreenTestCase {
    func testSignUpProvesTheAddressAndSignsIn() throws {
        let email = freshEmail()
        launch()
        try expectTitle("Sign in")
        try audit()

        try tapLink("signUp")
        try expectTitle("Create your account")
        try audit()
        try type(email, into: "email")
        try reveal("password")
        try type(World.password, into: "password")
        try tapPrimary()

        try expectTitle("Check your email")
        try audit()
        try type(try world.code(email), into: "code")
        try tapPrimary()
        try expectSignedIn(as: email)

        // Signed out again, the screens are back at their start with nothing typed.
        app.buttons["example.signOut"].tap()
        try expectTitle("Sign in")
        XCTAssertEqual(field("email").value as? String ?? "", "")
    }

    func testSignInWithAPassword() throws {
        let email = freshEmail()
        try world.account(email)
        launch()
        try expectTitle("Sign in")
        try type(email, into: "email")
        try tapPrimary()

        try expectTitle("Enter your password")
        try audit()
        try type(World.password, into: "password")
        try tapPrimary()
        try expectSignedIn(as: email)
    }

    func testAWrongPasswordIsSaidInWordsAtTheField() throws {
        let email = freshEmail()
        try world.account(email)
        launch()
        try type(email, into: "email")
        try tapPrimary()
        try expectTitle("Enter your password")
        try type("not-the-password-1!", into: "password")
        try tapPrimary()

        // The message of the code, in words, under the field ...
        let problem = app.staticTexts["Error: The email or password is incorrect."]
        XCTAssertTrue(problem.waitForExistence(timeout: 20))
        // ... and in what the field itself is read as.
        XCTAssertEqual(field("password").label, "Password, invalid: The email or password is incorrect.")
        // The password that was sent is not kept in the field.
        XCTAssertEqual(field("password").value as? String ?? "", "")
        try expectTitle("Enter your password")
        try audit()
    }

    func testSignInWithAnEmailedCode() throws {
        try world.settings([
            "signIn": ["methods": ["password": ["enabled": true], "emailCode": ["enabled": true]]]
        ])
        let email = freshEmail()
        try world.account(email)
        let before = try world.codesSent(email)
        launch()
        try type(email, into: "email")
        try tapPrimary()

        // Both ways are offered: the password's screen, with the code as the other way.
        // Nothing is emailed by arriving here.
        try expectTitle("Enter your password")
        XCTAssertEqual(try world.codesSent(email), before)
        try tapLink("emailCode")

        try expectTitle("Check your email")
        try audit()
        try type(try world.code(email, after: before), into: "code")
        try tapPrimary()
        try expectSignedIn(as: email)
    }

    func testWhereACodeIsTheOnlyWayItIsAskedForAtOnce() throws {
        let email = freshEmail()
        try world.account(email)
        let before = try world.codesSent(email)
        try world.settings([
            "signIn": ["methods": ["password": ["enabled": false], "emailCode": ["enabled": true]]]
        ])
        launch()
        try type(email, into: "email")
        try tapPrimary()

        try expectTitle("Check your email")
        try type(try world.code(email, after: before), into: "code")
        try tapPrimary()
        try expectSignedIn(as: email)
    }

    func testPasswordReset() throws {
        let email = freshEmail()
        try world.account(email)
        let before = try world.codesSent(email)
        launch()
        try type(email, into: "email")
        try tapPrimary()
        try expectTitle("Enter your password")
        try tapLink("reset")

        try expectTitle("Reset your password")
        try audit()
        // The address typed for the sign-in is carried over.
        XCTAssertEqual(field("email").value as? String, email)
        try tapPrimary()

        try expectTitle("Choose a new password")
        try audit()
        try type(try world.code(email, after: before), into: "code")
        try reveal("newPassword")
        try type("A-New-Passphrase-77!", into: "newPassword")
        try tapPrimary()
        try expectSignedIn(as: email)
    }

    func testAStepWithNoScreenIsSaidAsNotSupported() throws {
        let email = freshEmail()
        try world.account(email)
        // The environment now requires a second factor, and the account has none: the
        // server's next step is an enrolment, which this version has no screen for.
        try world.settings(["mfa": ["policy": "required"]])
        launch()
        try type(email, into: "email")
        try tapPrimary()
        try expectTitle("Enter your password")
        try type(World.password, into: "password")
        try tapPrimary()

        try expectTitle("This step is not supported")
        XCTAssertTrue(app.staticTexts["tula.subtitle"].exists)
        try audit()
        try tapPrimary()
        try expectTitle("Sign in")
    }

    func testALeftScreenKeepsNoPassword() throws {
        launch()
        try tapLink("signUp")
        try expectTitle("Create your account")
        try type(freshEmail(), into: "email")
        // Shown, so that what was typed can be read back: the field really held it.
        try reveal("password")
        try type(World.password, into: "password")
        XCTAssertEqual(field("password").value as? String, World.password)
        try tapLink("signIn")
        try expectTitle("Sign in")
        try tapLink("signUp")
        try expectTitle("Create your account")
        XCTAssertEqual(field("password").value as? String ?? "", "")
    }

    func testAnEmptyFieldIsSaidWithoutARequest() throws {
        launch()
        try expectTitle("Sign in")
        try tapPrimary()
        XCTAssertTrue(app.staticTexts["Error: This field is required."].waitForExistence(timeout: 10))
        XCTAssertEqual(field("email").label, "Email address, invalid: This field is required.")
        try audit()
    }

    func testTheScreensInTheDarkScheme() throws {
        let email = freshEmail()
        try world.account(email)
        launch(dark: true)
        try expectTitle("Sign in")
        try audit()
        try tapPrimary()
        XCTAssertTrue(app.staticTexts["Error: This field is required."].waitForExistence(timeout: 10))
        try audit()
        try type(email, into: "email")
        try tapPrimary()
        try expectTitle("Enter your password")
        try audit()
        try type("not-the-password-1!", into: "password")
        try tapPrimary()
        XCTAssertTrue(app.staticTexts["Error: The email or password is incorrect."].waitForExistence(timeout: 20))
        try audit()
        try tapLink("reset")
        try expectTitle("Reset your password")
        try audit()
        try tapLink("signIn")
        try tapLink("signUp")
        try expectTitle("Create your account")
        try audit()
    }
}
