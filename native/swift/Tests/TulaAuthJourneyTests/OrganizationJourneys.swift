import Foundation
import XCTest

@testable import TulaAuth

// The Swift client against the real API: the signed-in user's organizations, the one the
// session acts in, invitations to join one and the organizations a verified address is
// offered (ADR 0065; scenarios 120, 121 and 122). An operator's side (creating an
// organization, adding a member, claiming a domain) is the fixture's relayed admin call; the
// user's side is the client, the way an app calls it.
final class OrganizationJourneys: JourneyTestCase {
    private static let join = "https://app.conformance.example/join"

    /// Switch organizations on, as an operator saves the settings.
    private func configure(
        _ s: Server, allowUserCreated: Bool = false, redirectURLs: [String]? = nil
    ) async throws {
        var sections: [String: Any] = [
            "organizations": [
                "enabled": true,
                "allowUserCreated": allowUserCreated,
                "maxCreatedPerUser": 1,
                "creatorRole": "admin",
                "defaultRole": "member",
                "personalAccount": true,
            ] as [String: Any]
        ]
        if let redirectURLs {
            sections["urls"] = ["allowedOrigins": [String](), "allowedRedirectUrls": redirectURLs]
        }
        try await s.settings(sections)
    }

    /// An organization an operator made; returns its id.
    private func organization(_ s: Server, _ name: String, _ slug: String) async throws -> String {
        let made = try await s.admin("POST", "/v1/admin/organizations", ["name": name, "slug": slug])
        XCTAssertEqual(made.status, 201)
        return try unwrap(made.object["id"] as? String)
    }

    private func claimsOf(_ app: App) async throws -> (id: String?, role: String?, permissions: [String]?) {
        let claims = try await app.claims()
        return (claims["org_id"] as? String, claims["org_role"] as? String, claims["org_perms"] as? [String])
    }

