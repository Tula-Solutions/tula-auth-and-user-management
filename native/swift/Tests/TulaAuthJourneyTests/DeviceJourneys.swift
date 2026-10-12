import CryptoKit
import Foundation
import XCTest

@testable import TulaAuth

// The Swift client against the real API: a session bound to a device key (ADR 0043). The
// key is a software P-256 key in the test's memory: no journey touches a Keychain or a
// Secure Enclave.
final class DeviceJourneys: JourneyTestCase {
    /// A device signed in on `s` with a session bound to its key.
    private struct Bound {
        let app: App
        let keys: SoftwareDeviceKeyStore
        let email: String
        /// The thumbprint of the device's key, as the server names it in `cnf.jkt`.
        let jkt: String
    }

    private func boundDevice(_ s: Server) async throws -> Bound {
        let keys = SoftwareDeviceKeyStore()
        let app = try s.client(deviceKeys: keys)
        let email = s.freshEmail()
        let flow = try await app.tula.startSignUp(email: email, password: Journey.password)
        try await flow.verifyEmail(code: try await s.code(email))
        let state = await app.state()
        XCTAssertTrue(state.isSignedIn)
        let key = try unwrap(await keys.existing())
        return Bound(app: app, keys: keys, email: email, jkt: Journey.thumbprint(key.publicKey))
    }

    /// Someone with a copy of the device's stored refresh token, and whatever key they have.
    private func copy(of app: App, on s: Server, deviceKeys: (any TulaDeviceKeyStore)? = nil) async throws -> App {
        let copy = MemoryTokenStorage()
        await copy.set(s.storageKey, try unwrap(await app.storage.get(s.storageKey)))
        return try s.client(storage: copy, deviceKeys: deviceKeys)
    }

    private func jkt(_ token: String?) -> String? {
        (Journey.claims(token)["cnf"] as? [String: Any])?["jkt"] as? String
    }

    private func presented(_ exchange: Exchange) -> String? {
        let body = try? JSONSerialization.jsonObject(with: Data(exchange.requestBody.utf8)) as? [String: Any]
        return body?["refreshToken"] as? String
    }

    private func issued(_ exchange: Exchange) -> String? {
        let body = try? JSONSerialization.jsonObject(with: Data(exchange.responseBody.utf8)) as? [String: Any]
        return body?["refreshToken"] as? String
    }

    func testASessionBoundToADeviceKeyIsRefreshedWithAProof() async throws {
        try await journey(
            "a session bound to a device key is refreshed with a proof",
            "device binding: a client with a device key answers the nonce challenge by itself, gets a session bound to the key, and refreshes it with a new proof each time"
        ) { s in
            let device = try await self.boundDevice(s)
            let starts = try await s.exchanges("/v1/client/sign-ups")
            XCTAssertEqual(starts.map(\.status), [400, 200])
            XCTAssertEqual(starts.first?.code, "device.nonce_required")
            XCTAssertNotNil(starts.first?.proof)
            XCTAssertNotEqual(starts.first?.proof, starts.last?.proof)
            // A proof goes with the start and a refresh, and with nothing between them.
            let verify = try unwrap(try await s.exchanges().first { $0.path.hasSuffix("/verify-email") })
            XCTAssertNil(verify.proof)

            let access = try await device.app.session.getToken()
            XCTAssertEqual(self.jkt(access), device.jkt)

            let first = await device.app.storage.get(s.storageKey)
            try await s.advance(1)
            let next = try await device.app.session.refresh()
            XCTAssertEqual(self.jkt(next), device.jkt)
            let second = await device.app.storage.get(s.storageKey)
            XCTAssertNotEqual(second, first)
            try await s.advance(1)
            _ = try await device.app.session.refresh()
            let sent = try await s.refreshes()
            XCTAssertEqual(sent.map(\.status), [200, 200])
            XCTAssertEqual(sent.first?.proof?.split(separator: ".").count, 3)
            XCTAssertNotEqual(sent.first?.proof, sent.last?.proof)

            // What the server says of the session is a boolean, never the key.
            let listed = try await device.app.session.list()
            XCTAssertEqual(listed.map(\.deviceBound), [true])
            XCTAssertFalse(String(describing: listed).contains(device.jkt))
        }
    }

    func testABoundSessionsRefreshWithoutAProofIsRefusedAndChangesNothing() async throws {
        try await journey(
            "a bound session's refresh without a proof is refused and changes nothing",
            "device binding: a copy of the stored refresh token on a client with no key is refused, is not signed out by it, and costs the device nothing"
        ) { s in
            let device = try await self.boundDevice(s)
            let token = await device.app.storage.get(s.storageKey)
            let thief = try await self.copy(of: device.app, on: s)
            let error = try await caught { try await thief.session.refresh() }
            XCTAssertEqual(error.code, "device.proof_invalid")
            XCTAssertEqual(error.status, 401)
            let refused = try await s.refreshes()
            XCTAssertNil(refused.last?.proof)
            // A bad proof ends nothing: the copy is still there, and so is the device's token.
            let kept = await thief.storage.get(s.storageKey)
            XCTAssertEqual(kept, token)
            let untouched = await device.app.storage.get(s.storageKey)
            XCTAssertEqual(untouched, token)
            let next = try await device.app.session.refresh()
            XCTAssertTrue(next?.hasPrefix("ey") == true)
            let state = await device.app.state()
            XCTAssertTrue(state.isSignedIn)
            let rotated = await device.app.storage.get(s.storageKey)
            XCTAssertNotEqual(rotated, token)
        }
    }

