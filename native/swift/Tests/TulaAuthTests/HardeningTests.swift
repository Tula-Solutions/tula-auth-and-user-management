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

    /// How many looks the store was asked for, answered or not.
    private(set) var looks = 0

    func existing() async throws -> (any TulaDeviceKey)? {
        looks += 1
        if let left = answered {
            if left == 0 { await never.wait() }
            answered = left - 1
        }
        return key
    }

    func create() async throws -> any TulaDeviceKey { key }
    func remove() async throws {}
}

/// A key store with no key, whose making of one never answers.
actor StallingMaker: TulaDeviceKeyStore {
    private let never = Gate()
    private(set) var makings = 0

    func existing() async throws -> (any TulaDeviceKey)? { nil }

    func create() async throws -> any TulaDeviceKey {
        makings += 1
        await never.wait()
        return ScriptedKey()
    }

    func remove() async throws {}
}

/// A key store whose looks fail with what it is told to throw, and which counts what it is
/// asked to remove. Its looks can be held at a gate, so that a test acts while one is out.
actor FailingStore: TulaDeviceKeyStore {
    private var key: ScriptedKey? = ScriptedKey()
    private var failure: (any Error)?
    private var failRemoval = false
    private var gate: Gate?
    private(set) var removals = 0
    /// The looks that reached the store, and the ones that left it.
    private(set) var reached = 0
    private(set) var finished = 0

    func fail(with error: any Error) { failure = error }
    func failRemoving() { failRemoval = true }
    func hold() { gate = Gate() }
    func release() { gate?.open() }

    func existing() async throws -> (any TulaDeviceKey)? {
        reached += 1
        if let gate { await gate.wait() }
        finished += 1
        if let failure { throw failure }
        return key
    }

    func create() async throws -> any TulaDeviceKey {
        let next = ScriptedKey()
        key = next
        return next
    }

    func remove() async throws {
        removals += 1
        if failRemoval { throw LoudFailure() }
        key = nil
        failure = nil
    }
}

/// A key store whose next look can be held while the test removes the key, and which then
/// hands back the key it had when the look began: a look that answers late.
actor LateStore: TulaDeviceKeyStore {
    private var key: ScriptedKey? = ScriptedKey()
    private var holding = false
    private let gate = Gate()
    private(set) var looks = 0
    private(set) var waiting = 0
    private(set) var made = 0

    var current: TulaDevicePublicKey? { key?.publicKey }
    func holdNextLook() { holding = true }
    nonisolated func release() { gate.open() }

    func existing() async throws -> (any TulaDeviceKey)? {
        looks += 1
        guard holding else { return key }
        holding = false
        let old = key
        waiting += 1
        await gate.wait()
        return old
    }

    func create() async throws -> any TulaDeviceKey {
        made += 1
        let next = ScriptedKey()
        key = next
        return next
    }

    func remove() async throws { key = nil }
}

/// A key store whose removal never answers.
actor HungRemoval: TulaDeviceKeyStore {
    private let key = ScriptedKey()
    private let never = Gate()

    func existing() async throws -> (any TulaDeviceKey)? { key }
    func create() async throws -> any TulaDeviceKey { key }
    func remove() async throws { await never.wait() }
}

/// A key store whose looks can be held one by one, each at a gate of its own, and whose
/// removal can be held too. A held look hands back the key the store had when it began.
actor HeldStore: TulaDeviceKeyStore {
    private var key: ScriptedKey? = ScriptedKey()
    private var held: [Gate] = []
    private var removal: Gate?
    /// What a removal does once it has removed, when the test says so.
    private var noticesCancellation = false
    private(set) var looks = 0
    private(set) var waiting = 0
    private(set) var left = 0
    private(set) var made = 0
    private(set) var removing = 0
    private(set) var removed = 0

    var current: TulaDevicePublicKey? { key?.publicKey }

    /// Hold the next look that is not yet spoken for; the gate lets it answer.
    func holdNextLook() -> Gate {
        let gate = Gate()
        held.append(gate)
        return gate
    }

    func holdRemoval(noticingCancellation: Bool = false) -> Gate {
        let gate = Gate()
        removal = gate
        noticesCancellation = noticingCancellation
        return gate
    }

    func existing() async throws -> (any TulaDeviceKey)? {
        looks += 1
        guard !held.isEmpty else { return key }
        let gate = held.removeFirst()
        let old = key
        waiting += 1
        await gate.wait()
        left += 1
        return old
    }

    func create() async throws -> any TulaDeviceKey {
        if let key { return key }
        made += 1
        let next = ScriptedKey()
        key = next
        return next
    }

    func remove() async throws {
        removing += 1
        if let removal { await removal.wait() }
        key = nil
        removed += 1
        if noticesCancellation { try Task.checkCancellation() }
    }
}

