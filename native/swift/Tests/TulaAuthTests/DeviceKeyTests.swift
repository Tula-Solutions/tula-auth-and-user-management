import CryptoKit
import Foundation
import XCTest

@testable import TulaAuth

#if canImport(Security)
import Security
#endif

// Device binding on a fake API (ADR 0043): which requests carry a proof and what is in it,
// the nonce and its one repeat, and the difference between a key that failed (the session
// is kept) and a key that is gone (the session is over).
final class DeviceKeyTests: XCTestCase {
    private let signIns = "POST /v1/client/sign-ins"
    private let needsPassword = #"{"status":"needs_password"}"#

    private func bound(_ store: FakeKeyStore) async throws -> World {
        let world = try World(deviceKeys: store)
        await world.storage.put(Fixture.storageKey, "refresh-stored")
        world.api.on(Fixture.refresh, Reply(json: Fixture.tokens("first"), headers: ["DPoP-Nonce": "nonce-1"]))
        _ = try await world.session.load()
        return world
    }

    // MARK: The proof

    func testAStartCarriesAProofOfANewKeyAndNothingElseDoes() async throws {
        let store = FakeKeyStore()
        let world = try World(deviceKeys: store)
        world.api.on(signIns, Reply(json: Fixture.attempt("sign_in", step: needsPassword)))
        world.api.on("GET /v1/client/config", Reply.error(500, "internal"))
        _ = try await world.client.startSignIn(identifier: "maya@example.com")
        _ = try? await world.client.config()

        let proof = try XCTUnwrap(ReadProof(world.api.requests(signIns)[0]))
        XCTAssertTrue(proof.verified, "the proof is signed by the key in its header")
        XCTAssertEqual(proof.header["typ"] as? String, "dpop+jwt")
        XCTAssertEqual(proof.header["alg"] as? String, "ES256")
        XCTAssertEqual(Set(proof.jwk.keys), ["kty", "crv", "x", "y"], "a public key and nothing else")
        XCTAssertEqual(proof.jwk["kty"], "EC")
        XCTAssertEqual(proof.jwk["crv"], "P-256")
        XCTAssertEqual(proof.claims["htm"] as? String, "POST")
        XCTAssertEqual(proof.claims["htu"] as? String, "\(Fixture.base)/v1/client/sign-ins")
        XCTAssertEqual(proof.claims["iat"] as? Int, Int(world.clock.now().timeIntervalSince1970))
        XCTAssertNotNil(proof.claims["jti"] as? String)
        XCTAssertNil(proof.nonce, "no nonce before the server gave one")
        let made = await store.made
        XCTAssertEqual(made, 1, "a start makes the key when there is none")
        XCTAssertNil(world.api.requests("GET /v1/client/config")[0].value(forHTTPHeaderField: "DPoP"))
    }

    func testTheProvenRequestsAreTheSixStartsAndTheRefresh() {
        XCTAssertEqual(
            Set(DeviceProofs.proven.keys),
            [
                "startSignUp", "startSignIn", "startPasswordReset", "startPasskeySignIn", "startOAuthSignIn",
                "startIdTokenSignIn", "refreshSession",
            ])
        XCTAssertEqual(DeviceProofs.proven.filter { $0.value == .refresh }.map(\.key), ["refreshSession"])
    }

    func testAClientWithNoKeyStoreSendsNoProof() async throws {
        let world = try await World.signedIn()
        XCTAssertNil(world.api.requests(Fixture.refresh)[0].value(forHTTPHeaderField: "DPoP"))
    }

    func testEveryProofIsNewAndCarriesTheNewestNonce() async throws {
        let store = FakeKeyStore(key: ScriptedKey())
        let world = try await bound(store)
        world.api.on(Fixture.refresh, Reply(json: Fixture.tokens("second"), headers: ["dpop-nonce": "nonce-2"]))
        world.api.on(Fixture.refresh, Reply(json: Fixture.tokens("third")))
        _ = try await world.session.refresh()
        _ = try await world.session.refresh()
        let proofs = try world.api.requests(Fixture.refresh).map { try XCTUnwrap(ReadProof($0)) }
        XCTAssertEqual(proofs.map(\.nonce), [nil, "nonce-1", "nonce-2"])
        XCTAssertEqual(Set(proofs.compactMap { $0.claims["jti"] as? String }).count, 3, "a proof is used once")
        XCTAssertTrue(proofs.allSatisfy(\.verified))
        let made = await store.made
        XCTAssertEqual(made, 0, "a refresh never makes a key")
    }

