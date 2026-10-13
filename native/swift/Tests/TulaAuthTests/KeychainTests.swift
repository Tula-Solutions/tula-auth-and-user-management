#if canImport(Security)
import Foundation
import Security
import XCTest

@testable import TulaAuth

// The Keychain store on a stand-in for the four Security calls it makes. What is checked is
// what the store asks for (the attributes of the item) and what it does with each status.
// The real Keychain is not asked by any test: docs/plans/phase-2-unverified.md says so.
final class KeychainTests: XCTestCase {
    /// The Security framework's four calls, on a dictionary.
    final class Items: KeychainItems, @unchecked Sendable {
        private let lock = NSLock()
        private var stored: [String: [String: Any]] = [:]
        private var log: [(call: String, query: [String: Any])] = []
        private var forced: [String: [OSStatus]] = [:]

        /// A forced status that is no status: that call works as it would have.
        static let real: OSStatus = 1

        /// The next calls of `call` answer these statuses, in order, instead of working.
        func force(_ call: String, _ statuses: OSStatus...) {
            force(call, statuses)
        }

        func force(_ call: String, _ statuses: [OSStatus]) {
            lock.withLock { forced[call] = statuses }
        }

        var calls: [String] { lock.withLock { log.map(\.call) } }
        func queries(_ call: String) -> [[String: Any]] { lock.withLock { log.filter { $0.call == call }.map(\.query) } }
        var items: [[String: Any]] { lock.withLock { Array(stored.values) } }
        func plant(_ id: String, _ item: [String: Any]) { lock.withLock { stored[id] = item } }

        private func id(_ query: [String: Any]) -> String {
            "\(query[kSecAttrService as String] ?? "")|\(query[kSecAttrAccount as String] ?? "")"
        }

        private func begin(_ call: String, _ query: [String: Any]) -> OSStatus? {
            log.append((call, query))
            guard var queue = forced[call], !queue.isEmpty else { return nil }
            let status = queue.removeFirst()
            forced[call] = queue
            return status == Items.real ? nil : status
        }

        func copyMatching(_ query: [String: Any]) -> (status: OSStatus, data: Data?) {
            lock.withLock {
                if let status = begin("copy", query) { return (status, nil) }
                guard let item = stored[id(query)] else { return (errSecItemNotFound, nil) }
                return (errSecSuccess, item[kSecValueData as String] as? Data)
            }
        }

        func add(_ attributes: [String: Any]) -> OSStatus {
            lock.withLock {
                if let status = begin("add", attributes) { return status }
                guard stored[id(attributes)] == nil else { return errSecDuplicateItem }
                stored[id(attributes)] = attributes
                return errSecSuccess
            }
        }

        func update(_ query: [String: Any], _ attributes: [String: Any]) -> OSStatus {
            lock.withLock {
                if let status = begin("update", query) { return status }
                guard let item = stored[id(query)] else { return errSecItemNotFound }
                stored[id(query)] = item.merging(attributes) { _, new in new }
                return errSecSuccess
            }
        }

        func delete(_ query: [String: Any]) -> OSStatus {
            lock.withLock {
                if let status = begin("delete", query) { return status }
                return stored.removeValue(forKey: id(query)) == nil ? errSecItemNotFound : errSecSuccess
            }
        }
    }

    private func store(_ items: Items, _ accessibility: KeychainAccessibility = .whenUnlocked) -> KeychainTokenStorage {
        KeychainTokenStorage(service: "dev.tula.auth.tests", accessibility: accessibility, items: items)
    }

    private func status(_ work: () async throws -> Void) async -> OSStatus? {
        do {
            try await work()
            XCTFail("nothing was thrown")
            return nil
        } catch {
            return (error as? KeychainError)?.status
        }
    }

