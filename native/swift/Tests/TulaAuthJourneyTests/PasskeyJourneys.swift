import Foundation
import XCTest

@testable import TulaAuth

// The Swift client against the real API: passkeys (ADR 0027). The sheet is a software
// authenticator that makes real WebAuthn responses, carrying the origin the platform is
// taken to write for an iOS app (the relying party's own). No journey shows a sheet, and
// that origin has not been seen from a device.
final class PasskeyJourneys: JourneyTestCase {
    /// Passkeys on, and the app registered as the operator's.
    private func prepare(_ s: Server) async throws {
        try await s.passkeysOn()
        try await s.registerIosApp()
    }

    /// Sign up on a client whose passkey sheet has `authenticator` behind it.
    private func signUp(_ s: Server, _ authenticator: Authenticator, origin: String = Server.iosOrigin) async throws
        -> (app: App, sheet: SoftwareSheet, email: String)
    {
        let sheet = SoftwareSheet(authenticator, origin: origin)
        let app = try s.client(passkeys: sheet)
        let email = s.freshEmail()
        let flow = try await app.tula.startSignUp(email: email, password: Journey.password)
        try await flow.verifyEmail(code: try await s.code(email))
        return (app, sheet, email)
    }

    /// A new client with `authenticator` behind its sheet: another install of the app.
    private func visitor(_ s: Server, _ authenticator: Authenticator, origin: String = Server.iosOrigin) throws -> App {
        try s.client(passkeys: SoftwareSheet(authenticator, origin: origin))
    }

    func testPasskeyRegistrationAndSignIn() async throws {
        try await journey(
            "passkey registration and sign-in",
            "a signed-in user adds a passkey, and another install of the app signs in with it and nothing else; a dismissed sheet is neither an error nor a sign-in"
        ) { s in
            try await self.prepare(s)

            // A client with no sheet says so, before any request about a passkey.
            let (bare, _) = try await s.signUp()
            var unsupported = try await caught { try await bare.tula.passkeys.add() }
            XCTAssertEqual(unsupported.code, "passkey.unsupported")
            unsupported = try await caught { try await bare.tula.signInWithPasskey() }
            XCTAssertEqual(unsupported.code, "passkey.unsupported")
            var asked = try await s.exchanges().filter { $0.path.contains("passkey") }
            XCTAssertEqual(asked.count, 0)

            let authenticator = Authenticator()
            let (app, _, email) = try await self.signUp(s, authenticator)
            let passkey = try unwrap(try await app.tula.passkeys.add(name: "MacBook").value)
            XCTAssertEqual(passkey.name, "MacBook")
            XCTAssertFalse(passkey.synced)
            XCTAssertNil(passkey.lastUsedAt)
            var list = try await app.tula.passkeys.list()
            XCTAssertEqual(list, [passkey])
            let renamed = try await app.tula.passkeys.rename(passkey.id, to: "Work")
            XCTAssertEqual(renamed.name, "Work")
            let config = try await app.tula.config(force: true)
            XCTAssertTrue(config.signIn.methods.contains("passkey"))

            // Another install signs in with the passkey alone: no identifier, no second step.
            let visitor = try self.visitor(s, authenticator)
            let flow = try unwrap(try await visitor.tula.signInWithPasskey().value)
            XCTAssertEqual(flow.step.status, "complete")
            var state = await visitor.state()
            XCTAssertTrue(state.isSignedIn)
            let me = try await visitor.tula.user()
            XCTAssertEqual(me.email, email)
            let amr = try await visitor.amr()
            XCTAssertEqual(amr, ["hwk", "user", "mfa"])
            list = try await visitor.tula.passkeys.list()
            XCTAssertNotNil(list.first?.lastUsedAt)
            // Nothing of the ceremony is kept: not the challenge, not the response.
            let start = try unwrap(try await s.exchanges("/v1/client/sign-ins/passkey").last)
            let challenge = try unwrap(
                ((try JSONSerialization.jsonObject(with: Data(start.responseBody.utf8)) as? [String: Any])?["options"]
                    as? [String: Any])?["challenge"] as? String)
            XCTAssertFalse((String(reflecting: flow) + String(reflecting: visitor.tula)).contains(challenge))

            // The user dismisses the sheet: not an error, not a sign-in, and nothing is sent
            // after the start.
            let dismissedSheet = SoftwareSheet(authenticator, origin: Server.iosOrigin)
            dismissedSheet.plugIn(authenticator, dismiss: true)
            let dismissing = try s.client(passkeys: dismissedSheet)
            let before = try await s.exchanges().count
            let outcome = try await dismissing.tula.signInWithPasskey()
            XCTAssertNil(outcome.value)
            state = await dismissing.state()
            XCTAssertFalse(state.isSignedIn)
            asked = Array(try await s.exchanges().dropFirst(before)).filter { $0.path.hasSuffix("/passkey") }
            XCTAssertEqual(asked.count, 1)
            XCTAssertEqual(dismissedSheet.times, 1)
            // The sheet works again at once.
            dismissedSheet.plugIn(authenticator)
            let retried = try await dismissing.tula.signInWithPasskey()
            XCTAssertEqual(retried.value?.step.status, "complete")

            // A passkey the server never registered is the one generic refusal.
            let stranger = Authenticator()
            stranger.holdStray(rpId: Server.relyingParty)
            let refused = try await caught { try await self.visitor(s, stranger).tula.signInWithPasskey() }
            XCTAssertEqual(refused.code, "auth.invalid_credentials")
            XCTAssertEqual(refused.status, 401)

            // With the method switched off there is no ceremony.
            try await s.passkeysOn(["signIn": ["methods": ["passkey": ["enabled": false]]]])
            let off = try self.visitor(s, authenticator)
            let disabled = try await caught { try await off.tula.signInWithPasskey() }
            XCTAssertEqual(disabled.code, "auth.method_disabled")
        }
    }