    func testABoundSessionsRefreshWithAProofOfAnotherKeyIsRefused() async throws {
        try await journey(
            "a bound session's refresh with a proof of another key is refused",
            "device binding: a copy of the stored refresh token on a client with a key of its own is refused and not signed out; the device goes on, until its own key is gone, which ends its session"
        ) { s in
            let device = try await self.boundDevice(s)
            let other = SoftwareDeviceKeyStore()
            _ = try await other.create()
            let thief = try await self.copy(of: device.app, on: s, deviceKeys: other)
            let error = try await caught { try await thief.session.refresh() }
            XCTAssertEqual(error.code, "device.proof_invalid")
            var sent = try await s.refreshes()
            XCTAssertEqual(sent.map(\.status), [401])
            XCTAssertNotNil(sent.first?.proof)
            // The thief's client has a key, so its refusal is a bad proof and not a lost key:
            // it is not signed out and its copy stays.
            let copied = await thief.storage.get(s.storageKey)
            XCTAssertNotNil(copied)
            let next = try await device.app.session.refresh()
            XCTAssertTrue(next?.hasPrefix("ey") == true)
            var state = await device.app.state()
            XCTAssertTrue(state.isSignedIn)

            // The device loses its key (an erased device, a restored backup): the session
            // cannot be refreshed again by anyone, and the client ends it instead of keeping
            // a session that is refused for ever.
            await device.keys.forget()
            try await s.advance(1)
            let gone = try await device.app.session.refresh()
            XCTAssertNil(gone)
            state = await device.app.state()
            XCTAssertEqual(state, .signedOut)
            let emptied = await device.app.storage.get(s.storageKey)
            XCTAssertNil(emptied)
            sent = try await s.refreshes()
            XCTAssertEqual(sent.last?.status, 401)
            XCTAssertNil(sent.last?.proof)
            let signOuts = try await s.exchanges("/v1/client/sessions/sign-out")
            XCTAssertEqual(signOuts.map(\.status), [204])
        }
    }

    func testAProofIsAcceptedOnce() async throws {
        try await journey(
            "a proof is accepted once",
            "device binding: a proof captured off the wire and sent again is refused, and the device goes on"
        ) { s in
            let device = try await self.boundDevice(s)
            _ = try await device.app.session.refresh()
            let used = try unwrap(try await s.refreshes().last?.proof)
            let replayer = try s.client(storage: device.app.storage, deviceKeys: device.keys)
            replayer.wire.tamper { request in
                var next = request
                if next.value(forHTTPHeaderField: "DPoP") != nil {
                    next.setValue(used, forHTTPHeaderField: "DPoP")
                }
                return next
            }
            let token = await device.app.storage.get(s.storageKey)
            let error = try await caught { try await replayer.session.refresh() }
            XCTAssertEqual(error.code, "device.proof_invalid")
            let last = try await s.refreshes().last
            XCTAssertEqual(last?.proof, used)
            // The key is still there, so the refusal ends nothing.
            let kept = await device.app.storage.get(s.storageKey)
            XCTAssertEqual(kept, token)
            let next = try await device.app.session.refresh()
            XCTAssertTrue(next?.hasPrefix("ey") == true)
        }
    }

    func testAProofWithAStaleNonceIsAskedForAFreshOne() async throws {
        try await journey(
            "a proof with a stale nonce is asked for a fresh one",
            "device binding: a client whose nonce has gone stale is given a fresh one and repeats the refresh once, inside the same call"
        ) { s in
            let device = try await self.boundDevice(s)
            let token = await device.app.storage.get(s.storageKey)
            try await s.advance(11 * 60)
            async let one = device.app.session.refresh()
            async let two = device.app.session.refresh()
            let (a, b) = try await (one, two)
            XCTAssertEqual(a, b)
            let sent = try await s.refreshes()
            XCTAssertEqual(sent.map(\.status), [400, 200])
            XCTAssertEqual(sent.first?.code, "device.nonce_required")
            XCTAssertEqual(sent.map { self.presented($0) }, [token, token])
            XCTAssertNotEqual(sent.first?.proof, sent.last?.proof)
            let state = await device.app.state()
            XCTAssertTrue(state.isSignedIn)
        }
    }