    func testATokenIsAGenericPasswordThatStaysOnThisDevice() async throws {
        let items = Items()
        try await store(items).set("tula.refresh.a", "refresh-one")
        XCTAssertEqual(items.calls, ["update", "add"])
        let item = try XCTUnwrap(items.items.first)
        XCTAssertEqual(item[kSecClass as String] as? String, kSecClassGenericPassword as String)
        XCTAssertEqual(item[kSecAttrService as String] as? String, "dev.tula.auth.tests")
        XCTAssertEqual(item[kSecAttrAccount as String] as? String, "tula.refresh.a")
        XCTAssertEqual(item[kSecAttrSynchronizable as String] as? Bool, false, "never in iCloud Keychain")
        XCTAssertEqual(item[kSecUseDataProtectionKeychain as String] as? Bool, true)
        XCTAssertEqual(
            item[kSecAttrAccessible as String] as? String, kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
        XCTAssertEqual(item[kSecValueData as String] as? Data, Data("refresh-one".utf8))
        // Nothing else: no access group, no label, no comment that could hold anything.
        XCTAssertEqual(item.count, 7)
    }

    func testBothAccessibilityClassesKeepTheItemOnThisDevice() async throws {
        XCTAssertEqual(
            KeychainAccessibility.whenUnlocked.attribute as String,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
        XCTAssertEqual(
            KeychainAccessibility.afterFirstUnlock.attribute as String,
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        let items = Items()
        try await store(items, .afterFirstUnlock).set("k", "v")
        XCTAssertEqual(
            items.items[0][kSecAttrAccessible as String] as? String,
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
    }

    func testAReplacedTokenIsOneItemAndItsClassIsSetAgain() async throws {
        let items = Items()
        try await store(items, .afterFirstUnlock).set("k", "one")
        try await store(items, .whenUnlocked).set("k", "two")
        XCTAssertEqual(items.items.count, 1)
        XCTAssertEqual(items.calls, ["update", "add", "update"])
        XCTAssertEqual(
            items.items[0][kSecAttrAccessible as String] as? String,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String,
            "an item written with a wider class does not keep it")
        let value = try await store(items).get("k")
        XCTAssertEqual(value, "two")
    }

    func testAReadAsksForOneItemsDataAndNothingStoredIsNil() async throws {
        let items = Items()
        var value = try await store(items).get("k")
        XCTAssertNil(value)
        try await store(items).set("k", "one")
        value = try await store(items).get("k")
        XCTAssertEqual(value, "one")
        let query = try XCTUnwrap(items.queries("copy").last)
        XCTAssertEqual(query[kSecReturnData as String] as? Bool, true)
        XCTAssertEqual(query[kSecMatchLimit as String] as? String, kSecMatchLimitOne as String)
        XCTAssertEqual(query[kSecAttrSynchronizable as String] as? Bool, false)
        XCTAssertEqual(query[kSecUseDataProtectionKeychain as String] as? Bool, true)
    }

    func testAReadThatFailsIsThrownAndNeverAnsweredAsNothingStored() async throws {
        let items = Items()
        try await store(items).set("k", "one")
        for failure in [errSecInteractionNotAllowed, errSecAuthFailed, errSecMissingEntitlement, errSecNotAvailable] {
            items.force("copy", failure)
            let thrown = await status { _ = try await self.store(items).get("k") }
            XCTAssertEqual(thrown, failure)
        }
        // An item that is there and is not a token is a failure too.
        items.plant("dev.tula.auth.tests|bytes", [kSecValueData as String: Data([0xFF, 0xFE])])
        items.plant("dev.tula.auth.tests|empty", [kSecValueData as String: Data()])
        items.plant("dev.tula.auth.tests|none", [:])
        for key in ["bytes", "empty", "none"] {
            let thrown = await status { _ = try await self.store(items).get(key) }
            XCTAssertEqual(thrown, errSecDecode, key)
        }
    }

    func testAWriteThatFailsIsThrown() async throws {
        let items = Items()
        items.force("update", errSecInteractionNotAllowed)
        var thrown = await status { try await self.store(items).set("k", "one") }
        XCTAssertEqual(thrown, errSecInteractionNotAllowed)
        items.force("add", errSecMissingEntitlement)
        thrown = await status { try await self.store(items).set("k", "one") }
        XCTAssertEqual(thrown, errSecMissingEntitlement)
        XCTAssertTrue(items.items.isEmpty)
    }

    func testAnotherWriterBetweenTheTwoCallsIsNotAFailure() async throws {
        let items = Items()
        try await store(items).set("k", "theirs")
        // The update finds nothing, the add finds theirs: the update is made again.
        items.force("update", errSecItemNotFound)
        try await store(items).set("k", "mine")
        XCTAssertEqual(items.calls.suffix(3), ["update", "add", "update"])
        let value = try await store(items).get("k")
        XCTAssertEqual(value, "mine")
    }

    func testRemovingNothingIsNotAFailureAndAFailedRemoveIs() async throws {
        let items = Items()
        try await store(items).remove("k")
        try await store(items).set("k", "one")
        try await store(items).remove("k")
        XCTAssertTrue(items.items.isEmpty)
        items.force("delete", errSecInteractionNotAllowed)
        let thrown = await status { try await self.store(items).remove("k") }
        XCTAssertEqual(thrown, errSecInteractionNotAllowed)
    }

    func testAKeychainErrorHoldsItsStatusAndNothingOfTheToken() async throws {
        let items = Items()
        items.force("update", errSecInteractionNotAllowed)
        do {
            try await store(items).set("k", "refresh-canary")
            XCTFail("nothing was thrown")
        } catch {
            XCTAssertFalse(String(reflecting: error).contains("canary"))
        }
    }

    /// The rule the storage exists for, through the client: a Keychain that cannot be read
    /// (a locked device) is `storage.failed` with the session not ended, and the same client
    /// signs in from the stored token once it can be read.
    func testALockedKeychainIsNotSignedOut() async throws {
        let items = Items()
        let api = FakeAPI()
        api.on(Fixture.refresh, Reply(json: Fixture.tokens("first")))
        api.always(Fixture.me) { _ in Reply(json: Fixture.user) }
        try await store(items).set(Fixture.storageKey, "refresh-stored")
        let client = try TulaClient(
            publishableKey: Fixture.key, baseURL: Fixture.base, storage: store(items), transport: api)
        items.force("copy", errSecInteractionNotAllowed)
        let session = client.session
        let code = await thrownCode { _ = try await session.load() }
        XCTAssertEqual(code, TulaClientErrorCode.storageFailed)
        var state = await session.state
        XCTAssertEqual(state, .loading)
        XCTAssertEqual(api.requests.count, 0)

        state = try await session.load()
        XCTAssertTrue(state.isSignedIn)
        let stored = try await store(items).get(Fixture.storageKey)
        XCTAssertEqual(stored, "refresh-first")
    }

    func testTheSystemItemsAreWhatTheStoreIsMadeWithByDefault() {
        // Built, not asked: no test touches the Keychain of the machine it runs on.
        _ = KeychainTokenStorage()
        _ = KeychainTokenStorage(service: "dev.tula.auth.tests", accessibility: .afterFirstUnlock)
        XCTAssertEqual(KeychainError(status: errSecDecode).status, errSecDecode)
    }
}
#endif