    func testANonceChallengeIsAnsweredOnceInsideTheSameCall() async throws {
        let store = FakeKeyStore(key: ScriptedKey())
        let world = try World(deviceKeys: store)
        await world.storage.put(Fixture.storageKey, "refresh-stored")
        world.api.on(Fixture.refresh, Reply.error(400, "device.nonce_required", headers: ["DPoP-Nonce": "fresh"]))
        world.api.on(Fixture.refresh, Reply(json: Fixture.tokens("first")))
        let state = try await world.session.load()
        XCTAssertTrue(state.isSignedIn)
        let proofs = try world.api.requests(Fixture.refresh).map { try XCTUnwrap(ReadProof($0)) }
        XCTAssertEqual(proofs.map(\.nonce), [nil, "fresh"])
        XCTAssertNotEqual(proofs[0].claims["jti"] as? String, proofs[1].claims["jti"] as? String)
    }

    func testASecondChallengeIsAnErrorAndKeepsTheSession() async throws {
        let store = FakeKeyStore(key: ScriptedKey())
        let world = try await bound(store)
        world.api.always(Fixture.refresh) { _ in
            Reply.error(400, "device.nonce_required", headers: ["DPoP-Nonce": "again"])
        }
        let code = await thrownCode { _ = try await world.session.refresh() }
        XCTAssertEqual(code, "device.nonce_required")
        XCTAssertEqual(world.api.count(Fixture.refresh), 3, "the first refresh, then one request and one repeat")
        let state = await world.session.state
        XCTAssertTrue(state.isSignedIn)
    }

    // MARK: A key that failed, and a key that is gone

    func testAKeyStoreThatFailsSendsNothingAndKeepsTheSession() async throws {
        let store = FakeKeyStore(key: ScriptedKey())
        let world = try await bound(store)
        await store.script(looks: true)
        do {
            _ = try await world.session.refresh()
            XCTFail("nothing was thrown")
        } catch {
            XCTAssertEqual((error as? TulaError)?.code, "device.key_failed")
            XCTAssertFalse(everythingOf(error).contains(LoudFailure.text), "nothing of what the store said")
        }
        XCTAssertEqual(world.api.count(Fixture.refresh), 1, "no request without a proof")
        let state = await world.session.state
        XCTAssertTrue(state.isSignedIn)
        let stored = await world.storage.only
        XCTAssertEqual(stored, "refresh-first")
        // The same call works when the store does.
        world.api.on(Fixture.refresh, Reply(json: Fixture.tokens("second")))
        let token = try await world.session.refresh()
        XCTAssertEqual(token, Fixture.accessToken("second"))
    }

    func testAKeyThatCannotSignOrBeMadeIsKeyFailed() async throws {
        for key in [ScriptedKey(failing: true), ScriptedKey(short: true)] {
            let world = try World(deviceKeys: FakeKeyStore(key: key))
            do {
                _ = try await world.client.startSignIn(identifier: "maya@example.com")
                XCTFail("nothing was thrown")
            } catch {
                XCTAssertEqual((error as? TulaError)?.code, "device.key_failed")
                XCTAssertFalse(everythingOf(error).contains(LoudFailure.text))
            }
            XCTAssertEqual(world.api.requests.count, 0)
        }
        let store = FakeKeyStore()
        await store.failCreating()
        let world = try World(deviceKeys: store)
        let code = await thrownCode { _ = try await world.client.startPasswordReset(email: "maya@example.com") }
        XCTAssertEqual(code, "device.key_failed")
        XCTAssertEqual(world.api.requests.count, 0)
    }

    func testARefusedProofOfAKeyThatIsGoneEndsTheSessionAndTellsTheServer() async throws {
        let store = FakeKeyStore(key: ScriptedKey())
        let world = try await bound(store)
        await store.lose()
        world.api.on(Fixture.refresh, Reply.error(401, "device.proof_invalid"))
        world.api.on(Fixture.signOut, Reply(status: 204, json: ""))
        let token = try await world.session.refresh()
        XCTAssertNil(token)
        let state = await world.session.state
        XCTAssertEqual(state, .signedOut)
        let stored = await world.storage.only
        XCTAssertNil(stored)
        XCTAssertNil(
            world.api.requests(Fixture.refresh)[1].value(forHTTPHeaderField: "DPoP"), "no key, so no proof was sent")
        let told = world.api.requests(Fixture.signOut)
        XCTAssertEqual(told.count, 1)
        XCTAssertEqual(Fixture.body(told[0])["refreshToken"] as? String, "refresh-first")
        XCTAssertNil(told[0].value(forHTTPHeaderField: "DPoP"), "a sign-out needs no proof")
    }