    /// The token of the newest invitation email sent to `address`, read as an app reads the
    /// link it was opened with.
    private func invitation(_ s: Server, to address: String) async throws -> (link: String, read: TulaInvitationLink) {
        let mail = try unwrap(try await s.emails(to: address).last { $0.subject.contains("invited") })
        let text = mail.text
        let found = try unwrap(
            text.range(of: #"https?://\S+#tula_invitation=\S+"#, options: .regularExpression))
        let link = String(text[found])
        return (link, try unwrap(TulaInvitationLink.read(link)))
    }

    func testMyOrganizationsAndTheActiveOrganization() async throws {
        try await journey(
            "my organizations and the active organization",
            "organizations: a user lists theirs, creates one where allowed and chooses the one the session acts in; the token carries it, a refresh re-reads the membership and a removed member keeps the session without the claims"
        ) { s in
            let (app, _) = try await s.signUp()
            let userId = try unwrap(await app.user()).id
            let orgs = app.tula.organizations

            // Off by default: every call answers its code and nothing changes.
            let listOff = try await caught { try await orgs.list() }
            XCTAssertEqual(listOff.code, "organization.disabled")
            let chooseOff = try await caught { try await orgs.setActive(nil) }
            XCTAssertEqual(chooseOff.code, "organization.disabled")
            let createOff = try await caught { try await orgs.create(name: "Mine", slug: "mine-\(userId)") }
            XCTAssertEqual(createOff.code, "organization.disabled")

            try await self.configure(s)
            let denied = try await caught { try await orgs.create(name: "Mine", slug: "mine-\(userId)") }
            XCTAssertEqual(denied.code, "organization.creation_disabled")
            let empty = try await orgs.list()
            XCTAssertEqual(empty.data, [])
            XCTAssertNil(empty.activeOrganizationId)

            let orgId = try await self.organization(s, "Conformance Org", "conformance-\(userId)")
            let otherId = try await self.organization(s, "Elsewhere", "elsewhere-\(userId)")
            // A second user keeps an administrator in the organization, so the first can be demoted.
            let manager = try await s.admin(
                "POST", "/v1/admin/users", ["email": s.freshEmail(), "emailVerified": true])
            XCTAssertEqual(manager.status, 201)
            let memberships = "/v1/admin/organizations/\(orgId)/memberships"
            let managed = try await s.admin(
                "POST", memberships, ["userId": try unwrap(manager.object["id"] as? String), "role": "admin"])
            XCTAssertEqual(managed.status, 201)
            let added = try await s.admin("POST", memberships, ["userId": userId, "role": "member"])
            XCTAssertEqual(added.status, 201)

            let page = try await orgs.list()
            XCTAssertEqual(page.data.map(\.id), [orgId])
            XCTAssertEqual(page.data.map(\.role), ["member"])
            XCTAssertNil(page.activeOrganizationId)
            var claims = try await self.claimsOf(app)
            XCTAssertNil(claims.id)
            let none = try await orgs.active()
            XCTAssertNil(none)

            // One that is not theirs, and one that does not exist, are refused alike.
            let refused = try await caught { try await orgs.setActive(otherId) }
            XCTAssertEqual(refused.code, "organization.not_a_member")
            XCTAssertEqual(refused.status, 403)
            let unknown = try await caught { try await orgs.setActive(userId) }
            XCTAssertEqual(unknown.code, refused.code)
            claims = try await self.claimsOf(app)
            XCTAssertNil(claims.id, "a refused choice changes nothing")

            // Choosing asks for no refresh: the answer carries the access token.
            let refreshes = try await s.refreshes().count
            let storedBefore = await app.storage.get(s.storageKey)
            let chosen = try await orgs.setActive(orgId)
            XCTAssertEqual(chosen.organizationId, orgId)
            let refreshed = try await s.refreshes().count
            XCTAssertEqual(refreshed, refreshes)
            claims = try await self.claimsOf(app)
            XCTAssertEqual(claims.id, orgId)
            XCTAssertEqual(claims.role, "member")
            let active = try unwrap(try await orgs.active())
            XCTAssertEqual(active.organizationId, orgId)
            XCTAssertEqual(active.permissions, page.data[0].permissions, "the token says what the list said")
            let member = try await orgs.has(role: "member")
            XCTAssertTrue(member)
            let admin = try await orgs.has(role: "admin")
            XCTAssertFalse(admin)
            let invented = try await orgs.has(permission: "org:invented:thing")
            XCTAssertFalse(invented)
            if let held = page.data[0].permissions.first {
                let holds = try await orgs.has(permission: held)
                XCTAssertTrue(holds)
            }
            let listed = try await orgs.list()
            XCTAssertEqual(listed.activeOrganizationId, orgId)
            // The refresh token is the one it was: choosing rotated nothing.
            let storedAfter = await app.storage.get(s.storageKey)
            XCTAssertNotNil(storedBefore)
            XCTAssertEqual(storedAfter, storedBefore)

            // A refresh keeps the choice and reads the membership again.
            try await s.advance(1)
            _ = try await app.tula.session.refresh()
            claims = try await self.claimsOf(app)
            XCTAssertEqual(claims.id, orgId)
            XCTAssertEqual(claims.role, "member")
            let membership = "\(memberships)/\(userId)"
            let promoted = try await s.admin("PATCH", membership, ["role": "admin"])
            XCTAssertEqual(promoted.status, 200)
            try await s.advance(1)
            _ = try await app.tula.session.refresh()
            claims = try await self.claimsOf(app)
            XCTAssertEqual(claims.role, "admin")
            let isAdmin = try await orgs.has(role: "admin")
            XCTAssertTrue(isAdmin)
            let demoted = try await s.admin("PATCH", membership, ["role": "member"])
            XCTAssertEqual(demoted.status, 200)
            try await s.advance(1)
            _ = try await app.tula.session.refresh()
            claims = try await self.claimsOf(app)
            XCTAssertEqual(claims.role, "member")

            // Removed: the session lives on, its next token has no organization.
            let removed = try await s.admin("DELETE", membership)
            XCTAssertEqual(removed.status, 204)
            try await s.advance(1)
            _ = try await app.tula.session.refresh()
            claims = try await self.claimsOf(app)
            XCTAssertNil(claims.id)
            XCTAssertNil(claims.role)
            XCTAssertNil(claims.permissions)
            let after = try await orgs.active()
            XCTAssertNil(after)
            let state = await app.state()
            XCTAssertTrue(state.isSignedIn)
            let gone = try await caught { try await orgs.setActive(orgId) }
            XCTAssertEqual(gone.code, "organization.not_a_member")
            let personal = try await orgs.clearActive()
            XCTAssertNil(personal.organizationId)

            // Creating needs the setting, makes the user its admin, stops at the limit and
            // does not switch the session.
            try await self.configure(s, allowUserCreated: true)
            let taken = try await caught { try await orgs.create(name: "Taken", slug: "conformance-\(userId)") }
            XCTAssertEqual(taken.code, "organization.slug_taken")
            let mine = try await orgs.create(name: "Mine", slug: "mine-\(userId)")
            XCTAssertEqual(mine.slug, "mine-\(userId)")
            XCTAssertEqual(mine.role, "admin")
            let again = try await caught { try await orgs.create(name: "Again", slug: "again-\(userId)") }
            XCTAssertEqual(again.code, "organization.limit_reached")
            claims = try await self.claimsOf(app)
            XCTAssertNil(claims.id, "creating did not switch the session")
            try await orgs.setActive(mine.id)
            claims = try await self.claimsOf(app)
            XCTAssertEqual(claims.id, mine.id)
            XCTAssertEqual(claims.role, "admin")
            let switching = try await orgs.clearActive()
            XCTAssertNil(switching.organizationId)
            claims = try await self.claimsOf(app)
            XCTAssertNil(claims.id)
        }
    }

    func testOrganizationInvitations() async throws {
        try await journey(
            "organization invitations",
            "organization invitations: an administrator invites an address, the emailed link carries the token in its fragment, only the invited account accepts or declines, a member without the permission cannot invite, and a withdrawn or used invitation is refused"
        ) { s in
            let join = OrganizationJourneys.join
            try await self.configure(s, allowUserCreated: true, redirectURLs: [join])
            let (owner, _) = try await s.signUp()
            let (ada, adaEmail) = try await s.signUp()
            let (stranger, strangerEmail) = try await s.signUp()
            let org = try await owner.tula.organizations.create(name: "Acme", slug: "acme")
            let invitations = owner.tula.organizations.invitations

            // An invitation: the email goes to the address and the link leads to the redirect URL.
            let sent = try await invitations.invite(
                organizationId: org.id, email: adaEmail, role: "member", redirectURL: join)
            XCTAssertEqual(sent.organizationId, org.id)
            XCTAssertEqual(sent.role, "member")
            XCTAssertEqual(sent.status, .pending)
            let first = try await self.invitation(s, to: adaEmail)
            XCTAssertTrue(first.link.hasPrefix("\(join)#tula_invitation="))
            XCTAssertEqual(first.read.cleanURL, join)
            let token = first.read.token
            XCTAssertFalse(token.isEmpty)

            // The API's answers never hold the token.
            let pending = try await invitations.list(organizationId: org.id)
            XCTAssertEqual(pending.data.map(\.id), [sent.id])
            for exchange in try await s.exchanges() {
                XCTAssertFalse(exchange.responseBody.contains(token), "\(exchange.path) answered the token")
                XCTAssertFalse(exchange.path.contains(token), "the token was put in a URL")
            }
            let duplicate = try await caught {
                try await invitations.invite(organizationId: org.id, email: adaEmail, role: "member", redirectURL: join)
            }
            XCTAssertEqual(duplicate.code, "organization.invitation_exists")
            let evil = try await caught {
                try await invitations.invite(
                    organizationId: org.id, email: s.freshEmail(), role: "member", redirectURL: "https://evil.test/join")
            }
            XCTAssertEqual(evil.code, "request.redirect_not_allowed")
            let ghost = try await caught {
                try await invitations.invite(
                    organizationId: org.id, email: s.freshEmail(), role: "ghost", redirectURL: join)
            }
            XCTAssertEqual(ghost.code, "organization.role_unknown")

            // Anyone with the token may see what it is for, signed in or not.
            let visitor = try s.client()
            let shown = try await visitor.tula.organizations.invitations.preview(token: token)
            XCTAssertEqual(shown.organizationName, "Acme")
            XCTAssertEqual(shown.role, "member")
            XCTAssertEqual(shown.email, adaEmail)
            let nothing = try await caught { try await visitor.tula.organizations.invitations.preview(token: "nothing") }
            XCTAssertEqual(nothing.code, "organization.invitation_not_found")
            // Accepting needs a session.
            let nobody = try await caught { try await visitor.tula.organizations.invitations.accept(token: token) }
            XCTAssertEqual(nobody.code, "auth.unauthenticated")

            // Only the invited account answers.
            let wrongAccept = try await caught { try await stranger.tula.organizations.invitations.accept(token: token) }
            XCTAssertEqual(wrongAccept.code, "organization.invitation_wrong_account")
            let wrongDecline = try await caught { try await stranger.tula.organizations.invitations.decline(token: token) }
            XCTAssertEqual(wrongDecline.code, "organization.invitation_wrong_account")
            let joined = try await ada.tula.organizations.invitations.accept(token: token)
            XCTAssertEqual(joined.id, org.id)
            XCTAssertEqual(joined.role, "member")
            let theirs = try await ada.tula.organizations.list()
            XCTAssertEqual(theirs.data.map(\.id), [org.id])
            // Joining did not switch the session.
            XCTAssertNil(theirs.activeOrganizationId)
            let used = try await caught { try await ada.tula.organizations.invitations.accept(token: token) }
            XCTAssertEqual(used.code, "organization.invitation_used")
            let declineUsed = try await caught { try await ada.tula.organizations.invitations.decline(token: token) }
            XCTAssertEqual(declineUsed.code, "organization.invitation_used")
            let previewUsed = try await caught { try await visitor.tula.organizations.invitations.preview(token: token) }
            XCTAssertEqual(previewUsed.code, "organization.invitation_used")
            let leftOpen = try await invitations.list(organizationId: org.id)
            XCTAssertEqual(leftOpen.data, [])

            // A member whose role cannot manage invitations cannot invite or list.
            let refusedInvite = try await caught {
                try await ada.tula.organizations.invitations.invite(
                    organizationId: org.id, email: s.freshEmail(), role: "member", redirectURL: join)
            }
            XCTAssertEqual(refusedInvite.code, "organization.permission_required")
            XCTAssertEqual(refusedInvite.status, 403)
            let refusedList = try await caught { try await ada.tula.organizations.invitations.list(organizationId: org.id) }
            XCTAssertEqual(refusedList.code, "organization.permission_required")
            // A user who is no member at all is told so, not that the organization is missing.
            let outsider = try await caught { try await stranger.tula.organizations.invitations.list(organizationId: org.id) }
            XCTAssertEqual(outsider.code, "organization.not_a_member")
            // And a member cannot be invited again.
            let member = try await caught {
                try await invitations.invite(organizationId: org.id, email: adaEmail, role: "admin", redirectURL: join)
            }
            XCTAssertEqual(member.code, "organization.member_exists")

            // Declining uses it up.
            let declined = try await invitations.invite(
                organizationId: org.id, email: strangerEmail, role: "admin", redirectURL: join)
            let declinedToken = try await self.invitation(s, to: strangerEmail).read.token
            let notMine = try await caught { try await ada.tula.organizations.invitations.accept(token: declinedToken) }
            XCTAssertEqual(notMine.code, "organization.invitation_wrong_account")
            try await stranger.tula.organizations.invitations.decline(token: declinedToken)
            let acceptDeclined = try await caught {
                try await stranger.tula.organizations.invitations.accept(token: declinedToken)
            }
            XCTAssertEqual(acceptDeclined.code, "organization.invitation_used")
            let revokeDeclined = try await caught {
                try await invitations.revoke(organizationId: org.id, invitationId: declined.id)
            }
            XCTAssertEqual(revokeDeclined.code, "organization.invitation_used")
            let notAMember = try await stranger.tula.organizations.list()
            XCTAssertEqual(notAMember.data, [], "declining joins nobody")

            // Withdrawing makes the link say so.
            let thirdEmail = s.freshEmail()
            let withdrawn = try await invitations.invite(
                organizationId: org.id, email: thirdEmail, role: "member", redirectURL: join)
            let withdrawnToken = try await self.invitation(s, to: thirdEmail).read.token
            try await invitations.revoke(organizationId: org.id, invitationId: withdrawn.id)
            let revokedLink = try await caught { try await visitor.tula.organizations.invitations.preview(token: withdrawnToken) }
            XCTAssertEqual(revokedLink.code, "organization.invitation_revoked")
            let revokedAgain = try await caught {
                try await invitations.revoke(organizationId: org.id, invitationId: withdrawn.id)
            }
            XCTAssertEqual(revokedAgain.code, "organization.invitation_revoked")

            // An invitation lasts seven days.
            let lapsingEmail = s.freshEmail()
            _ = try await invitations.invite(organizationId: org.id, email: lapsingEmail, role: "member", redirectURL: join)
            let lapsingToken = try await self.invitation(s, to: lapsingEmail).read.token
            try await s.advance(7 * 24 * 3600 + 1)
            let lapsed = try await caught { try await visitor.tula.organizations.invitations.preview(token: lapsingToken) }
            XCTAssertEqual(lapsed.code, "organization.invitation_expired")

            // The token reached the API in request bodies only: no path, no header, and no
            // answer holds one.
            for exchange in try await s.exchanges() {
                for secret in [token, declinedToken, withdrawnToken, lapsingToken] {
                    XCTAssertFalse(exchange.path.contains(secret))
                    XCTAssertFalse(exchange.headers.values.contains { $0.contains(secret) })
                    XCTAssertFalse(exchange.responseBody.contains(secret))
                }
            }
        }
    }

    // Scenario 123 from the client's side: two users, a manager and a member, each with their
    // own session; the server decides from the role held now, on every call.
    func testOrganizationMembersAndRolesFromTheClient() async throws {
        try await journey(
            "organization members and roles from the client",
            "organizations: members read the list; only a manager renames, deletes, changes a role or removes someone; the only manager cannot leave or demote themselves; a manager who left is a non-member at once; domains are claimed, verified, changed and removed by a manager"
        ) { s in
            try await self.configure(s)
            let orgId = try await self.organization(s, "Members Org", "members-\(s.freshEmail().prefix(8))")
            let (manager, managerEmail) = try await s.signUp()
            let (member, memberEmail) = try await s.signUp()
            let managerId = try unwrap(await manager.user()).id
            let memberId = try unwrap(await member.user()).id
            let memberships = "/v1/admin/organizations/\(orgId)/memberships"
            let madeManager = try await s.admin("POST", memberships, ["userId": managerId, "role": "admin"])
            XCTAssertEqual(madeManager.status, 201)
            let madeMember = try await s.admin("POST", memberships, ["userId": memberId, "role": "member"])
            XCTAssertEqual(madeMember.status, 201)
            let asManager = manager.tula.organizations
            let asMember = member.tula.organizations

            // An organization that does not exist is not_a_member, as one that is not theirs.
            let missing = try await caught { try await asMember.members.list(organizationId: managerId) }
            XCTAssertEqual(missing.code, "organization.not_a_member")

            // A member reads the list, with addresses and role keys, and can do nothing else.
            let page = try await asMember.members.list(organizationId: orgId)
            XCTAssertEqual(page.meta.totalCount, 2)
            XCTAssertEqual(Set(page.data.map(\.userId)), [managerId, memberId])
            XCTAssertEqual(page.data.first { $0.userId == managerId }?.role, "admin")
            XCTAssertEqual(page.data.first { $0.userId == memberId }?.email, memberEmail)
            XCTAssertEqual(page.data.first { $0.userId == managerId }?.email, managerEmail)
            let noRoles = try await caught { try await asMember.roles(organizationId: orgId) }
            XCTAssertEqual(noRoles.code, "organization.permission_required")
            let noRename = try await caught { try await asMember.update(organizationId: orgId, name: "Mine now") }
            XCTAssertEqual(noRename.code, "organization.permission_required")
            let noDelete = try await caught { try await asMember.remove(organizationId: orgId) }
            XCTAssertEqual(noDelete.code, "organization.permission_required")
            let noChange = try await caught {
                try await asMember.members.changeRole(organizationId: orgId, userId: managerId, role: "member")
            }
            XCTAssertEqual(noChange.code, "organization.permission_required")
            let noRemove = try await caught { try await asMember.members.remove(organizationId: orgId, userId: managerId) }
            XCTAssertEqual(noRemove.code, "organization.permission_required")
            let noDomains = try await caught { try await asMember.domains.list(organizationId: orgId) }
            XCTAssertEqual(noDomains.code, "auth.forbidden", "the domain routes name a missing permission this way")

            // A manager sees the roles they may give and renames the organization.
            let roles = try await asManager.roles(organizationId: orgId)
            XCTAssertEqual(roles.data.map(\.key), ["admin", "member"])
            let renamed = try await asManager.update(organizationId: orgId, name: "Members Org Renamed")
            XCTAssertEqual(renamed.id, orgId)
            XCTAssertEqual(renamed.name, "Members Org Renamed")
            XCTAssertEqual(renamed.role, "admin")
            let unknown = try await caught {
                try await asManager.members.changeRole(organizationId: orgId, userId: memberId, role: "nobody")
            }
            XCTAssertEqual(unknown.code, "organization.role_unknown")

            // The only manager can neither leave nor demote themselves.
            let stuck = try await caught { try await asManager.leave(organizationId: orgId) }
            XCTAssertEqual(stuck.code, "organization.last_manager")
            let demote = try await caught {
                try await asManager.members.changeRole(organizationId: orgId, userId: managerId, role: "member")
            }
            XCTAssertEqual(demote.code, "organization.last_manager")

            // A domain: claimed, proved with the emailed code, changed, removed.
            let domain = "corp-\(orgId.suffix(8)).example"
            let claim = try await asManager.domains.start(
                organizationId: orgId, domain: domain, email: "ada@\(domain)", mode: .suggest)
            XCTAssertEqual(claim.status, .pending)
            let wrong = try await caught {
                try await asManager.domains.verify(organizationId: orgId, domainId: claim.id, code: "000000")
            }
            XCTAssertEqual(wrong.status, 422)
            let proved = try await asManager.domains.verify(
                organizationId: orgId, domainId: claim.id, code: try await s.code("ada@\(domain)"))
            XCTAssertEqual(proved.status, .verified)
            XCTAssertNotNil(proved.expiresAt)
            let changedMode = try await asManager.domains.update(
                organizationId: orgId, domainId: claim.id, mode: .autoJoin)
            XCTAssertEqual(changedMode.mode, .autoJoin)
            let domains = try await asManager.domains.list(organizationId: orgId)
            XCTAssertEqual(domains.data.map(\.id), [claim.id])
            try await asManager.domains.remove(organizationId: orgId, domainId: claim.id)
            let none = try await asManager.domains.list(organizationId: orgId)
            XCTAssertEqual(none.data, [])

            // With a second manager the first may leave, and is a non-member at once.
            let promoted = try await asManager.members.changeRole(organizationId: orgId, userId: memberId, role: "admin")
            XCTAssertEqual(promoted.userId, memberId)
            XCTAssertEqual(promoted.role, "admin")
            try await asManager.leave(organizationId: orgId)
            let gone = try await caught { try await asManager.members.list(organizationId: orgId) }
            XCTAssertEqual(gone.code, "organization.not_a_member")
            let remaining = try await asMember.members.list(organizationId: orgId)
            XCTAssertEqual(remaining.meta.totalCount, 1)

            // The remaining administrator deletes it, and nobody is a member of it any more.
            try await asMember.remove(organizationId: orgId)
            let deleted = try await caught { try await asMember.members.list(organizationId: orgId) }
            XCTAssertEqual(deleted.code, "organization.not_a_member")
        }
    }

    func testVerifiedDomainsSuggestAndAutoJoin() async throws {
        try await journey(
            "verified domains: suggest and auto-join",
            "verified domains: an address on an organization's verified domain joins it at sign-up (auto-join) or is offered it to join (suggest); the server decides again, and a removed domain offers and joins nobody"
        ) { s in
            try await self.configure(s)
            let orgId = try await self.organization(s, "Domain Org", "domain-org")
            let domain = "corp-\(orgId.suffix(8)).example"
            let base = "/v1/admin/organizations/\(orgId)/domains"
            let claimed = try await s.admin("POST", base, ["domain": domain, "email": "ada@\(domain)", "mode": "auto_join"])
            XCTAssertEqual(claimed.status, 201)
            let domainId = try unwrap(claimed.object["id"] as? String)

            // Until the code is entered the claim grants nothing.
            let (early, _) = try await s.signUp(email: "early@\(domain)")
            let earlyList = try await early.tula.organizations.list()
            XCTAssertEqual(earlyList.data, [])
            let earlyOffered = try await early.tula.organizations.suggestions()
            XCTAssertEqual(earlyOffered.data, [])
            let wrong = try await s.admin("POST", "\(base)/\(domainId)/verify", ["code": "000000"])
            XCTAssertEqual(wrong.status, 422)
            let verified = try await s.admin(
                "POST", "\(base)/\(domainId)/verify", ["code": try await s.code("ada@\(domain)")])
            XCTAssertEqual(verified.status, 200)

            // Auto-join: a new account with a verified address on the domain is a member.
            let (maya, _) = try await s.signUp(email: "maya@\(domain)")
            let mine = try await maya.tula.organizations.list()
            XCTAssertEqual(mine.data.map(\.id), [orgId])
            XCTAssertEqual(mine.data.map(\.role), ["member"])
            let mayaOffered = try await maya.tula.organizations.suggestions()
            XCTAssertEqual(mayaOffered.data, [], "a member is not offered what they are in")

            // Another domain is offered nothing and cannot join; the account from before the
            // domain was verified was not joined.
            let (stranger, _) = try await s.signUp()
            let strangerOffered = try await stranger.tula.organizations.suggestions()
            XCTAssertEqual(strangerOffered.data, [])
            let unavailable = try await caught { try await stranger.tula.organizations.join(orgId) }
            XCTAssertEqual(unavailable.code, "organization.suggestion_unavailable")
            let earlyAgain = try await early.tula.organizations.list()
            XCTAssertEqual(earlyAgain.data, [])

            // Suggest: the organization is offered, by name, and the user joins it once.
            let changed = try await s.admin("PATCH", "\(base)/\(domainId)", ["mode": "suggest"])
            XCTAssertEqual(changed.status, 200)
            let (kai, _) = try await s.signUp(email: "kai@\(domain)")
            let kaiList = try await kai.tula.organizations.list()
            XCTAssertEqual(kaiList.data, [])
            let offered = try await kai.tula.organizations.suggestions()
            XCTAssertEqual(offered.data, [OrganizationSuggestion(id: orgId, name: "Domain Org", slug: "domain-org")])
            let joined = try await kai.tula.organizations.join(orgId)
            XCTAssertEqual(joined.id, orgId)
            XCTAssertEqual(joined.role, "member")
            let kaiActive = try await kai.tula.organizations.active()
            XCTAssertNil(kaiActive, "joining did not switch the session")
            let twice = try await caught { try await kai.tula.organizations.join(orgId) }
            XCTAssertEqual(twice.code, "organization.member_exists")

            // Removed: nobody is offered it or joined to it any more, and members stay.
            let removed = try await s.admin("DELETE", "\(base)/\(domainId)")
            XCTAssertEqual(removed.status, 204)
            let late = try await caught { try await early.tula.organizations.join(orgId) }
            XCTAssertEqual(late.code, "organization.suggestion_unavailable")
            let (afterwards, _) = try await s.signUp(email: "late@\(domain)")
            let afterList = try await afterwards.tula.organizations.list()
            XCTAssertEqual(afterList.data, [])
            let afterOffered = try await afterwards.tula.organizations.suggestions()
            XCTAssertEqual(afterOffered.data, [])
            let stayed = try await maya.tula.organizations.list()
            XCTAssertEqual(stayed.data.count, 1)
        }
    }
}
