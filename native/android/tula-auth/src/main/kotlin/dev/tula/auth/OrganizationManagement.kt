package dev.tula.auth

import dev.tula.auth.generated.OrganizationDomain
import dev.tula.auth.generated.OrganizationDomainList
import dev.tula.auth.generated.OrganizationDomainMode
import dev.tula.auth.generated.OrganizationMember
import dev.tula.auth.generated.OrganizationMemberList
import dev.tula.auth.generated.StartOrganizationDomainRequest
import dev.tula.auth.generated.TulaOperations
import dev.tula.auth.generated.UpdateOrganizationDomainRequest
import dev.tula.auth.generated.UpdateOrganizationMemberRequest
import dev.tula.auth.generated.VerifyOrganizationDomainRequest

// Managing an organization from the client (ADR 0065): its members and their roles, and the
// domains it claims. What a member may do is decided by the server from the role they hold
// now, on every call; these are the calls.

/**
 * An organization's members (ADR 0065). Reading needs `org:sys:memberships:read` or
 * `:manage`; changing needs `org:sys:memberships:manage`, which the API reads from the
 * user's membership on every call.
 *
 * ```kotlin
 * val page = client.organizations.members.list(org.id)
 * client.organizations.members.changeRole(org.id, page.data[0].userId, "admin")
 * ```
 */
class TulaOrganizationMembers internal constructor(private val context: FlowContext) {
    /**
     * The organization's members, oldest first, with each one's name, address and role key.
     * Only the first page.
     *
     * @param organizationId The organization.
     * @return The page.
     * @throws TulaError `organization.not_a_member`, `organization.permission_required`,
     *   `organization.disabled`.
     */
    suspend fun list(organizationId: String): OrganizationMemberList = context.transport.decode(
        OrganizationMemberList.serializer(),
        context.session.authorized(
            TulaOperations.listMyOrganizationMembers,
            CallInput(params = mapOf("organizationId" to organizationId)),
        ),
    )

    /**
     * Give a member another role, one whose permissions the user holds themselves. The
     * member's sessions carry it from their next refresh. **A `PATCH` call: the default engine
     * cannot send one** (see [UrlConnectionEngine]).
     *
     * @param organizationId The organization.
     * @param userId The member.
     * @param role The key of the new role.
     * @return The member, as they are now.
     * @throws TulaError `organization.permission_required`, `organization.role_unknown`,
     *   `organization.role_not_assignable`, `organization.last_manager`.
     */
    suspend fun changeRole(organizationId: String, userId: String, role: String): OrganizationMember =
        context.transport.decode(
            OrganizationMember.serializer(),
            context.session.authorized(
                TulaOperations.updateMyOrganizationMember,
                CallInput(
                    params = mapOf("organizationId" to organizationId, "userId" to userId),
                    body = encode(UpdateOrganizationMemberRequest.serializer(), UpdateOrganizationMemberRequest(role)),
                ),
            ),
        )

    /**
     * Remove a member. The user keeps their account; to remove yourself use
     * [TulaOrganizations.leave].
     *
     * @param organizationId The organization.
     * @param userId The member.
     * @throws TulaError `organization.permission_required`, `organization.last_manager`.
     */
    suspend fun remove(organizationId: String, userId: String) {
        context.session.authorized(
            TulaOperations.removeMyOrganizationMember,
            CallInput(params = mapOf("organizationId" to organizationId, "userId" to userId)),
        )
    }

    override fun toString(): String = "TulaOrganizationMembers"
}

/**
 * An organization's domains (ADR 0065, "Verified domains"): the organization claims one by a
 * code emailed to an address on it, and a verified one suggests or joins the people who sign
 * up with a verified address on it. Needs `org:sys:domains:manage`, which the API reads from
 * the user's membership on every call.
 *
 * ```kotlin
 * val claim = client.organizations.domains.start(org.id, "acme.com", "ada@acme.com", OrganizationDomainMode.Suggest)
 * client.organizations.domains.verify(org.id, claim.id, "123456")
 * ```
 */
