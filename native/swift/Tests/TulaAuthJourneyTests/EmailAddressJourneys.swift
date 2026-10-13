import Foundation
import XCTest

@testable import TulaAuth

// The Swift client against the real API: an account made through a provider that gives no
// address (X) gets one (ADR 0059). Its user asks for a code and proves the address, an
// administrator may give it one, and the accounts that depend on the provider are counted
// before it is switched off. The provider is the API's own mock provider and the browser is
// the journey; no journey opens a browser.
final class EmailAddressJourneys: JourneyTestCase {
    private func snowflake() -> String { String(UInt64.random(in: 1...999_999_999_999_999_999)) }

    /// An API whose providers are the mock provider, with Google and X saved.
    private func xServer() async throws -> Server {
        let s = try await server(oauth: true)
        try await s.provider("google")
        try await s.provider("x")
        return s
    }

    /// Somebody who signed up with X: signed in, with no email address.
    private func withX(_ s: Server) async throws -> App {
        let made = try await s.continueWith(.x, ["subject": snowflake()])
        XCTAssertEqual(made.outcome.word, "signed_in")
        let user = try unwrap(await made.app.user())
        XCTAssertNil(user.email)
        return made.app
    }

    func testAnEmailAddressForAnAccountWithoutOne() async throws {
        try await journey(
            "an email address for an account without one",
            "an account with no address: its user asks for a code, proves the address and has it; a taken address is answered like a free one and confirms nothing; an old session is told to sign in again"
        ) { _ in
            let s = try await self.xServer()
            let app = try await self.withX(s)
            let address = s.freshEmail()

            let malformed = try await caught { try await app.tula.emailAddress.request("not an address") }
            XCTAssertEqual(malformed.code, "email.invalid")
            let receipt = try await app.tula.emailAddress.request(address)
            XCTAssertTrue(receipt.destination.contains("***@"))
            let code = try await s.code(address)
            XCTAssertFalse(receipt.destination.contains(code))
            // Asking stores nothing on the account.
            var seen = try await app.tula.user()
            XCTAssertNil(seen.email)
            let hurried = try await caught { try await app.tula.emailAddress.request(address) }
            XCTAssertEqual(hurried.code, "rate_limited")

            let wrong = try await caught {
                try await app.tula.emailAddress.verify(code: code == "000000" ? "111111" : "000000")
            }
            XCTAssertEqual(wrong.code, "verification.invalid_code")
            let user = try await app.tula.emailAddress.verify(code: code)
            XCTAssertEqual(user.email, address)
            XCTAssertNotNil(user.emailVerifiedAt)
            // The client shows the address without asking again.
            let held = await app.user()
            XCTAssertEqual(held?.email, address)
            // The calls are for an account with no address only.
            let again = try await caught { try await app.tula.emailAddress.request(s.freshEmail()) }
            XCTAssertEqual(again.code, "email.already_set")
            let spent = try await caught { try await app.tula.emailAddress.verify(code: code) }
            XCTAssertEqual(spent.code, "email.already_set")

            // Another person asks for that address: the same receipt, and no code confirms it.
            let other = try await self.withX(s)
            let taken = try await other.tula.emailAddress.request(address)
            XCTAssertEqual(taken.destination, receipt.destination)
            let refused = try await caught { try await other.tula.emailAddress.verify(code: code) }
            XCTAssertEqual(refused.code, "verification.invalid_code")
            seen = try await other.tula.user()
            XCTAssertNil(seen.email)

            // Past the step-up window a user with nothing to step up with is told so: no
            // method is listed, and they sign in again with their provider.
            let late = try await self.withX(s)
            try await s.advance(11 * 60)
            let stale = try await caught { try await late.tula.emailAddress.request(s.freshEmail()) }
            XCTAssertEqual(stale.code, "auth.step_up_required")
            XCTAssertEqual(stale.stepUpMethods, [])
            seen = try await late.tula.user()
            XCTAssertNil(seen.email)
        }
    }

    func testAnAdministratorGivesAnAccountAnEmailAddress() async throws {
        try await journey(
            "an administrator gives an account an email address",
            "an administrator gives an account with no address one: the client sees it unverified, and the user's own call then answers that the account has an address"
        ) { _ in
            let s = try await self.xServer()
            let app = try await self.withX(s)
            let id = try unwrap(await app.user()).id
            let address = s.freshEmail()
            let set = try await s.admin("PUT", "/v1/admin/users/\(id)/email", ["email": address])
            XCTAssertEqual(set.status, 200)
            XCTAssertEqual(set.object["email"] as? String, address)
            XCTAssertTrue(set.object["emailVerifiedAt"] is NSNull)

            let user = try await app.tula.user()
            XCTAssertEqual(user.email, address)
            XCTAssertNil(user.emailVerifiedAt)
            let own = try await caught { try await app.tula.emailAddress.request(s.freshEmail()) }
            XCTAssertEqual(own.code, "email.already_set")

            // Never a replacement, and never an address another account holds.
            let again = try await s.admin("PUT", "/v1/admin/users/\(id)/email", ["email": s.freshEmail()])
            XCTAssertEqual(again.status, 409)
            XCTAssertEqual(again.object["code"] as? String, "email.already_set")
            let other = try await self.withX(s)
            let otherId = try unwrap(await other.user()).id
            let conflict = try await s.admin("PUT", "/v1/admin/users/\(otherId)/email", ["email": address])
            XCTAssertEqual(conflict.status, 409)
            XCTAssertEqual(conflict.object["code"] as? String, "resource.conflict")
            let untouched = try await other.tula.user()
            XCTAssertNil(untouched.email)
        }
    }

    func testAccountsThatDependOnAProviderAreCountedBeforeItIsSwitchedOff() async throws {
        try await journey(
            "accounts that depend on a provider are counted before it is switched off",
            "the accounts that could not sign in without a provider are counted; switching it off is not refused, and the client is then told the method is off"
        ) { _ in
            let s = try await self.xServer()
            var count = try await s.admin("GET", "/v1/admin/oauth-providers/x/dependents")
            XCTAssertEqual(count.status, 200)
            XCTAssertEqual(count.object["accounts"] as? Int, 0)
            _ = try await self.withX(s)
            _ = try await self.withX(s)
            count = try await s.admin("GET", "/v1/admin/oauth-providers/x/dependents")
            XCTAssertEqual(count.object["provider"] as? String, "x")
            XCTAssertEqual(count.object["accounts"] as? Int, 2)
            XCTAssertEqual(count.object["more"] as? Bool, false)

            try await s.provider("x", ["enabled": false])
            // What the client observes: a start is told the method is off, as the round
            // trip's refusal or as the call's error. Either way it is the contract's code.
            var word = ""
            do {
                word = try await s.continueWith(.x, ["subject": self.snowflake()]).outcome.word
            } catch let error as TulaError {
                word = error.code
            }
            XCTAssertEqual(word, "auth.method_disabled")
        }
    }
}
