import Foundation
import XCTest

@testable import TulaAuth

// Organizations on a fake API (ADR 0065): what the client sends, what it refuses to believe,
// how the access token that carries the active organization is installed, and how the claims
// are read. The client against the real API is `OrganizationJourneys`.
final class OrganizationTests: XCTestCase {
    private let active = "PUT /v1/client/me/organizations/active"
    private let list = "GET /v1/client/me/organizations"
    private let preview = "POST /v1/client/organization-invitations/preview"
    private let accept = "POST /v1/client/me/organization-invitations/accept"
    private let decline = "POST /v1/client/me/organization-invitations/decline"

    private let organization =
        #"{"id":"org_1","name":"Acme","slug":"acme","role":"admin","permissions":["org:sys:memberships:read"],"createdAt":"2026-01-01T00:00:00.000Z"}"#

    /// An access token as the API issues one for an active organization: `iat`, `exp` and the
    /// three claims. Only the claims are read here.
    private func token(_ name: String, claims: String = "", session: String = "ses_1") -> String {
        let payload = #"{"iat":1000,"exp":1060,"jti":"\#(name)"\#(claims.isEmpty ? "" : "," + claims)}"#
        return "\(Fixture.base64url(#"{"alg":"EdDSA"}"#)).\(Fixture.base64url(payload)).signature-\(name)"
    }

    private func orgClaims(
        id: String = "org_1", role: String = "admin", permissions: String = #"["org:sys:memberships:read","org:billing:read"]"#
    ) -> String {
        #""org_id":"\#(id)","org_role":"\#(role)","org_perms":\#(permissions)"#
    }

