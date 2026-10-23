import Foundation

// Managing an organization from the client (ADR 0065): its members and their roles, and the
// domains it claims. What a member may do is decided by the server from the role they hold
// now, on every call; these are the calls.

/// An organization's members (ADR 0065). Reading needs `org:sys:memberships:read` or
/// `:manage`; changing needs `org:sys:memberships:manage`, which the API reads from the
/// user's membership on every call.
///
/// ```swift
/// let page = try await tula.organizations.members.list(organizationId: org.id)
/// try await tula.organizations.members.changeRole(organizationId: org.id, userId: page.data[0].userId, role: "admin")
/// ```
public struct TulaOrganizationMembers: Sendable, TulaRedacted {
    let context: FlowContext

    /// The organization's members, oldest first, with each one's name, address and role key.
    /// Only the first page.
    ///
    /// - Parameter organizationId: The organization.
    /// - Returns: The page.
    /// - Throws: `TulaError`: `organization.not_a_member`, `organization.permission_required`,
    ///   `organization.disabled`.
    public func list(organizationId: String) async throws -> OrganizationMemberList {
        try await context.session.authorized(
            TulaOperations.listMyOrganizationMembers, params: ["organizationId": organizationId],
            as: OrganizationMemberList.self)
    }

    /// Give a member another role, one whose permissions the user holds themselves. The
    /// member's sessions carry it from their next refresh.
    ///
    /// - Parameters:
    ///   - organizationId: The organization.
    ///   - userId: The member.
    ///   - role: The key of the new role.
    /// - Returns: The member, as they are now.
    /// - Throws: `TulaError`: `organization.permission_required`, `organization.role_unknown`,
    ///   `organization.role_not_assignable`, `organization.last_manager`.
    @discardableResult
    public func changeRole(organizationId: String, userId: String, role: String) async throws
        -> OrganizationMember
    {
        try await context.session.authorized(
            TulaOperations.updateMyOrganizationMember,
            params: ["organizationId": organizationId, "userId": userId],
            body: UpdateOrganizationMemberRequest(role: role), as: OrganizationMember.self)
    }

    /// Remove a member. The user keeps their account; to remove yourself use
    /// `TulaOrganizations.leave(organizationId:)`.
    ///
    /// - Parameters:
    ///   - organizationId: The organization.
    ///   - userId: The member.
    /// - Throws: `TulaError`: `organization.permission_required`, `organization.last_manager`.
    public func remove(organizationId: String, userId: String) async throws {
        _ = try await context.session.authorized(
            TulaOperations.removeMyOrganizationMember,
            params: ["organizationId": organizationId, "userId": userId], as: NoAnswer.self)
    }
}

/// An organization's domains (ADR 0065, "Verified domains"): the organization claims one by a
/// code emailed to an address on it, and a verified one suggests or joins the people who sign
/// up with a verified address on it. Needs `org:sys:domains:manage`, which the API reads from
/// the user's membership on every call.
///
/// ```swift
/// let claim = try await tula.organizations.domains.start(
///     organizationId: org.id, domain: "acme.com", email: "ada@acme.com", mode: .suggest)
/// try await tula.organizations.domains.verify(organizationId: org.id, domainId: claim.id, code: "123456")
/// ```
public struct TulaOrganizationDomains: Sendable, TulaRedacted {
    let context: FlowContext

    /// The organization's domains, oldest first: claims waiting for a code and verified ones.
    /// Each row's `status` is `pending`, `verified` or `needsReverification`; `expiresAt` is
    /// when a verified claim must be proved again.
    ///
    /// - Parameter organizationId: The organization.
    /// - Returns: The domains.
    /// - Throws: `TulaError`: `organization.not_a_member`, `auth.forbidden`,
    ///   `organization.disabled`.
    public func list(organizationId: String) async throws -> OrganizationDomainList {
        try await context.session.authorized(
            TulaOperations.listMyOrganizationDomains, params: ["id": organizationId],
            as: OrganizationDomainList.self)
    }

    /// Claim a domain: email a code to an address on it. Sent again for a pending claim it
    /// emails a new code.
    ///
    /// - Parameters:
    ///   - organizationId: The organization.
    ///   - domain: The domain, such as `acme.com`.
    ///   - email: An address on it, which receives the code.
    ///   - mode: What a verified domain does: `.suggest` or `.autoJoin`.
    /// - Returns: The claim, `pending` until `verify(organizationId:domainId:code:)`.
    /// - Throws: `TulaError`: `organization.domain_public`, `organization.domain_taken`,
    ///   `organization.domain_address_mismatch`, `organization.domain_limit`, `rate_limited`.
    public func start(
        organizationId: String, domain: String, email: String, mode: OrganizationDomainMode
    ) async throws -> OrganizationDomain {
        try await context.session.authorized(
            TulaOperations.startMyOrganizationDomain, params: ["id": organizationId],
            body: StartOrganizationDomainRequest(domain: domain, email: email, mode: mode),
            as: OrganizationDomain.self)
    }

    /// Prove the claim with the code that was emailed.
    ///
    /// - Parameters:
    ///   - organizationId: The organization.
    ///   - domainId: The claim.
    ///   - code: The emailed code.
    /// - Returns: The verified domain.
    /// - Throws: `TulaError`: `verification.invalid_code` and its siblings,
    ///   `organization.domain_taken`.
    public func verify(organizationId: String, domainId: String, code: String) async throws
        -> OrganizationDomain
    {
        try await context.session.authorized(
            TulaOperations.verifyMyOrganizationDomain,
            params: ["id": organizationId, "domainId": domainId],
            body: VerifyOrganizationDomainRequest(code: code), as: OrganizationDomain.self)
    }

    /// Change what a domain does.
    ///
    /// - Parameters:
    ///   - organizationId: The organization.
    ///   - domainId: The domain.
    ///   - mode: `.suggest` or `.autoJoin`.
    /// - Returns: The domain.
    /// - Throws: `TulaError`: `auth.forbidden`, `organization.not_a_member`.
    public func update(organizationId: String, domainId: String, mode: OrganizationDomainMode)
        async throws -> OrganizationDomain
    {
        try await context.session.authorized(
            TulaOperations.updateMyOrganizationDomain,
            params: ["id": organizationId, "domainId": domainId],
            body: UpdateOrganizationDomainRequest(mode: mode), as: OrganizationDomain.self)
    }

    /// Remove a domain. Later sign-ups are neither offered nor joined to the organization;
    /// members stay.
    ///
    /// - Parameters:
    ///   - organizationId: The organization.
    ///   - domainId: The domain.
    /// - Throws: `TulaError`: `auth.forbidden`, `organization.not_a_member`.
    public func remove(organizationId: String, domainId: String) async throws {
        _ = try await context.session.authorized(
            TulaOperations.removeMyOrganizationDomain,
            params: ["id": organizationId, "domainId": domainId], as: NoAnswer.self)
    }
}