    func testALostKeyWhoseSignOutFailedIsDeliveredByTheNextSignOut() async throws {
        let store = FakeKeyStore(key: ScriptedKey())
        let world = try await bound(store)
        await store.lose()
        world.api.on(Fixture.refresh, Reply.error(401, "device.proof_invalid"))
        world.api.on(Fixture.signOut, Reply.error(503, "service.unavailable"))
        let token = try await world.session.refresh()
        XCTAssertNil(token)
        world.api.on(Fixture.signOut, Reply(status: 204, json: ""))
        try await world.session.signOut()
        let told = world.api.requests(Fixture.signOut)
        XCTAssertEqual(told.count, 2)
        XCTAssertEqual(Fixture.body(told[1])["refreshToken"] as? String, "refresh-first")
    }

    func testARefusedProofKeepsTheSessionWhileTheKeyIsThereOrTheStoreCannotTell() async throws {
        // The key is there and the server refused its proof: the session is kept.
        let present = FakeKeyStore(key: ScriptedKey())
        var world = try await bound(present)
        world.api.on(Fixture.refresh, Reply.error(401, "device.proof_invalid"))
        var code = await thrownCode { _ = try await world.session.refresh() }
        XCTAssertEqual(code, "device.proof_invalid")
        var state = await world.session.state
        XCTAssertTrue(state.isSignedIn)
        XCTAssertEqual(world.api.count(Fixture.signOut), 0)

        // The store answered for the proof and then could not say whether there is a key.
        let unsure = FakeKeyStore(key: ScriptedKey())
        world = try await bound(unsure)
        await unsure.script(looks: false, true)
        world.api.on(Fixture.refresh, Reply.error(401, "device.proof_invalid"))
        code = await thrownCode { _ = try await world.session.refresh() }
        XCTAssertEqual(code, "device.proof_invalid")
        state = await world.session.state
        XCTAssertTrue(state.isSignedIn)
        let stored = await world.storage.only
        XCTAssertEqual(stored, "refresh-first")
    }

    func testNoDeviceCodeEndsTheSession() async throws {
        for code in [
            "device.proof_invalid", "device.binding_required", "device.binding_not_supported", "device.nonce_required",
        ] {
            let world = try await bound(FakeKeyStore(key: ScriptedKey()))
            world.api.always(Fixture.refresh) { _ in Reply.error(code == "device.nonce_required" ? 400 : 401, code) }
            let thrown = await thrownCode { _ = try await world.session.refresh() }
            XCTAssertEqual(thrown, code)
            let state = await world.session.state
            XCTAssertTrue(state.isSignedIn, "\(code) is about the request, not the session")
        }
        // And an unbound client that is told its proof is invalid has no key to have lost.
        let world = try await World.signedIn()
        world.api.on(Fixture.refresh, Reply.error(401, "device.proof_invalid"))
        let thrown = await thrownCode { _ = try await world.session.refresh() }
        XCTAssertEqual(thrown, "device.proof_invalid")
        let state = await world.session.state
        XCTAssertTrue(state.isSignedIn)
    }

    // MARK: The stores

    func testTheSoftwareStoreMakesOneKeyAndCanForgetIt() async throws {
        let store = SoftwareDeviceKeyStore()
        let none = await store.existing()
        XCTAssertNil(none)
        let made = try await store.create()
        let again = try await store.create()
        XCTAssertEqual(made.publicKey, again.publicKey)
        let found = await store.existing()
        XCTAssertEqual(found?.publicKey, made.publicKey)
        let signature = try await made.sign(Data("message".utf8))
        XCTAssertEqual(signature.count, 64)
        await store.forget()
        let gone = await store.existing()
        XCTAssertNil(gone)
    }

    func testAPublicKeyIsSixtyFourBytesAndBase64URLIsReadStrictly() {
        XCTAssertNil(TulaDevicePublicKey(rawRepresentation: Data(repeating: 1, count: 63)))
        let point = TulaDevicePublicKey(rawRepresentation: Data((0..<64).map { UInt8($0) }))
        XCTAssertEqual(point?.x, Data((0..<32).map { UInt8($0) }))
        XCTAssertEqual(point?.y, Data((32..<64).map { UInt8($0) }))
        let bytes = Data([0xfb, 0xff, 0xfe, 0x01])
        XCTAssertEqual(DeviceProofs.base64url(bytes), "-__-AQ")
        XCTAssertEqual(DeviceProofs.bytes(base64url: "-__-AQ"), bytes)
        for refused in ["", "a+b", "a/b", "ab==", "a b", "é"] {
            XCTAssertNil(DeviceProofs.bytes(base64url: refused), refused)
        }
        XCTAssertEqual(DeviceProofs.random(16).count, 16)
    }