    func testAPasskeySatisfiesTwoStepVerification() async throws {
        try await journey(
            "a passkey satisfies two-step verification",
            "with an authenticator app enrolled, the passkey signs in on its own and also serves as the second factor"
        ) { s in
            try await self.prepare(s)
            let authenticator = Authenticator()
            let (app, _, email) = try await self.signUp(s, authenticator)
            _ = try await app.tula.passkeys.add()
            let secret = try await app.tula.factors.startTotp().secret
            let confirming = try await s.totp(secret)
            _ = try await app.tula.factors.confirmTotp(code: confirming)

            let direct = try self.visitor(s, authenticator)
            let alone = try await direct.tula.signInWithPasskey()
            XCTAssertEqual(alone.value?.step.status, "complete")

            // After the password, the passkey is one of the ways to prove the second step.
            let sheet = SoftwareSheet(authenticator, origin: Server.iosOrigin)
            let second = try await s.atSecondFactor(
                email, options: [.totp, .backupCode, .passkey], passkeys: sheet)
            XCTAssertEqual(
                second.flow.screen,
                .secondFactor(FlowStepNeedsSecondFactor(options: [.totp, .backupCode, .passkey])))
            // Dismissed, the sign-in waits where it was.
            sheet.plugIn(authenticator, dismiss: true)
            let dismissed = try await second.flow.submitSecondFactorWithPasskey()
            XCTAssertNil(dismissed.value)
            XCTAssertEqual(second.flow.step.status, "needs_second_factor")
            var state = await second.app.state()
            XCTAssertFalse(state.isSignedIn)
            sheet.plugIn(authenticator)
            let done = try await second.flow.submitSecondFactorWithPasskey()
            XCTAssertEqual(done.value?.status, "complete")
            state = await second.app.state()
            XCTAssertTrue(state.isSignedIn)
            let amr = try await second.app.amr()
            XCTAssertEqual(amr, ["pwd", "hwk", "user", "mfa"])

            try await s.passkeysOn(["mfa": ["policy": "required"]])
            let required = try self.visitor(s, authenticator)
            let still = try await required.tula.signInWithPasskey()
            XCTAssertEqual(still.value?.step.status, "complete")
        }
    }

    func testStepUpWithAPasskeyAndTheLastWayToSignIn() async throws {
        try await journey(
            ["step-up with a passkey", "the last way to sign in cannot be removed"],
            "a stale session steps up with its passkey, and the last way in cannot be removed"
        ) { s in
            try await self.prepare(s)
            let authenticator = Authenticator()
            let (app, sheet, _) = try await self.signUp(s, authenticator)
            let first = try unwrap(try await app.tula.passkeys.add(name: "First").value)
            let laptop = Authenticator()
            sheet.plugIn(laptop)
            let second = try unwrap(try await app.tula.passkeys.add(name: "Second").value)

            try await s.advance(11 * 60)
            let stale = try await caught { try await app.tula.passkeys.rename(first.id, to: "x") }
            XCTAssertEqual(stale.code, "auth.step_up_required")
            XCTAssertEqual(stale.stepUpMethods, ["passkey", "password", "email_code"])
            // A dismissed sheet steps nothing up.
            sheet.plugIn(laptop, dismiss: true)
            let dismissed = try await app.tula.stepUp.withPasskey()
            XCTAssertNil(dismissed.value)
            let stillStale = try await caught { try await app.tula.passkeys.rename(first.id, to: "x") }
            XCTAssertEqual(stillStale.code, "auth.step_up_required")
            sheet.plugIn(laptop)
            let stepped = try await app.tula.stepUp.withPasskey()
            XCTAssertEqual(stepped.value, true)
            let amr = try await app.amr()
            XCTAssertTrue(amr.isSuperset(of: ["hwk", "user", "mfa"]))

            // With passkeys the only method, the last one is the last way to sign in.
            try await s.passkeysOn([
                "signIn": [
                    "methods": [
                        "password": ["enabled": false], "emailCode": ["enabled": false],
                        "emailLink": ["enabled": false], "passkey": ["enabled": true], "smsCode": ["enabled": false],
                    ]
                ]
            ])
            try await app.tula.passkeys.remove(first.id)
            let last = try await caught { try await app.tula.passkeys.remove(second.id) }
            XCTAssertEqual(last.code, "passkey.last_sign_in_method")
            XCTAssertEqual(last.status, 409)
            let list = try await app.tula.passkeys.list()
            XCTAssertEqual(list.count, 1)
            let removed = try await caught { try await self.visitor(s, authenticator).tula.signInWithPasskey() }
            XCTAssertEqual(removed.code, "auth.invalid_credentials")
            let kept = try await self.visitor(s, laptop).tula.signInWithPasskey()
            XCTAssertEqual(kept.value?.step.status, "complete")
        }
    }