/// A class that holds a secret and says it prints nothing, and a subclass of it.
class RedactedBase: TulaRedacted {
    let secret = "CANARY-inherited"
}

final class RedactedChild: RedactedBase {
    let other = "CANARY-own"
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
        XCTAssertEqual(code, "network.timeout", "as @tula-tech/core: a look that got no answer in time")
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

    func testAKeyStoreThatNeverAnswersIsAskedOnceHoweverManyRefreshesGiveUp() async throws {
        let store = StallingStore()
        let world = try await bound(store, timeout: short)
        let before = await store.looks
        await store.stall()
        let session = world.session
        for _ in 0..<3 {
            let code = await ending { _ = try await session.refresh() }
            XCTAssertEqual(code, "network.timeout", "each refresh still gives up at its own deadline")
        }
        let looks = await store.looks
        XCTAssertEqual(looks - before, 1, "a look that is still out is joined, never started again")
        await assertKept(world, refreshes: 1)
    }

    func testAKeyThatIsNeverMadeIsAskedForOnceHoweverManyStartsGiveUp() async throws {
        let store = StallingMaker()
        let world = try World(timeout: short, deviceKeys: store)
        let client = world.client
        for _ in 0..<3 {
            let code = await ending { _ = try await client.startSignIn(identifier: "maya@example.com") }
            XCTAssertEqual(code, "network.timeout")
        }
        let makings = await store.makings
        XCTAssertEqual(makings, 1, "a making that is still out is joined, never started again")
        XCTAssertEqual(world.api.count("POST /v1/client/sign-ins"), 0, "nothing was sent without its proof")
    }

    func testACallThatGaveUpOnAKeyStoreLeavesNothingWaitingForIt() async throws {
        let store = StallingStore()
        await store.stall()
        let proofs = DeviceProofs(store: store)
        let ended = Ending()
        let waiter = Task {
            do {
                _ = try await proofs.key(for: .refresh)
                ended.set("")
            } catch {
                ended.set((error as? TulaError)?.code ?? "not a TulaError")
            }
        }
        await eventually("the look reached the store") { await store.looks == 1 }
        // What a deadline does to the call that waits: the wait ends, the look does not.
        waiter.cancel()
        await eventually("the waiter ended with the look still out") { ended.value != nil }
        XCTAssertEqual(ended.value, "device.key_failed")
        let looks = await store.looks
        XCTAssertEqual(looks, 1)
    }

    // MARK: A key that was removed while a look for it was out

