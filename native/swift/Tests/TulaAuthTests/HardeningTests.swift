import CryptoKit
import Foundation
import XCTest

@testable import TulaAuth

#if canImport(Security)
import Security
#endif

// What a review of the device key, the provider round trip and the printed forms asked for:
// a key store that never answers, a key that is "gone" for one look only, a sign-out inside
// the shared refresh, a ticket kept through a failure that came before it was presented, a
// stored key that never opens again, and nothing that holds a secret printing it.

/// A key whose signing stops answering from a given signature on.
final class StallingKey: TulaDeviceKey, @unchecked Sendable {
    private let key = P256.Signing.PrivateKey()
    private let lock = NSLock()
    private var signed = 0
    private let stallFrom: Int
    private let never = Gate()

    /// - Parameter stallFrom: The first signature (counted from 1) that never comes.
    init(stallFrom: Int) { self.stallFrom = stallFrom }

    var publicKey: TulaDevicePublicKey {
        TulaDevicePublicKey(rawRepresentation: key.publicKey.rawRepresentation)
            ?? { fatalError("a P-256 key has a 64-byte point") }()
    }

    func sign(_ message: Data) async throws -> Data {
        let count = lock.withLock { () -> Int in
            signed += 1
            return signed
        }
        if count >= stallFrom { await never.wait() }
        return try key.signature(for: message).rawRepresentation
    }
}

/// A key store whose looks stop answering when told to.
actor StallingStore: TulaDeviceKeyStore {
    private var key: any TulaDeviceKey
    /// How many more looks are answered before the store stops answering; `nil` for all.
    private var answered: Int?
    private let never = Gate()

    init(key: any TulaDeviceKey = ScriptedKey()) { self.key = key }

    func stall(after looks: Int = 0) { answered = looks }
    func put(_ next: any TulaDeviceKey) { key = next }

    func existing() async throws -> (any TulaDeviceKey)? {
        if let left = answered {
            if left == 0 { await never.wait() }
            answered = left - 1
        }
        return key
    }

    func create() async throws -> any TulaDeviceKey { key }
    func remove() async throws {}
}

/// What a call ended with, kept for a test that must not wait on it for ever.
private final class Ending: @unchecked Sendable {
    private let lock = NSLock()
    private var code: String?
    func set(_ value: String) { lock.withLock { code = value } }
    var value: String? { lock.withLock { code } }
}

/// The code a call ends with (`""` when it throws nothing). Fails, and does not hang, when
/// the call never ends.
private func ending(
    file: StaticString = #filePath, line: UInt = #line, _ work: @escaping @Sendable () async throws -> Void
) async -> String? {
    let ended = Ending()
    Task {
        do {
            try await work()
            ended.set("")
        } catch {
            ended.set((error as? TulaError)?.code ?? "not a TulaError")
        }
    }
    await eventually("the call ended", file: file, line: line) { ended.value != nil }
    return ended.value
}

/// Everything a value says when it is printed, logged, reflected or dumped.
private func everything(_ value: Any) -> String {
    var text = "\(value) \(String(describing: value)) \(String(reflecting: value))"
    dump(value, to: &text)
    return text
}

final class HardeningTests: XCTestCase {
    /// A short deadline, so that a call that waits for its deadline ends at once.
    private let short: TimeInterval = 0.05

    private func bound(_ store: any TulaDeviceKeyStore, timeout: TimeInterval) async throws -> World {
        let world = try World(timeout: timeout, deviceKeys: store)
        await world.storage.put(Fixture.storageKey, "refresh-stored")
        world.api.on(Fixture.refresh, Reply(json: Fixture.tokens("first")))
        let state = try await world.session.load()
        XCTAssertTrue(state.isSignedIn)
        return world
    }

    private func assertKept(_ world: World, refreshes: Int, file: StaticString = #filePath, line: UInt = #line) async {
        let state = await world.session.state
        XCTAssertTrue(state.isSignedIn, "the session is kept", file: file, line: line)
        let stored = await world.storage.only
        XCTAssertEqual(stored, "refresh-first", file: file, line: line)
        XCTAssertEqual(world.api.count(Fixture.refresh), refreshes, file: file, line: line)
        XCTAssertEqual(world.api.count(Fixture.signOut), 0, file: file, line: line)
    }

    // MARK: A key store that never answers