    func testTheReuseGraceWindowStillRequiresAProof() async throws {
        try await journey(
            "the reuse grace window still requires a proof",
            "device binding: a refresh whose answer was lost is repeated with a new proof and gets the same next token; the rotated token without a proof gets nothing"
        ) { s in
            let device = try await self.boundDevice(s)
            let first = await device.app.storage.get(s.storageKey)
            let flaky = try s.client(storage: device.app.storage, deviceKeys: device.keys)
            let lose = Flag()
            flaky.wire.loseResponse { request in
                request.url?.path.hasSuffix("/sessions/refresh") == true && lose.take()
            }
            // A client that has just started has no nonce: the challenge's answer is the one
            // that is lost, then asked for again, then answered.
            lose.set()
            var token = try await flaky.session.refresh()
            XCTAssertTrue(token?.hasPrefix("ey") == true)
            var sent = try await s.refreshes()
            XCTAssertEqual(sent.map(\.status), [400, 400, 200])
            let second = try unwrap(await device.app.storage.get(s.storageKey))
            XCTAssertNotEqual(second, first)

            // The rotation's own answer is lost: the repeat carries the same token and a new
            // proof, and is handed the same next token.
            lose.set()
            let before = sent.count
            try await s.advance(1)
            token = try await flaky.session.refresh()
            XCTAssertTrue(token?.hasPrefix("ey") == true)
            sent = Array(try await s.refreshes().dropFirst(before))
            XCTAssertEqual(sent.map(\.status), [200, 200])
            XCTAssertEqual(sent.map { self.presented($0) }, [second, second])
            XCTAssertNotEqual(sent.first?.proof, sent.last?.proof)
            let handed = sent.map { self.issued($0) }
            XCTAssertEqual(handed.first, handed.last)
            let stored = await device.app.storage.get(s.storageKey)
            XCTAssertEqual(stored, handed.first ?? nil)

            // The rotated token without a proof: nothing inside the window, and nothing is
            // revoked for it after the window.
            let copy = MemoryTokenStorage()
            await copy.set(s.storageKey, second)
            let thief = try s.client(storage: copy)
            var error = try await caught { try await thief.session.refresh() }
            XCTAssertEqual(error.code, "device.proof_invalid")
            try await s.advance(11)
            error = try await caught { try await thief.session.refresh() }
            XCTAssertEqual(error.code, "device.proof_invalid")
            token = try await flaky.session.refresh()
            XCTAssertTrue(token?.hasPrefix("ey") == true)
            let state = await flaky.state()
            XCTAssertTrue(state.isSignedIn)
        }
    }

    func testAProfileThatRequiresADeviceKeyLetsABoundNativeSignInThrough() async throws {
        try await journey(
            "a profile that requires a device key lets a bound native sign-in through",
            "device binding required: a client with a device key signs up as under optional, its session list says the session is bound, and it refreshes with a proof"
        ) { s in
            try await s.settings(["sessions": ["profiles": ["mobile": ["deviceBinding": "required"]]]])
            let device = try await self.boundDevice(s)
            let starts = try await s.exchanges("/v1/client/sign-ups")
            XCTAssertEqual(starts.map(\.status), [400, 200])
            let access = try await device.app.session.getToken()
            XCTAssertEqual(self.jkt(access), device.jkt)
            let listed = try await device.app.session.list()
            XCTAssertEqual(listed.map(\.deviceBound), [true])
            XCTAssertFalse(String(describing: listed).contains(device.jkt))
            try await s.advance(1)
            let next = try await device.app.session.refresh()
            XCTAssertEqual(self.jkt(next), device.jkt)
            let last = try await s.refreshes().last
            XCTAssertNotNil(last?.proof)
        }
    }

    func testAProfileWithNoDeviceBindingRefusesAProof() async throws {
        try await journey(
            "a profile with no device binding refuses a proof",
            "device binding none: a client that has a device key is refused at the start and not quietly signed in unbound; one without a key signs in"
        ) { s in
            try await s.settings(["sessions": ["profiles": ["mobile": ["deviceBinding": "none"]]]])
            let keyed = try s.client(deviceKeys: SoftwareDeviceKeyStore())
            let email = s.freshEmail()
            let error = try await caught {
                try await keyed.tula.startSignUp(email: email, password: Journey.password)
            }
            XCTAssertEqual(error.code, "device.binding_not_supported")
            XCTAssertEqual(error.status, 400)
            let starts = try await s.exchanges("/v1/client/sign-ups")
            XCTAssertEqual(starts.map(\.status), [400])
            let token = try await keyed.session.getToken()
            XCTAssertNil(token)
            let exists = try await s.userExists(email)
            XCTAssertFalse(exists)

            let (app, _) = try await s.signUp()
            let access = try await app.session.getToken()
            XCTAssertNil(self.jkt(access))
            let listed = try await app.session.list()
            XCTAssertEqual(listed.map(\.deviceBound), [false])
        }
    }
}