class TulaOrganizationDomains internal constructor(private val context: FlowContext) {
    /**
     * The organization's domains, oldest first: claims waiting for a code and verified ones.
     * Each row's `status` is pending, verified or needs-reverification; `expiresAt` is when a
     * verified claim must be proved again.
     *
     * @param organizationId The organization.
     * @return The domains.
     * @throws TulaError `organization.not_a_member`, `auth.forbidden`, `organization.disabled`.
     */
    suspend fun list(organizationId: String): OrganizationDomainList = context.transport.decode(
        OrganizationDomainList.serializer(),
        context.session.authorized(
            TulaOperations.listMyOrganizationDomains,
            CallInput(params = mapOf("id" to organizationId)),
        ),
    )

    /**
     * Claim a domain: email a code to an address on it. Sent again for a pending claim it
     * emails a new code.
     *
     * @param organizationId The organization.
     * @param domain The domain, such as `acme.com`.
     * @param email An address on it, which receives the code.
     * @param mode What a verified domain does: [OrganizationDomainMode.Suggest] or
     *   [OrganizationDomainMode.AutoJoin].
     * @return The claim, pending until [verify].
     * @throws TulaError `organization.domain_public`, `organization.domain_taken`,
     *   `organization.domain_address_mismatch`, `organization.domain_limit`, `rate_limited`.
     */
    suspend fun start(
        organizationId: String,
        domain: String,
        email: String,
        mode: OrganizationDomainMode,
    ): OrganizationDomain = context.transport.decode(
        OrganizationDomain.serializer(),
        context.session.authorized(
            TulaOperations.startMyOrganizationDomain,
            CallInput(
                params = mapOf("id" to organizationId),
                body = encode(
                    StartOrganizationDomainRequest.serializer(),
                    StartOrganizationDomainRequest(domain = domain, email = email, mode = mode),
                ),
            ),
        ),
    )

    /**
     * Prove the claim with the code that was emailed.
     *
     * @param organizationId The organization.
     * @param domainId The claim.
     * @param code The emailed code.
     * @return The verified domain.
     * @throws TulaError `verification.invalid_code` and its siblings, `organization.domain_taken`.
     */
    suspend fun verify(organizationId: String, domainId: String, code: String): OrganizationDomain =
        context.transport.decode(
            OrganizationDomain.serializer(),
            context.session.authorized(
                TulaOperations.verifyMyOrganizationDomain,
                CallInput(
                    params = mapOf("id" to organizationId, "domainId" to domainId),
                    body = encode(VerifyOrganizationDomainRequest.serializer(), VerifyOrganizationDomainRequest(code)),
                ),
            ),
        )

    /**
     * Change what a domain does. **A `PATCH` call: the default engine cannot send one** (see
     * [UrlConnectionEngine]).
     *
     * @param organizationId The organization.
     * @param domainId The domain.
     * @param mode [OrganizationDomainMode.Suggest] or [OrganizationDomainMode.AutoJoin].
     * @return The domain.
     * @throws TulaError `auth.forbidden`, `organization.not_a_member`.
     */
    suspend fun update(organizationId: String, domainId: String, mode: OrganizationDomainMode): OrganizationDomain =
        context.transport.decode(
            OrganizationDomain.serializer(),
            context.session.authorized(
                TulaOperations.updateMyOrganizationDomain,
                CallInput(
                    params = mapOf("id" to organizationId, "domainId" to domainId),
                    body = encode(UpdateOrganizationDomainRequest.serializer(), UpdateOrganizationDomainRequest(mode)),
                ),
            ),
        )

    /**
     * Remove a domain. Later sign-ups are neither offered nor joined to the organization;
     * members stay.
     *
     * @param organizationId The organization.
     * @param domainId The domain.
     * @throws TulaError `auth.forbidden`, `organization.not_a_member`.
     */
    suspend fun remove(organizationId: String, domainId: String) {
        context.session.authorized(
            TulaOperations.removeMyOrganizationDomain,
            CallInput(params = mapOf("id" to organizationId, "domainId" to domainId)),
        )
    }

    override fun toString(): String = "TulaOrganizationDomains"
}