    #if canImport(Security)
    private func keychain(_ items: KeychainTests.Items, enclave: any DeviceKeyEnclave = SoftwareEnclave())
        -> KeychainDeviceKeyStore
    {
        KeychainDeviceKeyStore(
            service: "test.device-key", name: "default", accessibility: .afterFirstUnlock, items: items,
            enclave: enclave)
    }

    func testTheKeychainStoreKeepsTheKeyOnThisDeviceOnly() async throws {
        let items = KeychainTests.Items()
        let store = keychain(items)
        let none = try await store.existing()
        XCTAssertNil(none, "no item is no key")
        let made = try await store.create()
        let item = try XCTUnwrap(items.items.first)
        XCTAssertEqual(item[kSecAttrSynchronizable as String] as? Bool, false)
        XCTAssertEqual(
            item[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        XCTAssertEqual(item[kSecUseDataProtectionKeychain as String] as? Bool, true)
        XCTAssertEqual(item[kSecAttrService as String] as? String, "test.device-key")
        let found = try await store.existing()
        XCTAssertEqual(found?.publicKey, made.publicKey)
        let signature = try await made.sign(Data("message".utf8))
        XCTAssertEqual(signature.count, 64)
        try await store.remove()
        try await store.remove()
        let gone = try await store.existing()
        XCTAssertNil(gone)
    }

    func testAKeychainThatCannotAnswerIsAFailureAndNeverNoKey() async throws {
        let items = KeychainTests.Items()
        let store = keychain(items)
        _ = try await store.create()
        for status in [errSecInteractionNotAllowed, errSecAuthFailed, errSecSuccess] {
            items.force("copy", status)
            do {
                _ = try await store.existing()
                XCTFail("a status of \(status) was read as an answer")
            } catch {
                XCTAssertTrue(error is KeychainError)
            }
        }
        // A blob the enclave will not open is a failure too.
        items.plant("test.device-key|default", [kSecValueData as String: Data([1, 2, 3])])
        do {
            _ = try await store.existing()
            XCTFail("an unusable blob was read as a key")
        } catch {}
        items.force("delete", errSecInteractionNotAllowed)
        do {
            try await store.remove()
            XCTFail("a refused delete was not thrown")
        } catch {
            XCTAssertTrue(error is KeychainError)
        }
    }

    func testCreatingReturnsTheKeyAnotherCallerStoredAndRefusesWithoutAnEnclave() async throws {
        let items = KeychainTests.Items()
        let store = keychain(items)
        let first = try await store.create()
        // The look said "none" and another caller wrote between it and the write.
        let second = try await store.create()
        XCTAssertEqual(first.publicKey, second.publicKey, "a client has one key")
        XCTAssertEqual(items.items.count, 1)

        items.force("add", errSecInteractionNotAllowed)
        try await store.remove()
        do {
            _ = try await store.create()
            XCTFail("a refused write was not thrown")
        } catch {
            XCTAssertTrue(error is KeychainError)
        }

        struct NoEnclave: DeviceKeyEnclave {
            var isAvailable: Bool { false }
            func make(accessibility: KeychainAccessibility) throws -> Data { Data() }
            func open(_ kept: Data) throws -> any TulaDeviceKey { throw DeviceKeyStoreError.unusable }
        }
        let without = keychain(KeychainTests.Items(), enclave: NoEnclave())
        do {
            _ = try await without.create()
            XCTFail("a key was made without an enclave")
        } catch {
            XCTAssertEqual(error as? DeviceKeyStoreError, .unavailable)
        }
    }

    func testTheClientCallsALockedKeychainKeyFailedAndAMissingItemLost() async throws {
        let items = KeychainTests.Items()
        let store = keychain(items)
        let world = try World(deviceKeys: store)
        _ = try await store.create()
        await world.storage.put(Fixture.storageKey, "refresh-stored")
        world.api.on(Fixture.refresh, Reply(json: Fixture.tokens("first")))
        _ = try await world.session.load()

        items.force("copy", errSecInteractionNotAllowed)
        let locked = await thrownCode { _ = try await world.session.refresh() }
        XCTAssertEqual(locked, "device.key_failed")
        var state = await world.session.state
        XCTAssertTrue(state.isSignedIn)

        try await store.remove()
        world.api.on(Fixture.refresh, Reply.error(401, "device.proof_invalid"))
        world.api.on(Fixture.signOut, Reply(status: 204, json: ""))
        let token = try await world.session.refresh()
        XCTAssertNil(token)
        state = await world.session.state
        XCTAssertEqual(state, .signedOut)
    }
    #endif
}