    func testAKeyALookHandsBackAfterItWasRemovedIsUsedByNobody() async throws {
        let store = LateStore()
        let had = await store.current
        let removed = try XCTUnwrap(had)
        let world = try await bound(store, timeout: 5)
        await store.holdNextLook()
        let session = world.session
        let joined = Ending()
        Task {
            do {
                _ = try await session.refresh()
                joined.set("")
            } catch {
                joined.set((error as? TulaError)?.code ?? "not a TulaError")
            }
        }
        await eventually("the refresh's look is out") { await store.waiting == 1 }

        try await world.client.removeDeviceKey()

        // Who joined the look before the removal is told the key could not be had, at once.
        await eventually("the refresh that had joined ended") { joined.value != nil }
        XCTAssertEqual(joined.value, "device.key_failed")
        await assertKept(world, refreshes: 1)

        // Who comes after the removal looks again, with the old look still out.
        world.api.on(
            "POST /v1/client/sign-ins", Reply(json: Fixture.attempt("sign_in", step: #"{"status":"needs_password"}"#)))
        _ = try await world.client.startSignIn(identifier: "maya@example.com")
        let looks = await store.looks
        XCTAssertEqual(looks, 3, "the look at the load, the one held, and a new one for the start")

        // The old look answers now, with the key that was removed. Nobody takes it.
        store.release()
        _ = try await world.client.startSignIn(identifier: "maya@example.com")
        let made = await store.made
        XCTAssertEqual(made, 1)
        let starts = world.api.requests("POST /v1/client/sign-ins")
        XCTAssertEqual(starts.count, 2)
        for start in starts {
            let proof = try XCTUnwrap(ReadProof(start))
            XCTAssertTrue(proof.verified)
            let jwk = proof.header["jwk"] as? [String: String]
            XCTAssertNotEqual(jwk?["x"], DeviceProofs.base64url(removed.x), "bound to a key the store no longer holds")
        }
    }

    /// Ask for a key apart from the test, and keep what came of it: the key's x coordinate,
    /// or the code of the error.
    private func asking(_ proofs: DeviceProofs, _ use: DeviceProofs.Use) -> Ending {
        let ended = Ending()
        Task {
            do {
                let key = try await proofs.key(for: use)
                ended.set(key.map { DeviceProofs.base64url($0.publicKey.x) } ?? "no key")
            } catch {
                ended.set((error as? TulaError)?.code ?? "not a TulaError")
            }
        }
        return ended
    }

    func testAStaleLookThatAnswersWhileANewLookIsOutAnswersNobodyAndEndsNothing() async throws {
        let store = HeldStore()
        let proofs = DeviceProofs(store: store)
        let had = await store.current
        let removed = DeviceProofs.base64url(try XCTUnwrap(had).x)

        // A look from before the removal, held, with a caller on it.
        let stale = await store.holdNextLook()
        let before = asking(proofs, .refresh)
        await eventually("the first look is out") { await store.waiting == 1 }
        try await proofs.remove(within: 5)
        await eventually("the caller from before the removal ended") { before.value != nil }
        XCTAssertEqual(before.value, "device.key_failed")

        // A look from after it, held as well, with a caller on it.
        let fresh = await store.holdNextLook()
        let first = asking(proofs, .start)
        await eventually("the new look is out") { await store.waiting == 2 }
        await eventually("its caller waits") { proofs.lookWaiters == 1 }

        // The stale look answers first, with the removed key.
        stale.open()
        await eventually("the stale look left the store") { await store.left == 1 }
        // A further caller joins the new look, which the stale answer did not end.
        let second = asking(proofs, .start)
        await eventually("a further caller joined the new look") { proofs.lookWaiters == 2 }
        XCTAssertNil(first.value, "the stale answer was given to a caller of the new look")
        var looks = await store.looks
        XCTAssertEqual(looks, 2, "the stale look and the new one, and none for the further caller")

        fresh.open()
        await eventually("both callers ended") { first.value != nil && second.value != nil }
        XCTAssertNotEqual(first.value, removed, "bound to a key the store no longer holds")
        XCTAssertNotEqual(second.value, removed, "bound to a key the store no longer holds")
        XCTAssertEqual(first.value, second.value)
        let now = await store.current
        XCTAssertEqual(first.value, DeviceProofs.base64url(try XCTUnwrap(now).x))
        looks = await store.looks
        XCTAssertEqual(looks, 2)
        let made = await store.made
        XCTAssertEqual(made, 1)
    }

    func testARemovalThatDidNotAnswerInTimeDropsTheLookAllTheSame() async throws {
        let store = HeldStore()
        let proofs = DeviceProofs(store: store)
        let had = await store.current
        let removed = DeviceProofs.base64url(try XCTUnwrap(had).x)
        let stale = await store.holdNextLook()
        let before = asking(proofs, .refresh)
        await eventually("the look is out") { await store.waiting == 1 }

        // The store takes longer than the deadline, and removes the key all the same.
        let removal = await store.holdRemoval()
        let code = await thrownCode { try await proofs.remove(within: 0.2) }
        XCTAssertEqual(code, "network.timeout")
        await eventually("the caller from before the removal ended") { before.value != nil }
        XCTAssertEqual(before.value, "device.key_failed")
        removal.open()
        await eventually("the store removed the key") { await store.removed == 1 }

        // A start now must not be handed what the look from before the removal answers.
        let start = asking(proofs, .start)
        await eventually("the start joined the old look or ended") {
            proofs.lookWaiters == 2 || start.value != nil
        }
        stale.open()
        await eventually("the start ended") { start.value != nil }
        XCTAssertNotEqual(start.value, removed, "bound to a key the store no longer holds")
        let now = await store.current
        XCTAssertEqual(start.value, DeviceProofs.base64url(try XCTUnwrap(now).x))
    }

    func testARemovalThatWasCancelledDropsTheLookAndIsAKeyFailure() async throws {
        let store = HeldStore()
        let proofs = DeviceProofs(store: store)
        let had = await store.current
        let removed = DeviceProofs.base64url(try XCTUnwrap(had).x)
        let stale = await store.holdNextLook()
        let before = asking(proofs, .refresh)
        await eventually("the look is out") { await store.waiting == 1 }

        // The store removes the key and only then notices that its caller was cancelled.
        let removal = await store.holdRemoval(noticingCancellation: true)
        let ended = Ending()
        let task = Task {
            do {
                try await proofs.remove(within: 5)
                ended.set("")
            } catch {
                ended.set((error as? TulaError)?.code ?? "not a TulaError")
            }
        }
        await eventually("the removal reached the store") { await store.removing == 1 }
        task.cancel()
        removal.open()
        await eventually("the cancelled removal ended") { ended.value != nil }
        XCTAssertEqual(ended.value, "device.key_failed")
        let gone = await store.removed
        XCTAssertEqual(gone, 1)
        await eventually("the caller from before the removal ended") { before.value != nil }
        XCTAssertEqual(before.value, "device.key_failed")

        let start = asking(proofs, .start)
        await eventually("the start joined the old look or ended") {
            proofs.lookWaiters == 2 || start.value != nil
        }
        stale.open()
        await eventually("the start ended") { start.value != nil }
        XCTAssertNotEqual(start.value, removed, "bound to a key the store no longer holds")
    }

    func testARemovalTheStoreRefusesDropsNoLook() async throws {
        let store = FailingStore()
        let proofs = DeviceProofs(store: store)
        await store.hold()
        let joined = asking(proofs, .refresh)
        await eventually("the look is out") { await store.reached == 1 }
        await eventually("its caller waits") { proofs.lookWaiters == 1 }
        await store.failRemoving()
        let code = await thrownCode { try await proofs.remove(within: 5) }
        XCTAssertEqual(code, "device.key_failed")
        XCTAssertEqual(proofs.lookWaiters, 1, "a removal the store refused dropped the look")
        XCTAssertNil(joined.value)
        await store.release()
        await eventually("the caller got the look's answer") { joined.value != nil }
        XCTAssertNotEqual(joined.value, "device.key_failed")
    }

    func testARemovalTheStoreRefusesIsAKeyFailureAndAClientWithNoStoreRemovesNothing() async throws {
        let store = FailingStore()
        let world = try await bound(store, timeout: 5)
        await store.failRemoving()
        let refused = await thrownCode { try await world.client.removeDeviceKey() }
        XCTAssertEqual(refused, "device.key_failed")
        let removals = await store.removals
        XCTAssertEqual(removals, 1)
        await assertKept(world, refreshes: 1)

        let plain = try await World.signedIn()
        try await plain.client.removeDeviceKey()
        let state = await plain.session.state
        XCTAssertTrue(state.isSignedIn)
    }

    func testARemovalTheStoreNeverAnswersEndsAtTheDeadline() async throws {
        let store = HungRemoval()
        let world = try await bound(store, timeout: 0.2)
        let code = await thrownCode { try await world.client.removeDeviceKey() }
        XCTAssertEqual(code, "network.timeout")
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
        let memory = MemoryTokenStorage()
        await memory.set("tula.refresh", "CANARY-refresh-token")
        let answer = ProviderRoundTrip.Answer(ticket: "CANARY-ticket", attemptId: "att_1", error: nil)

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
            ("MemoryTokenStorage", memory),
            ("ProviderRoundTrip.Answer", answer),
            ("a subclass of a redacted class", RedactedChild()),
            ("CallOptions", CallOptions(accessToken: "CANARY-access", attemptSecret: "CANARY-attempt-secret")),
            ("TulaSession", world.session),
            ("TulaClient", world.client),
            ("TulaStepUp", world.client.stepUp),
            ("TulaPasskeys", world.client.passkeys),
            ("TulaFactors", world.client.factors),
            ("TulaPhone", world.client.phone),
            ("TulaIdentities", world.client.identities),
            ("TulaEmailAddress", world.client.emailAddress),
            ("TulaOrganizations", world.client.organizations),
            ("TulaOrganizationInvitations", world.client.organizations.invitations),
            (
                "TulaInvitationLink",
                try XCTUnwrap(TulaInvitationLink.read("https://app.example/join#tula_invitation=CANARY-invitation"))
            ),
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

    private func signedOut(with store: FailingStore, failing error: any Error) async throws -> World {
        let world = try await bound(store, timeout: 5)
        await store.fail(with: error)
        world.api.on(Fixture.signOut, Reply(status: 204, json: ""))
        try await world.session.signOut()
        let state = await world.session.state
        XCTAssertEqual(state, .signedOut)
        return world
    }

    func testASignOutLeavesAKeyThatCouldNotBeHadJustNow() async throws {
        // Another client of the app may share the store, and its session is bound to the key:
        // a failure that may pass is never a reason to remove it.
        #if canImport(Security)
        let passing: [any Error] = [
            LoudFailure(), KeychainError(status: errSecInteractionNotAllowed), KeychainError(status: errSecAuthFailed),
            KeychainError(status: errSecDecode), CancellationError(),
            TulaError.client(TulaClientErrorCode.networkTimeout),
        ]
        #else
        let passing: [any Error] = [LoudFailure(), CancellationError()]
        #endif
        for error in passing {
            let store = FailingStore()
            _ = try await signedOut(with: store, failing: error)
            let removals = await store.removals
            XCTAssertEqual(removals, 0, "\(type(of: error)) says nothing lasting about the key")
        }
    }

    func testASignOutCancelledWhileTheStoreIsAskedRemovesNothingAlsoOfAKeyThatIsUnusable() async throws {
        let store = FailingStore()
        let world = try await bound(store, timeout: 5)
        await store.fail(with: TulaDeviceKeyStoreError.unusable)
        await store.hold()
        let before = await store.reached
        world.api.on(Fixture.signOut, Reply(status: 204, json: ""))
        let session = world.session
        let ended = Ending()
        let task = Task {
            try? await session.signOut()
            ended.set("")
        }
        await eventually("the sign-out's look is out") { await store.reached == before + 1 }
        let cancelled = Date()
        task.cancel()
        // The cancelled sign-out does not wait for the store, and has signed out.
        await eventually("the cancelled sign-out ended") { ended.value != nil }
        XCTAssertLessThan(
            Date().timeIntervalSince(cancelled), TulaSession.refreshTimeout / 2,
            "it ended for the cancellation, not by waiting out the look's deadline")
        let state = await world.session.state
        XCTAssertEqual(state, .signedOut)
        XCTAssertEqual(world.api.count(Fixture.signOut), 1)

        // The look answers "never again" now. Nobody is left to act on it.
        await store.release()
        await eventually("the look left the store") { await store.finished == before + 1 }
        let removals = await store.removals
        XCTAssertEqual(removals, 0, "the removal is best effort, and a cancelled sign-out has given it up")
    }

    func testASignOutAroundAStoreThatThrowsACancellationRemovesNothing() async throws {
        let store = FailingStore()
        let world = try await bound(store, timeout: 5)
        await store.fail(with: CancellationError())
        world.api.on(Fixture.signOut, Reply(status: 204, json: ""))
        let session = world.session
        let task = Task { try? await session.signOut() }
        task.cancel()
        _ = await task.value
        let removals = await store.removals
        XCTAssertEqual(removals, 0)
    }

    func testASignOutRemovesAKeyTheStoreSaysWillNeverBeHadAgainOnce() async throws {
        let store = FailingStore()
        let world = try await signedOut(with: store, failing: TulaDeviceKeyStoreError.unusable)
        let removals = await store.removals
        XCTAssertEqual(removals, 1)

        // The next sign-in is not stuck on it: it makes a new key and proves with that.
        world.api.on(
            "POST /v1/client/sign-ins", Reply(json: Fixture.attempt("sign_in", step: #"{"status":"needs_password"}"#)))
        _ = try await world.client.startSignIn(identifier: "maya@example.com")
        let proof = try XCTUnwrap(ReadProof(try XCTUnwrap(world.api.requests("POST /v1/client/sign-ins").first)))
        XCTAssertTrue(proof.verified)
    }

    func testARemovalThatFailsAtSignOutIsNotTheSignOutsFailure() async throws {
        let store = FailingStore()
        await store.failRemoving()
        // `signedOut` fails the test if the sign-out throws.
        _ = try await signedOut(with: store, failing: TulaDeviceKeyStoreError.unusable)
        let removals = await store.removals
        XCTAssertEqual(removals, 1, "asked once and left at that")
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

    func testAKeychainKeyThatNeverOpensAgainIsLeftByTheSignOutAndRemovedByTheApp() async throws {
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

        // A sign-out needs no proof. It leaves the item: nothing the Keychain or the enclave
        // answers is documented to mean "never again", and a locked device looks the same.
        world.api.on(Fixture.signOut, Reply(status: 204, json: ""))
        try await world.session.signOut()
        XCTAssertNil(world.api.requests(Fixture.signOut)[0].value(forHTTPHeaderField: "DPoP"))
        XCTAssertEqual(items.items.count, 1, "the adapter calls no failure permanent")
        world.api.on(
            "POST /v1/client/sign-ins", Reply(json: Fixture.attempt("sign_in", step: #"{"status":"needs_password"}"#)))
        let stuck = await thrownCode { _ = try await world.client.startSignIn(identifier: "maya@example.com") }
        XCTAssertEqual(stuck, "device.key_failed")
        XCTAssertEqual(world.api.count("POST /v1/client/sign-ins"), 0)

        // The app, which knows what it saw, removes it; the next sign-in makes a new key.
        try await world.client.removeDeviceKey()
        XCTAssertEqual(items.items.count, 0)
        _ = try await world.client.startSignIn(identifier: "maya@example.com")
        let proof = try XCTUnwrap(ReadProof(try XCTUnwrap(world.api.requests("POST /v1/client/sign-ins").first)))
        XCTAssertTrue(proof.verified)
        XCTAssertEqual(items.items.count, 1)
        let second = try await store.existing()
        XCTAssertNotNil(second)
        XCTAssertNotEqual(second?.publicKey, first.publicKey)
    }

    func testTheKeychainStoreCallsNoFailurePermanent() async throws {
        let items = KeychainTests.Items()
        let enclave = FadingEnclave()
        let store = keychain(items, enclave: enclave)
        _ = try await store.create()
        var thrown: [any Error] = []
        for status in [errSecInteractionNotAllowed, errSecAuthFailed, errSecDecode, errSecNotAvailable, -1] {
            items.force("copy", status)
            do { _ = try await store.existing() } catch { thrown.append(error) }
        }
        enclave.loseEverything()
        do { _ = try await store.existing() } catch { thrown.append(error) }
        XCTAssertEqual(thrown.count, 6)
        for error in thrown {
            XCTAssertNil(error as? TulaDeviceKeyStoreError, "\(type(of: error))")
        }
    }
    #endif
}