    func testAKeyStoreThatNeverAnswersDoesNotHoldTheRefreshPastItsDeadline() async throws {
        let store = StallingStore()
        let world = try await bound(store, timeout: short)
        await store.stall()
        let session = world.session
        let code = await ending { _ = try await session.refresh() }
        XCTAssertEqual(code, "network.timeout", "as @tula/core: a look that got no answer in time")
        await assertKept(world, refreshes: 1)
    }

    func testAKeyThatNeverSignsDoesNotHoldTheRefreshPastItsDeadline() async throws {
        let store = StallingStore()
        let world = try await bound(store, timeout: short)
        await store.put(StallingKey(stallFrom: 1))
        let session = world.session
        let code = await ending { _ = try await session.refresh() }
        XCTAssertEqual(code, "network.timeout")
        await assertKept(world, refreshes: 1)
    }

    func testAKeyThatStopsSigningAtTheRepeatAfterANonceChallengeDoesNotHoldTheRefresh() async throws {
        let store = StallingStore()
        let world = try await bound(store, timeout: short)
        await store.put(StallingKey(stallFrom: 2))
        world.api.on(Fixture.refresh, Reply.error(400, "device.nonce_required", headers: ["DPoP-Nonce": "fresh"]))
        let session = world.session
        let code = await ending { _ = try await session.refresh() }
        XCTAssertEqual(code, "network.timeout")
        // The first refresh, and the one request the challenge answered: the repeat never left.
        await assertKept(world, refreshes: 2)
    }

    func testAKeyStoreThatStopsAnsweringAfterARefusedProofEndsNothing() async throws {
        let store = StallingStore()
        let world = try await bound(store, timeout: short)
        // The look for the proof is answered; the looks after the refusal never are.
        await store.stall(after: 1)
        world.api.on(Fixture.refresh, Reply.error(401, "device.proof_invalid"))
        let session = world.session
        let code = await ending { _ = try await session.refresh() }
        XCTAssertEqual(code, "device.proof_invalid", "a store that cannot tell has not said the key is gone")
        await assertKept(world, refreshes: 2)
    }

    // MARK: A sign-out inside the shared refresh

    func testTheSignOutOfALostKeyHasTheRefreshsDeadline() async throws {
        let store = FakeKeyStore(key: ScriptedKey())
        let world = try await bound(store, timeout: 20)
        await store.lose()
        world.api.on(Fixture.refresh, Reply.error(401, "device.proof_invalid"))
        world.api.on(Fixture.signOut, Reply(status: 204, json: ""))
        let token = try await world.session.refresh()
        XCTAssertNil(token)
        let told = try XCTUnwrap(world.api.requests(Fixture.signOut).first)
        // The request is given five seconds over the call's own deadline (`ApiTransport`).
        XCTAssertEqual(told.timeoutInterval, TulaSession.refreshTimeout + 5, "not the client's full timeout")
    }

    func testASignOutOfALostKeyThatGetsNoAnswerEndsTheRefreshAndIsDeliveredLater() async throws {
        let store = FakeKeyStore(key: ScriptedKey())
        let world = try await bound(store, timeout: short)
        await store.lose()
        world.api.on(Fixture.refresh, Reply.error(401, "device.proof_invalid"))
        let never = Gate()
        world.api.on(Fixture.signOut) { _ in
            await never.wait()
            return Reply(status: 204, json: "")
        }
        let session = world.session
        let code = await ending { _ = try await session.refresh() }
        XCTAssertEqual(code, "", "the refresh ended, with nobody signed in")
        let state = await world.session.state
        XCTAssertEqual(state, .signedOut)
        world.api.on(Fixture.signOut, Reply(status: 204, json: ""))
        try await world.session.signOut()
        let told = world.api.requests(Fixture.signOut)
        XCTAssertEqual(told.count, 2)
        XCTAssertEqual(Fixture.body(told[1])["refreshToken"] as? String, "refresh-first")
    }

    // MARK: A ticket kept through a failure that came before it was presented