    private func chosen(_ name: String, organizationId: String?, claims: String, session: String = "ses_1") -> Reply {
        let id = organizationId.map { #""\#($0)""# } ?? "null"
        return Reply(
            json:
                #"{"sessionId":"\#(session)","organizationId":\#(id),"accessToken":"\#(token(name, claims: claims))","accessTokenExpiresAt":"2030-01-01T00:00:00.000Z"}"#
        )
    }

    // MARK: Choosing the organization the session acts in

    func testChoosingAnOrganizationInstallsOnlyTheAccessTokenItAnswersWith() async throws {
        let world = try await World.signedIn()
        world.api.on(active, chosen("chosen", organizationId: "org_1", claims: orgClaims()))
        let answer = try await world.client.organizations.setActive("org_1")
        XCTAssertEqual(answer.organizationId, "org_1")

        let sent = world.api.requests(active)[0]
        XCTAssertEqual(sent.value(forHTTPHeaderField: "authorization"), "Bearer \(Fixture.accessToken("first"))")
        XCTAssertEqual(Fixture.body(sent)["organizationId"] as? String, "org_1")
        let held = try await world.session.getToken()
        XCTAssertEqual(held, token("chosen", claims: orgClaims()))
        let stored = await world.storage.only
        XCTAssertEqual(stored, "refresh-first", "choosing rotates no refresh token")
        XCTAssertEqual(world.api.count(Fixture.refresh), 1, "and asks for none")

        let claims = try await world.client.organizations.active()
        XCTAssertEqual(claims?.organizationId, "org_1")
        XCTAssertEqual(claims?.role, "admin")
        let can = try await world.client.organizations.has(permission: "org:billing:read")
        XCTAssertTrue(can)
        let cannot = try await world.client.organizations.has(permission: "org:billing:manage")
        XCTAssertFalse(cannot)
        let isAdmin = try await world.client.organizations.has(role: "admin")
        XCTAssertTrue(isAdmin)
    }

    func testTheRefreshTokenOfAChoiceIsIgnoredAndTheSessionStaysSignedIn() async throws {
        let world = try await World.signedIn()
        let withRefresh = Reply(
            json:
                #"{"sessionId":"ses_1","organizationId":"org_1","accessToken":"\#(token("chosen", claims: orgClaims()))","accessTokenExpiresAt":"2030-01-01T00:00:00.000Z","refreshToken":"refresh-stolen"}"#
        )
        world.api.on(active, withRefresh)
        _ = try await world.client.organizations.setActive("org_1")
        let stored = await world.storage.only
        XCTAssertEqual(stored, "refresh-first", "a refresh token in a choice's answer replaces nothing")
        let state = await world.session.state
        XCTAssertTrue(state.isSignedIn)
    }

    func testTheNullAccountIsChosenWithANullAndTheClaimsGoAway() async throws {
        let world = try await World.signedIn()
        world.api.on(active, chosen("chosen", organizationId: "org_1", claims: orgClaims()))
        _ = try await world.client.organizations.setActive("org_1")
        world.api.on(active, chosen("personal", organizationId: nil, claims: ""))
        let answer = try await world.client.organizations.clearActive()
        XCTAssertNil(answer.organizationId)
        let body = world.api.requests(active).last.flatMap { $0.httpBody }.flatMap { String(data: $0, encoding: .utf8) }
        XCTAssertEqual(body, #"{"organizationId":null}"#, "the personal account is a null, not a missing key")
        let claims = try await world.client.organizations.active()
        XCTAssertNil(claims)
        let any = try await world.client.organizations.has(role: "admin")
        XCTAssertFalse(any, "no active organization grants nothing")
    }

    func testAChoiceThatIsNotWhatWasAskedForOrCannotBeInstalledIsRefused() async throws {
        let world = try await World.signedIn()
        // Another organization than the one asked for.
        world.api.on(active, chosen("other", organizationId: "org_2", claims: orgClaims(id: "org_2")))
        let wrongOrganization = await thrownCode { _ = try await world.client.organizations.setActive("org_1") }
        XCTAssertEqual(wrongOrganization, "response.invalid")
        // The personal account asked for, an organization answered.
        world.api.on(active, chosen("other", organizationId: "org_1", claims: orgClaims()))
        let wrongNull = await thrownCode { _ = try await world.client.organizations.setActive(nil) }
        XCTAssertEqual(wrongNull, "response.invalid")
        // No access token: a stateful session's answer, which is no session for this client.
        world.api.on(active, Reply(json: #"{"sessionId":"ses_1","organizationId":"org_1"}"#))
        let tokenless = await thrownCode { _ = try await world.client.organizations.setActive("org_1") }
        XCTAssertEqual(tokenless, "response.invalid")
        // Another session than this client's.
        world.api.on(active, chosen("foreign", organizationId: "org_1", claims: orgClaims(), session: "ses_2"))
        let foreign = await thrownCode { _ = try await world.client.organizations.setActive("org_1") }
        XCTAssertEqual(foreign, "auth.unauthenticated")
        // The API's refusal is thrown as it is.
        world.api.on(active, Reply.error(403, "organization.not_a_member"))
        let refused = await thrownCode { _ = try await world.client.organizations.setActive("org_1") }
        XCTAssertEqual(refused, "organization.not_a_member")
        let held = try await world.session.getToken()
        XCTAssertEqual(held, Fixture.accessToken("first"), "a choice that was refused changes nothing")

        let signedOut = try World()
        _ = try await signedOut.session.load()
        let nobody = await thrownCode { _ = try await signedOut.client.organizations.setActive("org_1") }
        XCTAssertEqual(nobody, "auth.unauthenticated")
        XCTAssertEqual(signedOut.api.count(active), 0, "nothing was sent for nobody")
    }

    func testAChoiceOvertakenByARefreshIsCarriedByOneRefreshStartedAfterIt() async throws {
        let world = try await World.signedIn()
        let gate = Gate()
        let reply = chosen("chosen", organizationId: "org_1", claims: orgClaims())
        world.api.on(active) { _ in
            await gate.wait()
            return reply
        }
        let choosing = Task { try await world.client.organizations.setActive("org_1") }
        await eventually("the choice is on its way") { world.api.count(self.active) == 1 }
        world.api.on(Fixture.refresh, Reply(json: Fixture.tokens("second")))
        _ = try await world.session.refresh()
        world.api.on(Fixture.refresh, Reply(json: Fixture.tokens("third")))
        gate.open()
        _ = try await choosing.value
        let held = try await world.session.getToken()
        XCTAssertEqual(held, Fixture.accessToken("third"), "neither earlier token is trusted")
        XCTAssertEqual(world.api.count(Fixture.refresh), 3)
    }

    func testAPathParameterThatIsNotOneSegmentCannotChangeTheRoute() async throws {
        let world = try await World.signedIn()
        for refused in ["", ".", ".."] {
            let code = await thrownCode { _ = try await world.client.organizations.join(refused) }
            XCTAssertNotNil(code, "`\(refused)` was sent")
        }
        XCTAssertEqual(world.api.routes.filter { $0.contains("organizations") }, [], "nothing was sent")
        // A slash is part of the one segment, escaped: it is never another route.
        _ = await thrownCode { _ = try await world.client.organizations.join("a/b") }
        let sent = try XCTUnwrap(world.api.requests.last?.url?.absoluteString)
        XCTAssertTrue(sent.hasSuffix("/organizations/suggestions/a%2Fb/join"), sent)
    }

    // MARK: The calls

    func testTheCallsGoToTheirRoutesWithTheirBodies() async throws {
        let world = try await World.signedIn()
        world.api.on(
            list,
            Reply(
                json:
                    #"{"activeOrganizationId":null,"meta":{"totalCount":1,"totalPages":1,"page":1,"perPage":20},"data":[\#(organization)]}"#
            ))
        let page = try await world.client.organizations.list()
        XCTAssertEqual(page.data.map(\.id), ["org_1"])
        XCTAssertNil(page.activeOrganizationId)

        world.api.on(list.replacingOccurrences(of: "GET", with: "POST"), Reply(status: 201, json: organization))
        let created = try await world.client.organizations.create(name: "Acme", slug: "acme")
        XCTAssertEqual(created.role, "admin")
        let createBody = Fixture.body(world.api.requests("POST /v1/client/me/organizations")[0])
        XCTAssertEqual(createBody["name"] as? String, "Acme")
        XCTAssertEqual(createBody["slug"] as? String, "acme")

        world.api.on(
            "GET /v1/client/me/organizations/suggestions",
            Reply(json: #"{"data":[{"id":"org_1","name":"Acme","slug":"acme"}]}"#))
        let offered = try await world.client.organizations.suggestions()
        XCTAssertEqual(offered.data.map(\.name), ["Acme"])
        world.api.on("POST /v1/client/me/organizations/suggestions/org_1/join", Reply(status: 201, json: organization))
        let joined = try await world.client.organizations.join("org_1")
        XCTAssertEqual(joined.id, "org_1")
        // A joined organization with no id is not one.
        world.api.on(
            "POST /v1/client/me/organizations/suggestions/org_1/join",
            Reply(
                status: 201,
                json: organization.replacingOccurrences(of: #""id":"org_1""#, with: #""id":"""#)))
        let invalid = await thrownCode { _ = try await world.client.organizations.join("org_1") }
        XCTAssertEqual(invalid, "response.invalid")
    }

    func testManagingAnOrganizationGoesToItsRoutesWithItsBodies() async throws {
        let world = try await World.signedIn()
        let org = "/v1/client/me/organizations/org_1"
        let member =
            #"{"userId":"usr_2","name":null,"email":"b@example.com","role":"admin","createdAt":"2026-01-01T00:00:00.000Z"}"#

        world.api.on("PATCH \(org)", Reply(json: organization))
        let renamed = try await world.client.organizations.update(organizationId: "org_1", name: "Acme Inc")
        XCTAssertEqual(renamed.id, "org_1")
        let patch = Fixture.body(world.api.requests("PATCH \(org)")[0])
        XCTAssertEqual(patch["name"] as? String, "Acme Inc")
        XCTAssertNil(patch["slug"], "a field left out is not sent")

        world.api.on("PATCH \(org)", Reply(json: organization.replacingOccurrences(of: #""id":"org_1""#, with: #""id":"""#)))
        let invalid = await thrownCode { _ = try await world.client.organizations.update(organizationId: "org_1", name: "x") }
        XCTAssertEqual(invalid, "response.invalid", "an answer that names no organization is not one")

        world.api.on("DELETE \(org)", Reply(status: 204, json: ""))
        try await world.client.organizations.remove(organizationId: "org_1")
        XCTAssertEqual(world.api.requests("DELETE \(org)").count, 1)

        world.api.on("GET \(org)/roles", Reply(json: #"{"data":[{"key":"admin","name":"Admin"}]}"#))
        let roles = try await world.client.organizations.roles(organizationId: "org_1")
        XCTAssertEqual(roles.data.map(\.key), ["admin"])

        world.api.on(
            "GET \(org)/members",
            Reply(json: #"{"meta":{"totalCount":1,"totalPages":1,"page":1,"perPage":20},"data":[\#(member)]}"#))
        let members = try await world.client.organizations.members.list(organizationId: "org_1")
        XCTAssertEqual(members.data.map(\.userId), ["usr_2"])

        world.api.on("PATCH \(org)/members/usr_2", Reply(json: member))
        let changed = try await world.client.organizations.members.changeRole(
            organizationId: "org_1", userId: "usr_2", role: "admin")
        XCTAssertEqual(changed.role, "admin")
        XCTAssertEqual(Fixture.body(world.api.requests("PATCH \(org)/members/usr_2")[0])["role"] as? String, "admin")

        world.api.on("DELETE \(org)/members/usr_2", Reply(status: 204, json: ""))
        try await world.client.organizations.members.remove(organizationId: "org_1", userId: "usr_2")
        XCTAssertEqual(world.api.requests("DELETE \(org)/members/usr_2").count, 1)
    }

    func testLeavingRemovesTheSignedInUsersOwnMembership() async throws {
        let world = try await World.signedIn()
        world.api.on(Fixture.me, Reply(json: Fixture.user))
        _ = try await world.client.user()
        let own = "DELETE /v1/client/me/organizations/org_1/members/usr_1"
        world.api.on(own, Reply(status: 204, json: ""))
        try await world.client.organizations.leave(organizationId: "org_1")
        XCTAssertEqual(world.api.requests(own).count, 1, "the user's own id is the member removed")
    }

    func testLeavingAsksForTheUserWhenTheProfileIsNotHeldYet() async throws {
        let world = try await World.signedIn()
        world.api.on(Fixture.me, Reply(json: Fixture.user))
        let own = "DELETE /v1/client/me/organizations/org_1/members/usr_1"
        world.api.on(own, Reply(status: 204, json: ""))
        try await world.client.organizations.leave(organizationId: "org_1")
        XCTAssertEqual(world.api.requests(own).count, 1)
    }

    func testDomainsGoToTheirRoutesWithTheirBodies() async throws {
        let world = try await World.signedIn()
        let base = "/v1/client/me/organizations/org_1/domains"
        let row =
            #"{"id":"dom_1","domain":"acme.com","mode":"suggest","status":"pending","verifiedAt":null,"expiresAt":null,"codeExpiresAt":"2026-01-01T01:00:00.000Z","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}"#

        world.api.on("GET \(base)", Reply(json: #"{"data":[\#(row)]}"#))
        let listed = try await world.client.organizations.domains.list(organizationId: "org_1")
        XCTAssertEqual(listed.data.map(\.status), [.pending])

        world.api.on("POST \(base)", Reply(status: 201, json: row))
        let started = try await world.client.organizations.domains.start(
            organizationId: "org_1", domain: "acme.com", email: "ada@acme.com", mode: .suggest)
        XCTAssertEqual(started.id, "dom_1")
        let startBody = Fixture.body(world.api.requests("POST \(base)")[0])
        XCTAssertEqual(startBody["domain"] as? String, "acme.com")
        XCTAssertEqual(startBody["email"] as? String, "ada@acme.com")
        XCTAssertEqual(startBody["mode"] as? String, "suggest")

        let verifiedRow = row.replacingOccurrences(of: #""status":"pending""#, with: #""status":"verified""#)
        world.api.on("POST \(base)/dom_1/verify", Reply(json: verifiedRow))
        let verified = try await world.client.organizations.domains.verify(
            organizationId: "org_1", domainId: "dom_1", code: "123456")
        XCTAssertEqual(verified.status, .verified)
        XCTAssertEqual(Fixture.body(world.api.requests("POST \(base)/dom_1/verify")[0])["code"] as? String, "123456")

        world.api.on("PATCH \(base)/dom_1", Reply(json: verifiedRow))
        _ = try await world.client.organizations.domains.update(
            organizationId: "org_1", domainId: "dom_1", mode: .autoJoin)
        XCTAssertEqual(Fixture.body(world.api.requests("PATCH \(base)/dom_1")[0])["mode"] as? String, "auto_join")

        world.api.on("DELETE \(base)/dom_1", Reply(status: 204, json: ""))
        try await world.client.organizations.domains.remove(organizationId: "org_1", domainId: "dom_1")
        XCTAssertEqual(world.api.requests("DELETE \(base)/dom_1").count, 1)

        // A status this version does not know is kept as the API wrote it, not refused.
        world.api.on(
            "GET \(base)",
            Reply(json: #"{"data":[\#(row.replacingOccurrences(of: #""status":"pending""#, with: #""status":"needs_reverification""#))]}"#))
        let again = try await world.client.organizations.domains.list(organizationId: "org_1")
        XCTAssertEqual(again.data.map(\.status), [.needsReverification])
    }

    func testAnIdThatIsNotOneSegmentCannotChangeTheRouteOfAManagementCall() async throws {
        let world = try await World.signedIn()
        for refused in ["", ".", ".."] {
            let members = await thrownCode { _ = try await world.client.organizations.members.list(organizationId: refused) }
            XCTAssertNotNil(members, "`\(refused)` was sent")
            let domains = await thrownCode { _ = try await world.client.organizations.domains.list(organizationId: refused) }
            XCTAssertNotNil(domains, "`\(refused)` was sent")
        }
        XCTAssertEqual(world.api.routes.filter { $0.contains("organizations") }, [], "nothing was sent")
        // A slash is part of the one segment, escaped: it is never another route.
        _ = await thrownCode { _ = try await world.client.organizations.domains.remove(organizationId: "a/b", domainId: "d") }
        let sent = try XCTUnwrap(world.api.requests.last?.url?.absoluteString)
        XCTAssertTrue(sent.hasSuffix("/organizations/a%2Fb/domains/d"), sent)
    }

    func testInvitationsGoToTheirRoutesAndThePreviewNeedsNoSession() async throws {
        // Signed out: only a preview works.
        let visitor = try World()
        _ = try await visitor.session.load()
        visitor.api.on(
            preview,
            Reply(
                json:
                    #"{"organizationName":"Acme","role":"member","email":"ada@example.com","expiresAt":"2030-01-01T00:00:00.000Z"}"#
            ))
        let shown = try await visitor.client.organizations.invitations.preview(token: "CANARY-token")
        XCTAssertEqual(shown.organizationName, "Acme")
        let sent = visitor.api.requests(preview)[0]
        XCTAssertNil(sent.value(forHTTPHeaderField: "authorization"))
        XCTAssertEqual(Fixture.body(sent)["token"] as? String, "CANARY-token")
        let refusedForNobody = await thrownCode {
            _ = try await visitor.client.organizations.invitations.accept(token: "CANARY-token")
        }
        XCTAssertEqual(refusedForNobody, "auth.unauthenticated")

        let world = try await World.signedIn()
        world.api.on(accept, Reply(json: organization))
        let joined = try await world.client.organizations.invitations.accept(token: "CANARY-token")
        XCTAssertEqual(joined.role, "admin")
        XCTAssertEqual(Fixture.body(world.api.requests(accept)[0])["token"] as? String, "CANARY-token")
        world.api.on(decline, Reply(status: 204, json: ""))
        try await world.client.organizations.invitations.decline(token: "CANARY-token")
        XCTAssertEqual(world.api.count(decline), 1)

        let invite = "POST /v1/client/me/organizations/org_1/invitations"
        world.api.on(
            invite,
            Reply(
                status: 201,
                json:
                    #"{"id":"inv_1","organizationId":"org_1","email":"ada@example.com","role":"member","status":"pending","invitedBy":null,"expiresAt":"2030-01-01T00:00:00.000Z","createdAt":"2026-01-01T00:00:00.000Z"}"#
            ))
        let made = try await world.client.organizations.invitations.invite(
            organizationId: "org_1", email: "ada@example.com", role: "member", redirectURL: "https://app.example/join")
        XCTAssertEqual(made.id, "inv_1")
        let inviteBody = Fixture.body(world.api.requests(invite)[0])
        XCTAssertEqual(inviteBody["redirectUrl"] as? String, "https://app.example/join")
        XCTAssertEqual(inviteBody["role"] as? String, "member")
        world.api.on("DELETE /v1/client/me/organizations/org_1/invitations/inv_1", Reply(status: 204, json: ""))
        try await world.client.organizations.invitations.revoke(organizationId: "org_1", invitationId: "inv_1")
    }

    func testAnInvitationTokenIsInNoErrorAndNoRepresentation() async throws {
        let world = try await World.signedIn()
        for code in ["organization.invitation_used", "organization.invitation_wrong_account"] {
            world.api.on(accept, Reply.error(410, code))
            do {
                _ = try await world.client.organizations.invitations.accept(token: "CANARY-token")
                XCTFail("nothing was thrown")
            } catch let error as TulaError {
                for said in [
                    "\(error)", String(reflecting: error), error.message, error.code, error.localizedDescription,
                ] {
                    XCTAssertFalse(said.contains("CANARY"), "an error held the token: \(said)")
                }
            }
        }
        let link = try XCTUnwrap(TulaInvitationLink.read("https://app.example/join#tula_invitation=CANARY-token"))
        for said in ["\(link)", String(reflecting: link), String(describing: link)] {
            XCTAssertFalse(said.contains("CANARY"))
        }
        var dumped = ""
        dump(link, to: &dumped)
        XCTAssertFalse(dumped.contains("CANARY"))
        for value in [world.client.organizations, world.client.organizations.invitations] as [Any] {
            var said = ""
            dump(value, to: &said)
            XCTAssertFalse(said.contains("CANARY"))
        }
    }

    // MARK: The claims

    func testTheThreeClaimsAreReadTogetherOrNotAtAll() {
        let good = TulaOrganizationClaims.read(accessToken: token("a", claims: orgClaims()))
        XCTAssertEqual(good?.organizationId, "org_1")
        XCTAssertEqual(good?.role, "admin")
        XCTAssertEqual(good?.permissions, ["org:sys:memberships:read", "org:billing:read"])

        let broken: [(String, String)] = [
            ("no claims", ""),
            ("only the id", #""org_id":"org_1""#),
            ("no role", #""org_id":"org_1","org_perms":[]"#),
            ("no permissions", #""org_id":"org_1","org_role":"admin""#),
            ("an id that is a number", #""org_id":1,"org_role":"admin","org_perms":[]"#),
            ("an empty id", orgClaims(id: "")),
            ("an id with a slash", orgClaims(id: "a/b")),
            ("an id past 64 characters", orgClaims(id: String(repeating: "a", count: 65))),
            ("a role in capitals", orgClaims(role: "Admin")),
            ("a role past 32 characters", orgClaims(role: "a" + String(repeating: "b", count: 32))),
            ("a role that starts with a digit", orgClaims(role: "1admin")),
            ("permissions that are not a list", orgClaims(permissions: #""org:billing:read""#)),
            ("a permission that is a number", orgClaims(permissions: "[1]")),
            ("a permission with a dot", orgClaims(permissions: #"["billing.read"]"#)),
            ("a permission with a wildcard", orgClaims(permissions: #"["org:billing:*"]"#)),
            ("a custom permission in the reserved feature", orgClaims(permissions: #"["org:sys:read"]"#)),
            ("a system permission with a third part", orgClaims(permissions: #"["org:sys:a:b:c"]"#)),
            ("a permission with a capital", orgClaims(permissions: #"["org:Billing:read"]"#)),
            ("an action past 32 characters",orgClaims(permissions: "[\"org:\(String(repeating: "a", count: 32)):\(String(repeating: "b", count: 32))x\"]")),
            ("a permission of a lookalike letter", orgClaims(permissions: #"["org:billing:rеad"]"#)),
            (
              "more than 32 permissions",
              orgClaims(permissions: "[" + (0..<33).map { "\"org:a:p\($0)\"" }.joined(separator: ",") + "]")
            ),
        ]
        for (name, claims) in broken {
            XCTAssertNil(TulaOrganizationClaims.read(accessToken: token("a", claims: claims)), name)
        }
        XCTAssertNil(TulaOrganizationClaims.read(accessToken: nil))
        XCTAssertNil(TulaOrganizationClaims.read(accessToken: "not.a.jwt"))
        XCTAssertNil(TulaOrganizationClaims.read(accessToken: "x"))
    }

    func testTheClaimsAreHeldToTheirByteCap() throws {
        // The contract's maximal claims (custom-claims.test.ts): a 36-character id, a role of 32
        // characters and 32 permissions of 73, which take 2,541 bytes inside the cap of 2,560.
        let f = String(repeating: "f", count: 31)
        let a = String(repeating: "a", count: 31)
        let longest = (0..<32).map { "org:sys:\(f)\($0 % 10):\(a)\($0 % 10)" }
        let list = "[" + longest.map { "\"\($0)\"" }.joined(separator: ",") + "]"
        let id = String(repeating: "i", count: 36)
        let role = "r" + String(repeating: "o", count: 31)
        let claims = try XCTUnwrap(
            TulaOrganizationClaims.read(accessToken: token("a", claims: orgClaims(id: id, role: role, permissions: list))))
        XCTAssertEqual(claims.bytes, 2541, "the same number as the contract's own test")
        XCTAssertLessThanOrEqual(claims.bytes, TulaOrganizationClaims.maxBytes)
        let small = try XCTUnwrap(
            TulaOrganizationClaims.read(accessToken: token("a", claims: orgClaims(id: "o1", role: "member", permissions: "[]"))))
        XCTAssertEqual(small.bytes, 50)
        // An id the grammar allows can still push the claims over the cap: nothing is repaired,
        // the organization is simply not active.
        let bigId = String(repeating: "i", count: 64)
        XCTAssertNil(
            TulaOrganizationClaims.read(accessToken: token("a", claims: orgClaims(id: bigId, role: role, permissions: list))))
    }

    func testAPermissionOrARoleIsMatchedExactly() {
        let claims = TulaOrganizationClaims(
            organizationId: "org_1", role: "admin", permissions: ["org:billing:manage", "org:sys:memberships:read"])
        XCTAssertTrue(claims.has(permission: "org:billing:manage"))
        XCTAssertFalse(claims.has(permission: "org:billing:read"), "manage does not imply read")
        XCTAssertFalse(claims.has(permission: "org:billing:*"), "there is no wildcard")
        XCTAssertFalse(claims.has(permission: "ORG:BILLING:MANAGE"))
        XCTAssertFalse(claims.has(permission: ""))
        XCTAssertTrue(claims.has(role: "admin"))
        XCTAssertFalse(claims.has(role: "member"))
        XCTAssertFalse(claims.has(role: "Admin"))
        XCTAssertFalse(claims.has(role: ""))
    }

    // MARK: The link

    func testTheTokenIsReadFromTheLinksFragment() throws {
        let link = try XCTUnwrap(TulaInvitationLink.read("https://app.example/join?x=1#tula_invitation=abc_DEF-123"))
        XCTAssertEqual(link.token, "abc_DEF-123")
        XCTAssertEqual(link.cleanURL, "https://app.example/join?x=1")

        // Another parameter of the fragment stays, in its place and as it was written.
        let beside = try XCTUnwrap(TulaInvitationLink.read("myapp://join#a=1&tula_invitation=tok&b=%20two"))
        XCTAssertEqual(beside.token, "tok")
        XCTAssertEqual(beside.cleanURL, "myapp://join#a=1&b=%20two")

        // Written twice: the first is read, both are dropped.
        let twice = try XCTUnwrap(TulaInvitationLink.read("https://app.example/j#tula_invitation=one&tula_invitation=two"))
        XCTAssertEqual(twice.token, "one")
        XCTAssertEqual(twice.cleanURL, "https://app.example/j")

        // A percent-encoded value is decoded.
        XCTAssertEqual(TulaInvitationLink.read("https://app.example/j#tula_invitation=a%2Bb")?.token, "a+b")

        let url = try XCTUnwrap(URL(string: "https://app.example/join#tula_invitation=tok"))
        XCTAssertEqual(TulaInvitationLink.read(url)?.token, "tok")

        for none in [
            "https://app.example/join", "https://app.example/join#", "https://app.example/join#other=1",
            "https://app.example/join#tula_invitation", "https://app.example/join#tula_invitation=",
            "https://app.example/join?tula_invitation=in-the-query",
        ] {
            XCTAssertNil(TulaInvitationLink.read(none), none)
        }
    }
}