    func testPasskeyRegistrationAndSignInFromANativeApp() async throws {
        try await journey(
            ["passkey registration from a native app", "passkey sign-in from a native app"],
            "an iOS app adds a passkey and signs in with it once the operator has registered it and allowed the relying party's origin; before that there is no ceremony"
        ) { s in
            try await s.passkeysOn(allowRelyingParty: false)
            let authenticator = Authenticator()
            let (app, sheet, email) = try await self.signUp(s, authenticator)

            // No app registered: refused before a challenge is made, so the sheet never shows.
            var refused = try await caught { try await app.tula.passkeys.add() }
            XCTAssertEqual(refused.code, "request.origin_not_allowed")
            XCTAssertEqual(refused.status, 403)
            refused = try await caught { try await self.visitor(s, authenticator).tula.signInWithPasskey() }
            XCTAssertEqual(refused.code, "request.origin_not_allowed")
            XCTAssertEqual(sheet.times, 0)

            // Registered, but the relying party's own origin is not one the environment
            // allows: an iOS response names nobody but that origin, so it is still refused.
            try await s.registerIosApp()
            refused = try await caught { try await app.tula.passkeys.add() }
            XCTAssertEqual(refused.code, "request.origin_not_allowed")
            XCTAssertEqual(sheet.times, 0)

            try await s.passkeysOn(allowRelyingParty: true)
            let added = try unwrap(try await app.tula.passkeys.add(name: "iPhone").value)
            XCTAssertEqual(added.name, "iPhone")
            XCTAssertNil(added.lastUsedAt)
            // Every passkey request of the app went out as an ios client with no Origin.
            for sent in try await s.exchanges().filter({ $0.path.contains("passkey") }) {
                XCTAssertEqual(sent.headers["x-tula-client"], "ios")
                XCTAssertNil(sent.headers["origin"])
            }

            let again = try self.visitor(s, authenticator)
            let flow = try await again.tula.signInWithPasskey()
            XCTAssertEqual(flow.value?.step.status, "complete")
            let state = await again.state()
            XCTAssertEqual(state.user?.email, email)
            let amr = try await again.amr()
            XCTAssertEqual(amr, ["hwk", "user", "mfa"])

            // A response that carries another platform's origin is not an iOS app's.
            let android = try self.visitor(
                s, authenticator, origin: "android:apk-key-hash:JS3UKt8u8T8QF0Jg0G4X0E1Zb1mJ2c3d4e5f6g7h8i9")
            refused = try await caught { try await android.tula.signInWithPasskey() }
            XCTAssertEqual(refused.code, "auth.invalid_credentials")
            XCTAssertEqual(refused.status, 401)
        }
    }

    func testPasskeySignInFromAnUnregisteredApp() async throws {
        try await journey(
            "passkey sign-in from an unregistered app",
            "a response that carries an origin the environment's apps do not have gets the one generic answer and cannot add a passkey; with the app removed there is no ceremony, and the passkey stays"
        ) { s in
            try await s.passkeysOn()
            let appId = try await s.registerIosApp()
            let authenticator = Authenticator()
            let (owner, sheet, _) = try await self.signUp(s, authenticator)
            _ = try await owner.tula.passkeys.add()

            // The same passkey (a synced one, say), presented with an origin of somebody else's.
            let elsewhere = "https://elsewhere.example"
            let stranger = try self.visitor(s, authenticator, origin: elsewhere)
            var refused = try await caught { try await stranger.tula.signInWithPasskey() }
            XCTAssertEqual(refused.code, "auth.invalid_credentials")
            XCTAssertEqual(refused.status, 401)
            let state = await stranger.state()
            XCTAssertFalse(state.isSignedIn)
            let statuses = await stranger.statuses()
            XCTAssertEqual(statuses, [])
            sheet.plugIn(Authenticator(), origin: elsewhere)
            refused = try await caught { try await owner.tula.passkeys.add() }
            XCTAssertEqual(refused.code, "passkey.registration_failed")
            XCTAssertEqual(refused.status, 422)

            // The operator removes the app: its origin goes at once, and the passkey stays.
            let removed = try await s.admin("DELETE", "/v1/admin/native-apps/\(appId)")
            XCTAssertEqual(removed.status, 204)
            refused = try await caught { try await self.visitor(s, authenticator).tula.signInWithPasskey() }
            XCTAssertEqual(refused.code, "request.origin_not_allowed")
            let list = try await owner.tula.passkeys.list()
            XCTAssertEqual(list.count, 1)
        }
    }
}
