import Foundation
import XCTest

@testable import TulaAuth

#if canImport(AuthenticationServices)
import AuthenticationServices

// The system's sheets, as far as a test can go without showing one. The requests are the
// framework's own objects, built and read; the one step that would put a sheet or a browser
// up is stood in for (`AuthorizationRun.Perform`, `SheetRun`, `SystemBrowserSession.Launch`).
// Nothing here shows a sheet, opens a browser or asks the system for a credential, and
// nothing here says the adapters work on a device.
@MainActor
final class SystemSheetTests: XCTestCase {
    /// What a stand-in was handed.
    private final class Handed<Value>: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [Value] = []
        func add(_ value: Value) { lock.withLock { values.append(value) } }
        var all: [Value] { lock.withLock { values } }
    }

    private func decoded<T: Decodable>(_ json: String, as type: T.Type = T.self) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private func failure(_ domain: String, _ code: Int) -> NSError {
        NSError(domain: domain, code: code, userInfo: [NSLocalizedDescriptionKey: "CANARY the framework's own words"])
    }

    private func thrown(_ work: () async throws -> Void) async -> TulaSheetError? {
        do {
            try await work()
            return nil
        } catch {
            XCTAssertFalse(everythingOf(error).contains("CANARY"))
            return error as? TulaSheetError
        }
    }

    // MARK: The requests

    func testTheRegistrationRequestCarriesTheOptionsAndAsksForUserVerification() throws {
        var options: PasskeyCreationOptions = try decoded(Fixture.creationOptions)
        options.excludeCredentials = [
            PasskeyCreationOptionsExcludeCredentialsItem(id: "Y3JlZC0x"),
            PasskeyCreationOptionsExcludeCredentialsItem(id: "not base64url!"),
        ]
        let request = try XCTUnwrap(SystemSheetWire.registrationRequest(options))
        XCTAssertEqual(request.relyingPartyIdentifier, "example.test")
        XCTAssertEqual(request.challenge, Data("challenge".utf8))
        XCTAssertEqual(request.userID, Data("usr_1".utf8))
        XCTAssertEqual(request.name, "maya@example.com")
        XCTAssertEqual(request.displayName, "Maya")
        XCTAssertEqual(request.userVerificationPreference, .required)
        if #available(iOS 17.4, macOS 14.4, *) {
            XCTAssertEqual(request.excludedCredentials?.map(\.credentialID), [Data("cred-1".utf8)])
        }

        options.challenge = "not base64url!"
        XCTAssertNil(SystemSheetWire.registrationRequest(options))
        options = try decoded(Fixture.creationOptions)
        options.user.id = "not base64url!"
        XCTAssertNil(SystemSheetWire.registrationRequest(options))
    }

    func testTheAssertionRequestCarriesTheChallengeAndTheAllowedCredentials() throws {
        var options: PasskeyRequestOptions = try decoded(Fixture.requestOptions)
        var request = try XCTUnwrap(SystemSheetWire.assertionRequest(options))
        XCTAssertEqual(request.relyingPartyIdentifier, "example.test")
        XCTAssertEqual(request.challenge, Data("challenge".utf8))
        XCTAssertEqual(request.userVerificationPreference, .required)
        XCTAssertEqual(request.allowedCredentials.count, 0)

        options.allowCredentials = [PasskeyRequestOptionsAllowCredentialsItem(id: "Y3JlZC0x")]
        request = try XCTUnwrap(SystemSheetWire.assertionRequest(options))
        XCTAssertEqual(request.allowedCredentials.map(\.credentialID), [Data("cred-1".utf8)])

        options.challenge = "not base64url!"
        XCTAssertNil(SystemSheetWire.assertionRequest(options))
    }

    func testTheAppleRequestAsksForTheNameAndTheAddressAndCarriesTheHashedNonce() {
        let request = SystemSheetWire.appleRequest(hashedNonce: "0f0f")
        XCTAssertEqual(request.nonce, "0f0f")
        XCTAssertEqual(request.requestedScopes, [.fullName, .email])
    }

    // MARK: One run of the authorization controller

    func testARunThatTheSystemFailsIsAFixedWordAndNeverTheSystemsOwnText() async throws {
        let rows: [(NSError, TulaSheetError)] = [
            (failure(SystemSheetWire.authorizationDomain, 1001), .dismissed),
            (failure(SystemSheetWire.authorizationDomain, 1006), .alreadyOnDevice),
            (failure(SystemSheetWire.authorizationDomain, 1004), .failed),
            (failure("another.domain", 1001), .failed),
        ]
        let anchor = ASPresentationAnchor()
        for (error, word) in rows {
            var run: AuthorizationRun?
            let made = AuthorizationRun(anchor: anchor) { controller in
                // In the sheet's place: the system answers the delegate, and nothing is shown.
                XCTAssertTrue(run?.presentationAnchor(for: controller) === anchor)
                run?.authorizationController(controller: controller, didCompleteWithError: error)
                // A second answer for one request is dropped.
                run?.authorizationController(controller: controller, didCompleteWithError: error)
            }
            run = made
            let said = await thrown { _ = try await made.run(SystemSheetWire.appleRequest(hashedNonce: "0f0f")) }
            XCTAssertEqual(said, word)
        }
    }

    // MARK: The three sheets

    func testThePasskeySheetBuildsItsRequestAndCallsNoCredentialACredential() async throws {
        let requests = Handed<ASAuthorizationRequest>()
        let anchor = ASPresentationAnchor()
        let sheet = SystemPasskeySheet(anchor: { anchor }) { request, over in
            XCTAssertTrue(over === anchor)
            requests.add(request)
            return nil
        }
        let creation: PasskeyCreationOptions = try decoded(Fixture.creationOptions)
        var said = await thrown { _ = try await sheet.create(creation) }
        XCTAssertEqual(said, .failed)
        XCTAssertTrue(requests.all.last is ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest)
        let asking: PasskeyRequestOptions = try decoded(Fixture.requestOptions)
        said = await thrown { _ = try await sheet.get(asking) }
        XCTAssertEqual(said, .failed)
        XCTAssertTrue(requests.all.last is ASAuthorizationPlatformPublicKeyCredentialAssertionRequest)
        XCTAssertEqual(requests.all.count, 2)

        // Options the framework cannot be given are refused before any sheet.
        var bad = creation
        bad.challenge = "not base64url!"
        said = await thrown { _ = try await sheet.create(bad) }
        XCTAssertEqual(said, .failed)
        var worse = asking
        worse.challenge = "not base64url!"
        said = await thrown { _ = try await sheet.get(worse) }
        XCTAssertEqual(said, .failed)
        XCTAssertEqual(requests.all.count, 2)
    }

    func testADismissedSheetIsDismissedForEachOfTheThree() async throws {
        let dismissed: SheetRun = { _, _ in throw TulaSheetError.dismissed }
        let anchor = ASPresentationAnchor()
        let passkeys = SystemPasskeySheet(anchor: { anchor }, run: dismissed)
        let creation: PasskeyCreationOptions = try decoded(Fixture.creationOptions)
        var said = await thrown { _ = try await passkeys.create(creation) }
        XCTAssertEqual(said, .dismissed)
        let asking: PasskeyRequestOptions = try decoded(Fixture.requestOptions)
        said = await thrown { _ = try await passkeys.get(asking) }
        XCTAssertEqual(said, .dismissed)
        let apple = SystemAppleSheet(anchor: { anchor }, run: dismissed)
        said = await thrown { _ = try await apple.authorize(hashedNonce: "0f0f") }
        XCTAssertEqual(said, .dismissed)
    }

    func testTheAppleSheetAsksWithTheHashedNonceAndCallsNoTokenAToken() async {
        let requests = Handed<ASAuthorizationRequest>()
        let anchor = ASPresentationAnchor()
        let sheet = SystemAppleSheet(anchor: { anchor }) { request, _ in
            requests.add(request)
            return nil
        }
        let said = await thrown { _ = try await sheet.authorize(hashedNonce: "0f0f") }
        XCTAssertEqual(said, .failed)
        XCTAssertEqual((requests.all.first as? ASAuthorizationAppleIDRequest)?.nonce, "0f0f")
    }

    // MARK: The browser session

    private func browser(
        ephemeral: Bool = false, _ launch: @escaping SystemBrowserSession.Launch
    ) -> SystemBrowserSession {
        let anchor = ASPresentationAnchor()
        return SystemBrowserSession(ephemeral: ephemeral, anchor: { anchor }, launch: launch)
    }

    func testTheBrowserSessionHandsBackTheAddressItWasSentTo() async throws {
        let sessions = Handed<Bool>()
        let scheme = browser(ephemeral: true) { session, answer in
            sessions.add(session.prefersEphemeralWebBrowserSession)
            answer(URL(string: "com.example.app:/oauth/callback#tula_ticket=t"), nil)
            // The system answers once: a second answer is dropped.
            answer(nil, nil)
            return true
        }
        var returned = try await scheme.open(
            url: "https://provider.example/authorize", redirectURL: "com.example.app:/oauth/callback")
        XCTAssertEqual(returned, "com.example.app:/oauth/callback#tula_ticket=t")
        XCTAssertEqual(sessions.all, [true])

        let appLink = browser { _, answer in
            answer(URL(string: "https://app.example.com/oauth/callback#tula_ticket=t"), nil)
            return true
        }
        if #available(iOS 17.4, macOS 14.4, *) {
            returned = try await appLink.open(
                url: "https://provider.example/authorize", redirectURL: "https://app.example.com/oauth/callback")
            XCTAssertEqual(returned, "https://app.example.com/oauth/callback#tula_ticket=t")
        }
    }

    func testAClosedBrowserIsNoAddressAndAFailedOneIsAFixedWord() async throws {
        let cancelled = failure(SystemSheetWire.browserDomain, 1)
        let closed = browser { _, answer in
            answer(nil, cancelled)
            return true
        }
        let returned = try await closed.open(
            url: "https://provider.example/authorize", redirectURL: "com.example.app:/oauth/callback")
        XCTAssertNil(returned)

        let broken = failure(SystemSheetWire.browserDomain, 2)
        let failing = browser { _, answer in
            answer(nil, broken)
            return true
        }
        var said = await thrown {
            _ = try await failing.open(
                url: "https://provider.example/authorize", redirectURL: "com.example.app:/oauth/callback")
        }
        XCTAssertEqual(said, .failed)

        // A session that would not start answers nothing by itself.
        let unstarted = browser { _, _ in false }
        said = await thrown {
            _ = try await unstarted.open(
                url: "https://provider.example/authorize", redirectURL: "com.example.app:/oauth/callback")
        }
        XCTAssertEqual(said, .failed)
    }

    func testAnAddressTheSessionCannotListenForIsRefusedBeforeAnythingIsOpened() async {
        let launched = Handed<Bool>()
        let session = browser { _, _ in
            launched.add(true)
            return true
        }
        for (url, redirectURL) in [
            ("https://provider.example/authorize", "http://localhost:5173/oauth/callback"),
            ("https://provider.example/authorize", "not a url"),
            ("", "com.example.app:/oauth/callback"),
        ] {
            let said = await thrown { _ = try await session.open(url: url, redirectURL: redirectURL) }
            XCTAssertEqual(said, .failed, redirectURL)
        }
        XCTAssertEqual(launched.all.count, 0)
    }

    func testABrowsersAnswerIsReadByItsAddressOrItsErrorsCodeAlone() {
        let address = URL(string: "com.example.app:/oauth/callback#x=1")
        XCTAssertEqual(try SystemSheetWire.browserAnswer(address, nil).get(), "com.example.app:/oauth/callback#x=1")
        XCTAssertNil(try SystemSheetWire.browserAnswer(nil, nil).get())
        XCTAssertNil(try SystemSheetWire.browserAnswer(nil, failure(SystemSheetWire.browserDomain, 1)).get())
        XCTAssertThrowsError(try SystemSheetWire.browserAnswer(nil, failure(SystemSheetWire.browserDomain, 3)).get()) {
            XCTAssertEqual($0 as? TulaSheetError, .failed)
            XCTAssertFalse(everythingOf($0).contains("CANARY"))
        }
    }
}

#endif