    func testATicketIsKeptWhenTheRefreshBeforeItsExchangeFailed() async throws {
        let store = FakeKeyStore(key: ScriptedKey())
        let browser = FakeBrowser()
        let link = "https://app.example.com/callback"
        let world = try await World.signedIn(deviceKeys: store, browser: browser)
        let clock = world.clock
        browser.answer = { _, _ in
            // While the user is at the provider the access token runs out, and the key store
            // cannot be asked (a locked device): the exchange's refresh fails before the
            // ticket is sent.
            clock.advance(100)
            await store.script(looks: true)
            return "\(link)#tula_ticket=CANARY-ticket&tula_attempt=att_9"
        }
        let startRoute = "POST /v1/client/me/identities/oauth"
        let exchangeRoute = "POST /v1/client/me/identities/oauth/exchange"
        world.api.on(
            startRoute,
            Reply(
                json:
                    #"{"attemptId":"att_9","expiresAt":"2030-01-01T00:00:00.000Z","authorizationUrl":"https://provider.example/authorize","binding":"link-binding"}"#
            ))
        world.api.on(exchangeRoute, Reply(json: #"{"id":"idn_1","provider":"github","createdAt":"2026-01-01T00:00:00.000Z"}"#))
        let failed = await thrownCode { _ = try await world.client.identities.link(.github, redirectURL: link) }
        XCTAssertEqual(failed, "device.key_failed")
        XCTAssertEqual(world.api.count(exchangeRoute), 0, "the ticket was never presented")

        world.api.on(Fixture.refresh, Reply(json: Fixture.tokens("second")))
        guard case .linked(let identity) = try await world.client.retryProviderSignIn() else {
            return XCTFail("the ticket was forgotten")
        }
        XCTAssertEqual(identity.id, "idn_1")
        let sent = Fixture.body(try XCTUnwrap(world.api.requests(exchangeRoute).first))
        XCTAssertEqual(sent["ticket"] as? String, "CANARY-ticket")
        XCTAssertEqual(sent["binding"] as? String, "link-binding")
        // Answered: nothing is left to try again.
        guard case .refused(.noAnswer) = try await world.client.retryProviderSignIn() else {
            return XCTFail("the ticket outlived its answer")
        }
    }

    func testATicketThatWasAnsweredIsForgottenWhateverFollows() async throws {
        let browser = FakeBrowser()
        let redirect = "com.example.app://callback"
        browser.answer = { _, _ in "\(redirect)#tula_ticket=CANARY-ticket&tula_attempt=att_1" }
        let world = try World(browser: browser)
        let exchange = "POST /v1/client/sign-ins/oauth/exchange"
        world.api.on(
            "POST /v1/client/sign-ins/oauth",
            Reply(
                json:
                    #"{"attempt":\#(Fixture.attempt("sign_in", step: #"{"status":"needs_first_factor","strategies":["oauth_google"]}"#)),"authorizationUrl":"https://provider.example/authorize?state=s","binding":"CANARY-binding"}"#
            ))
        world.api.on(
            exchange,
            Reply(json: Fixture.attempt("sign_in", step: Fixture.completeStep, secret: nil, session: Fixture.tokens("first"))))
        // The server answered the ticket and the session could not be stored: that failure
        // is not about the ticket, which is spent.
        await world.storage.fail("set")
        let failed = await thrownCode { _ = try await world.client.signIn(with: .google, redirectURL: redirect) }
        XCTAssertEqual(failed, "storage.failed")
        guard case .refused(.noAnswer) = try await world.client.retryProviderSignIn() else {
            return XCTFail("a spent ticket was kept for another try")
        }
        XCTAssertEqual(world.api.count(exchange), 1)
    }

    // MARK: Nothing that holds a secret prints it

    func testNothingThatHoldsASecretPrintsIt() async throws {
        let world = try await World.signedIn()
        world.api.on(
            "POST /v1/client/sign-ins",
            Reply(json: Fixture.attempt("sign_in", step: #"{"status":"needs_password"}"#, secret: "CANARY-attempt-secret")))
        let flow = try await world.client.startSignIn(identifier: "maya@example.com")
        world.api.on(
            "POST /v1/client/sign-ins/id-token",
            Reply(
                json:
                    #"{"attempt":\#(Fixture.attempt("sign_in", step: #"{"status":"needs_first_factor","strategies":["oauth_apple"]}"#, secret: "CANARY-attempt-secret")),"nonce":"CANARY-nonce"}"#
            ))
        let idToken = try await world.client.startIdTokenSignIn(provider: .apple)
        let step = try JSONDecoder().decode(FlowStep.self, from: Data(Fixture.completeStep.utf8))
        let roundTrip = ProviderRoundTrip()
        let kept = ProviderRoundTrip.Kept(attemptId: "att_1", binding: "CANARY-binding", intent: .signIn)
        let held = ProviderRoundTrip.Held(ticket: "CANARY-ticket", until: Date())
        roundTrip.keep(kept)
        roundTrip.hold(held)
        let proofs = DeviceProofs(store: SoftwareDeviceKeyStore())
        proofs.nonce = "CANARY-nonce"
        let software = try XCTUnwrap(SoftwareDeviceKey(P256.Signing.PrivateKey()))
        let scalar = software.key.rawRepresentation.map { String($0) }.joined(separator: ", ")
        let softwareStore = SoftwareDeviceKeyStore()
        _ = try await softwareStore.create()

        // The secrets of the signed-in world, beside the canaries.
        let secrets = ["CANARY", "refresh-first", "signature-first", scalar]
        let table: [(String, Any)] = [
            ("TulaAppleCredential", TulaAppleCredential(idToken: "CANARY-id-token", givenName: "CANARY", familyName: "CANARY")),
            ("FactorEnrolmentResult", FactorEnrolmentResult(step: step, backupCodes: ["CANARY-code"], failure: nil)),
            ("BackupCodeResult", BackupCodeResult(step: step, remaining: 9)),
            ("IdTokenSignIn", idToken),
            ("TulaCeremony of a flow", TulaCeremony.finished(flow)),
            ("TulaCeremony of a value", TulaCeremony.finished("CANARY-value")),
            ("TulaCeremony dismissed", TulaCeremony<SignInFlow>.dismissed),
            ("ProviderOutcome signedIn", ProviderOutcome.signedIn(flow)),
            ("ProviderOutcome needsStep", ProviderOutcome.needsStep(flow)),
            ("SignInFlow", flow),
            ("ProviderRoundTrip", roundTrip),
            ("ProviderRoundTrip.Kept", kept),
            ("ProviderRoundTrip.Held", held),
            ("DeviceProofs", proofs),
            ("SoftwareDeviceKey", software),
            ("SoftwareDeviceKeyStore", softwareStore),
            ("CallOptions", CallOptions(accessToken: "CANARY-access", attemptSecret: "CANARY-attempt-secret")),
            ("TulaSession", world.session),
            ("TulaClient", world.client),
            ("TulaStepUp", world.client.stepUp),
            ("TulaPasskeys", world.client.passkeys),
            ("TulaFactors", world.client.factors),
            ("TulaIdentities", world.client.identities),
        ]
        for (name, value) in table {
            let said = everything(value)
            for secret in secrets {
                XCTAssertFalse(said.contains(secret), "\(name) printed something it holds: \(said.prefix(300))")
            }
        }
        // What an outcome says is its case, which an app may log.
        XCTAssertEqual("\(TulaCeremony<SignInFlow>.dismissed)", "TulaCeremony.dismissed")
        XCTAssertEqual("\(TulaCeremony.finished(flow))", "TulaCeremony.finished")
        XCTAssertEqual("\(ProviderOutcome.cancelled)", "ProviderOutcome.cancelled")
        XCTAssertEqual("\(ProviderOutcome.refused(.unexpectedReturn))", "ProviderOutcome.refused(unexpectedReturn)")
        XCTAssertEqual(String(reflecting: ProviderOutcome.signedIn(flow)), "ProviderOutcome.signedIn")
    }

    // MARK: The key store at a sign-out

    func testASignOutLeavesAKeyThatCanBeHadAlone() async throws {
        let store = FakeKeyStore(key: ScriptedKey())
        let world = try await bound(store, timeout: 5)
        world.api.on(Fixture.signOut, Reply(status: 204, json: ""))
        try await world.session.signOut()
        let key = await store.current
        XCTAssertNotNil(key, "a key that works is not the sign-out's to remove")
    }

    #if canImport(Security)
    private func keychain(_ items: KeychainTests.Items, enclave: any DeviceKeyEnclave = SoftwareEnclave())
        -> KeychainDeviceKeyStore
    {
        KeychainDeviceKeyStore(
            service: "test.device-key", name: "default", accessibility: .afterFirstUnlock, items: items,
            enclave: enclave)
    }

    // MARK: A key that is gone for one look only

    /// A bound client whose next refresh is refused for its proof, with the Keychain's
    /// answers to the looks that follow the refusal scripted (the look before the request
    /// works as it does).
    private func refused(thenLooks statuses: OSStatus...) async throws -> World {
        let items = KeychainTests.Items()
        let store = keychain(items)
        _ = try await store.create()
        let world = try await bound(store, timeout: 5)
        world.api.on(Fixture.refresh, Reply.error(401, "device.proof_invalid"))
        world.api.on(Fixture.signOut, Reply(status: 204, json: ""))
        items.force("copy", [KeychainTests.Items.real] + statuses)
        return world
    }

    func testAKeyThatIsMissingOnceAndThenFoundKeepsTheSession() async throws {
        let world = try await refused(thenLooks: errSecItemNotFound, KeychainTests.Items.real)
        let code = await thrownCode { _ = try await world.session.refresh() }
        XCTAssertEqual(code, "device.key_failed", "a store that contradicts itself is not believed")
        await assertKept(world, refreshes: 2)
    }

    func testAKeyThatIsMissingOnceAndThenCannotBeAskedForKeepsTheSession() async throws {
        let world = try await refused(thenLooks: errSecItemNotFound, errSecInteractionNotAllowed)
        let code = await thrownCode { _ = try await world.session.refresh() }
        XCTAssertEqual(code, "device.key_failed")
        await assertKept(world, refreshes: 2)
    }

    func testAKeyThatIsMissingTwiceEndsTheSessionAndTellsTheServer() async throws {
        let world = try await refused(thenLooks: errSecItemNotFound, errSecItemNotFound)
        let token = try await world.session.refresh()
        XCTAssertNil(token)
        let state = await world.session.state
        XCTAssertEqual(state, .signedOut)
        let stored = await world.storage.only
        XCTAssertNil(stored)
        let told = world.api.requests(Fixture.signOut)
        XCTAssertEqual(told.count, 1)
        XCTAssertEqual(Fixture.body(told[0])["refreshToken"] as? String, "refresh-first")
    }

    // MARK: A stored key that never opens again

    /// An enclave whose earlier keys can be made to stop opening, as a device restored from
    /// a backup has them.
    final class FadingEnclave: DeviceKeyEnclave, @unchecked Sendable {
        private let lock = NSLock()
        private var made: [Data] = []
        private var dead: Set<Data> = []
        private let software = SoftwareEnclave()

        var isAvailable: Bool { true }

        /// Every key made so far never opens again.
        func loseEverything() { lock.withLock { dead.formUnion(made) } }

        func make(accessibility: KeychainAccessibility) throws -> Data {
            let kept = try software.make(accessibility: accessibility)
            lock.withLock { made.append(kept) }
            return kept
        }

        func open(_ kept: Data) throws -> any TulaDeviceKey {
            if lock.withLock({ dead.contains(kept) }) { throw LoudFailure() }
            return try software.open(kept)
        }
    }

    func testAStoredKeyThatNeverOpensAgainIsRemovedAtSignOutAndTheNextSignInMakesANewOne() async throws {
        let items = KeychainTests.Items()
        let enclave = FadingEnclave()
        let store = keychain(items, enclave: enclave)
        let first = try await store.create()
        let world = try await bound(store, timeout: 5)
        enclave.loseEverything()

        // The rule stands: a key that cannot be had is a failure, never "gone".
        for _ in 0..<2 {
            let code = await thrownCode { _ = try await world.session.refresh() }
            XCTAssertEqual(code, "device.key_failed")
        }
        await assertKept(world, refreshes: 1)

        // The way out is a sign-out, which needs no proof and takes the dead blob with it.
        world.api.on(Fixture.signOut, Reply(status: 204, json: ""))
        try await world.session.signOut()
        XCTAssertNil(world.api.requests(Fixture.signOut)[0].value(forHTTPHeaderField: "DPoP"))
        XCTAssertEqual(items.items.count, 0, "what never opens again is not left for the next sign-in")

        // The next sign-in is not stuck on it: it makes a new key and proves with that.
        world.api.on(
            "POST /v1/client/sign-ins", Reply(json: Fixture.attempt("sign_in", step: #"{"status":"needs_password"}"#)))
        _ = try await world.client.startSignIn(identifier: "maya@example.com")
        let proof = try XCTUnwrap(ReadProof(try XCTUnwrap(world.api.requests("POST /v1/client/sign-ins").first)))
        XCTAssertTrue(proof.verified)
        XCTAssertEqual(items.items.count, 1)
        let second = try await store.existing()
        XCTAssertNotNil(second)
        XCTAssertNotEqual(second?.publicKey, first.publicKey)
    }

    func testARemovalThatFailsAtSignOutIsNotTheSignOutsFailure() async throws {
        let items = KeychainTests.Items()
        let enclave = FadingEnclave()
        let store = keychain(items, enclave: enclave)
        _ = try await store.create()
        let world = try await bound(store, timeout: 5)
        enclave.loseEverything()
        items.force("delete", errSecInteractionNotAllowed)
        world.api.on(Fixture.signOut, Reply(status: 204, json: ""))
        try await world.session.signOut()
        let state = await world.session.state
        XCTAssertEqual(state, .signedOut)
        XCTAssertEqual(items.items.count, 1, "left for the next sign-out to remove")
    }
    #endif
}
