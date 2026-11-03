package dev.tula.auth

import dev.tula.auth.generated.AcceptedInvitation
import dev.tula.auth.generated.ActiveOrganization
import dev.tula.auth.generated.CreateOrganizationInvitationRequest
import dev.tula.auth.generated.CreateOrganizationRequest
import dev.tula.auth.generated.InvitationPreview
import dev.tula.auth.generated.InvitationTokenRequest
import dev.tula.auth.generated.OrganizationInvitation
import dev.tula.auth.generated.OrganizationInvitationList
import dev.tula.auth.generated.OrganizationSuggestionList
import dev.tula.auth.generated.TulaJson
import dev.tula.auth.generated.TulaOperations
import dev.tula.auth.generated.UserOrganization
import dev.tula.auth.generated.UserOrganizationList
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.net.URLDecoder
import java.util.Base64

// The signed-in user's organizations (ADR 0065): which they belong to, which one the session
// acts in, an invitation to one, and the organizations a verified address is offered. The
// types and the operations are generated (ADR 0050); this file is the calls, and the one
// reading of the claims an access token carries for the active organization.

/**
 * The active organization an access token says its session acts in: the `org_id`,
 * `org_role` and `org_perms` claims (ADR 0065).
 *
 * **Read for showing, never for deciding.** The claims are read from the token the client
 * holds, without verifying its signature: this decides what an app draws, and the app's own
 * server checks the same keys from a token it verifies. They are as old as the token (a role
 * changed since is seen at the next refresh, within a minute).
 *
 * The three claims are returned together or not at all, as `@tula-tech/core` and
 * `@tula-tech/nextjs` read them: a token with one but not the others, a value of another
 * type, an id or a role key outside their grammar, more than [MAX_PERMISSIONS] permissions, a
 * permission outside the permission grammar or claims over [MAX_BYTES] bytes has **no**
 * active organization, whole. Never repaired and never partly believed.
 *
 * Kotlin cannot overload on the argument's name, so the two checks are [hasPermission] and
 * [hasRole] (the other clients call both `has`).
 *
 * ```kotlin
 * val organization = client.organizations.active()
 * if (organization?.hasPermission("org:billing:read") == true) showBilling()
 * ```
 */
class TulaOrganizationClaims internal constructor(
    /** The active organization's id. */
    val organizationId: String,
    /** The key of the member's role in it (`admin`, `member`, ...). */
    val role: String,
    /** The permission keys of that role, as of the token's issue. */
    val permissions: List<String>,
) {
    /**
     * Whether the active organization's role holds a permission. Exact: there is no wildcard
     * (`org:billing:*` matches nothing) and no key implies another (`manage` does not include
     * `read`). An empty key never matches.
     *
     * @param permission A permission key such as `org:billing:read`.
     * @return Whether the role's permissions list that very key.
     */
    fun hasPermission(permission: String): Boolean = permission.isNotEmpty() && permissions.contains(permission)

    /**
     * Whether the member's role in the active organization is this one. An empty key never
     * matches.
     *
     * @param role A role key such as `admin`.
     * @return Whether it is the member's role.
     */
    fun hasRole(role: String): Boolean = role.isNotEmpty() && this.role == role

    override fun equals(other: Any?): Boolean =
        other is TulaOrganizationClaims &&
            other.organizationId == organizationId && other.role == role && other.permissions == permissions

    override fun hashCode(): Int = (organizationId.hashCode() * 31 + role.hashCode()) * 31 + permissions.hashCode()

    override fun toString(): String = "TulaOrganizationClaims"

    /** The UTF-8 length of the JSON of the three claims, which [MAX_BYTES] caps. */
    internal fun bytes(): Int {
        val keys = permissions.joinToString(",") { "\"$it\"" }
        // Everything that passed the grammars is ASCII, so characters are bytes.
        return "{\"$ID_CLAIM\":\"$organizationId\",\"$ROLE_CLAIM\":\"$role\",\"$PERMISSIONS_CLAIM\":[$keys]}".length
    }

    companion object {
        /** The claim that holds the organization's id. */
        const val ID_CLAIM = "org_id"

        /** The claim that holds the key of the member's role. */
        const val ROLE_CLAIM = "org_role"

        /** The claim that holds the role's permission keys. */
        const val PERMISSIONS_CLAIM = "org_perms"

        /** Most permissions a role (and so the claim) holds. */
        const val MAX_PERMISSIONS = 32

        /** The longest a permission key may be, in characters. */
        const val MAX_PERMISSION_KEY_LENGTH = 100

        /** The most bytes the three claims' JSON may take. */
        const val MAX_BYTES = 2560

        /**
         * The organization claims of an access token, or `null` when it has no active
         * organization (or claims that are not what a Tula server issues). The signature is
         * not verified: see the type's note.
         *
         * @param accessToken An access token, such as `client.session.getToken()` returns.
         * @return The claims, or `null`.
         */
        fun read(accessToken: String?): TulaOrganizationClaims? {
            val claims = accessToken?.let(::payloadOf) ?: return null
            val id = (claims[ID_CLAIM] as? JsonPrimitive)?.takeIf { it.isString }?.content
            val role = (claims[ROLE_CLAIM] as? JsonPrimitive)?.takeIf { it.isString }?.content
            val listed = claims[PERMISSIONS_CLAIM] as? JsonArray
            if (id == null || !isIdentifier(id) || role == null || !isRoleKey(role) ||
                listed == null || listed.size > MAX_PERMISSIONS
            ) {
                return null
            }
            val permissions = ArrayList<String>(listed.size)
            for (entry in listed) {
                val key = (entry as? JsonPrimitive)?.takeIf { it.isString }?.content
                if (key == null || !isPermissionKey(key)) {
                    return null
                }
                permissions.add(key)
            }
            val found = TulaOrganizationClaims(id, role, permissions)
            return if (found.bytes() > MAX_BYTES) null else found
        }

        /** The payload of a JWT, or `null` for what is not one. */
        private fun payloadOf(token: String): JsonObject? {
            val parts = token.split('.')
            if (parts.size != 3) {
                return null
            }
            return try {
                TulaJson.parseToJsonElement(
                    Base64.getUrlDecoder().decode(parts[1]).toString(Charsets.UTF_8),
                ) as? JsonObject
            } catch (_: IllegalArgumentException) {
                null
            } catch (_: SerializationException) {
                null
            }
        }

        // The grammars of `@tula-tech/contract` (`custom-claims.ts`, `organization-permissions.ts`),
        // written out by hand: ASCII only, so a lookalike letter is never a letter.

        private fun isLower(c: Char) = c in 'a'..'z'

        private fun isDigit(c: Char) = c in '0'..'9'

        /** An organization's id in a token: URL-safe characters, at most 64. */
        private fun isIdentifier(text: String): Boolean =
            text.length in 1..64 && text.all { isLower(it) || it in 'A'..'Z' || isDigit(it) || it == '_' || it == '-' }

        /** `[a-z][a-z0-9_]{0,31}`: a role key, and each part of a permission key. */
        private fun isRoleKey(text: String): Boolean =
            text.length in 1..32 && isLower(text[0]) && text.drop(1).all { isLower(it) || isDigit(it) || it == '_' }

        /** `org:<feature>:<action>`, or `org:sys:<feature>:<action>`; the feature `sys` is reserved for the second. */
        private fun isPermissionKey(text: String): Boolean {
            if (text.length > MAX_PERMISSION_KEY_LENGTH) {
                return false
            }
            val parts = text.split(':')
            if (parts.first() != "org") {
                return false
            }
            return when (parts.size) {
                3 -> parts[1] != "sys" && isRoleKey(parts[1]) && isRoleKey(parts[2])
                4 -> parts[1] == "sys" && isRoleKey(parts[2]) && isRoleKey(parts[3])
                else -> false
            }
        }
    }
}

/**
 * An invitation's token as read from the address an emailed link opened the app with.
 *
 * The token travels in the address's fragment (`#tula_invitation=...`), which is never sent
 * to a server: it is in no log of the web page the link may lead to first, and in no
 * `Referer`. The app is opened by an app link or a custom scheme; read the token from that
 * address, hand it to [TulaOrganizationInvitations], and drop the address.
 *
 * It is a secret: it prints as its type's name, and it is never logged or put in an error.
 */
class TulaInvitationLink private constructor(
    /** The token, for `preview`, `accept` and `decline`. */
    val token: String,
    /** The address without the token, to keep instead of the one that carried it. */
    val cleanUrl: String,
) {
    override fun toString(): String = "TulaInvitationLink"

    companion object {
        /** The fragment parameter the token travels in. */
        const val FRAGMENT_PARAMETER = "tula_invitation"

        /**
         * Read the invitation token from the address a link opened the app with.
         *
         * @param url The address, as the app was opened with it.
         * @return The token and the address without it, or `null` when the address carries
         *   no token (or an empty one).
         */
        fun read(url: String): TulaInvitationLink? {
            val hash = url.indexOf('#')
            if (hash < 0) {
                return null
            }
            val base = url.substring(0, hash)
            var token: String? = null
            val rest = ArrayList<String>()
            for (pair in url.substring(hash + 1).split('&').filter { it.isNotEmpty() }) {
                val equals = pair.indexOf('=')
                val name = if (equals < 0) pair else pair.substring(0, equals)
                if (decoded(name) == FRAGMENT_PARAMETER) {
                    // The first one is the token, as `URLSearchParams.get` reads; all are dropped.
                    if (token == null) {
                        token = decoded(if (equals < 0) "" else pair.substring(equals + 1)) ?: ""
                    }
                } else {
                    rest.add(pair)
                }
            }
            val found = token?.takeIf { it.isNotEmpty() } ?: return null
            val remaining = rest.joinToString("&")
            return TulaInvitationLink(found, if (remaining.isEmpty()) base else "$base#$remaining")
        }

        /** Percent-decoded as a form value is (a `+` is a space); `null` for a malformed escape. */
        private fun decoded(text: String): String? =
            try {
                URLDecoder.decode(text, Charsets.UTF_8)
            } catch (_: IllegalArgumentException) {
                null
            }
    }
}

/**
 * The signed-in user's organizations (ADR 0065) and the one the session acts in. While the
 * environment's `organizations.enabled` setting is off, each call answers
 * `organization.disabled`.
 *
 * ```kotlin
 * val page = client.organizations.list()
 * val acme = client.organizations.create(name = "Acme", slug = "acme")
 * client.organizations.setActive(acme.id) // the next access token carries the claims
 * ```
 */
class TulaOrganizations internal constructor(private val context: FlowContext) {
    /**
     * Invitations by email: previewing, accepting and declining one with the token its link
     * carries, and, for a member who may, inviting and withdrawing.
     */
    val invitations: TulaOrganizationInvitations get() = TulaOrganizationInvitations(context)

    /**
     * The organizations the user belongs to, with their role and its permission keys in each,
     * and the one the session acts in. Only the first page the API answers.
     *
     * @return The page; `activeOrganizationId` is `null` for the personal account.
     * @throws TulaError `auth.unauthenticated` when signed out, `organization.disabled`.
     */
    suspend fun list(): UserOrganizationList = context.transport.decode(
        UserOrganizationList.serializer(),
        context.session.authorized(TulaOperations.listMyOrganizations),
    )

    /**
     * Create an organization the user owns: they hold the environment's creator role in it.
     * The session does not switch to it; [setActive] does.
     *
     * @param name Its name.
     * @param slug Its slug: lower-case letters, digits and hyphens, unique in the environment.
     * @return The organization, with the user's role and its permission keys.
     * @throws TulaError `organization.creation_disabled`, `organization.limit_reached`,
     *   `organization.slug_taken`, `organization.disabled`.
     */
    suspend fun create(name: String, slug: String): UserOrganization = checked(
        context.transport.decode(
            UserOrganization.serializer(),
            context.session.authorized(
                TulaOperations.createMyOrganization,
                CallInput(body = encode(CreateOrganizationRequest.serializer(), CreateOrganizationRequest(name, slug))),
            ),
        ),
    )

    /**
     * Make an organization the one the session acts in, or `null` for the personal account.
     * The client installs the access token the API answers with, which carries `org_id`,
     * `org_role` and `org_perms` (read them with [active]); the refresh token is not
     * replaced. A refresh keeps the choice and reads the membership again.
     *
     * @param organizationId The organization, or `null`.
     * @return The session's active organization now.
     * @throws TulaError `organization.not_a_member` (also for an organization that does not
     *   exist), `organization.personal_account_disabled` for `null` where the environment has
     *   no personal accounts, `organization.disabled`, `auth.unauthenticated` when the client
     *   was signed out, or signed in as someone else, while the call was in flight.
     */
    suspend fun setActive(organizationId: String?): ActiveOrganization =
        context.session.setActiveOrganization(organizationId)

    /**
     * Go back to the personal account: the same as `setActive(null)`.
     *
     * @throws TulaError As [setActive].
     */
    suspend fun clearActive(): ActiveOrganization = setActive(null)

    /**
     * The active organization the client's access token says, or `null` for the personal
     * account. A token about to expire is refreshed first. See [TulaOrganizationClaims] for
     * what this is good for: showing, not deciding.
     *
     * @return The claims, or `null` when no organization is active (or nobody is signed in).
     * @throws TulaError when a refresh was needed and could not be made.
     */
    suspend fun active(): TulaOrganizationClaims? = TulaOrganizationClaims.read(context.session.getToken())

    /**
     * Whether the active organization's role holds a permission: `active()?.hasPermission(...)`,
     * `false` with no active organization.
     *
     * @param permission A permission key such as `org:billing:read`.
     * @return Whether the active organization's role holds that very key.
     * @throws TulaError As [active].
     */
    suspend fun hasPermission(permission: String): Boolean = active()?.hasPermission(permission) ?: false

    /**
     * Whether the member's role in the active organization is this one, `false` with no
     * active organization.
     *
     * @param role A role key such as `admin`.
     * @return Whether it is the member's role in the active organization.
     * @throws TulaError As [active].
     */
    suspend fun hasRole(role: String): Boolean = active()?.hasRole(role) ?: false

    /**
     * The organizations the user may join because their **verified** email address is on a
     * domain the organization verified: each one's id, name and slug, and nothing else. The
     * list is empty for an address that is not verified and for a domain that is not exactly
     * the address's.
     *
     * @return The page of suggestions, empty when there are none.
     * @throws TulaError `auth.unauthenticated` when signed out, `organization.disabled`.
     */
    suspend fun suggestions(): OrganizationSuggestionList = context.transport.decode(
        OrganizationSuggestionList.serializer(),
        context.session.authorized(TulaOperations.listMyOrganizationSuggestions),
    )

    /**
     * Join a suggested organization with the environment's default role. The server decides
     * again, so an organization that is no longer offered is refused whatever the list said.
     *
     * @param organizationId The organization, from [suggestions].
     * @return The organization, with the user's role and its permission keys.
     * @throws TulaError `organization.suggestion_unavailable`, `organization.member_exists`,
     *   `organization.disabled`.
     */
    suspend fun join(organizationId: String): UserOrganization = checked(
        context.transport.decode(
            UserOrganization.serializer(),
            context.session.authorized(
                TulaOperations.joinOrganizationSuggestion,
                CallInput(params = mapOf("organizationId" to organizationId)),
            ),
        ),
    )

    /** An organization the API answered, checked before it is handed on: a 200 that names none is not one. */
    private fun checked(organization: UserOrganization): UserOrganization {
        if (organization.id.isEmpty()) {
            throw context.transport.invalid()
        }
        return organization
    }

    override fun toString(): String = "TulaOrganizations"
}

/**
 * Invitations to an organization (ADR 0065), by email.
 *
 * The token an invitation's link carries is a secret: it is sent in a request body and
 * nowhere else, and it is in no error, no log line and no URL the client builds. Read it
 * from the opened address with [TulaInvitationLink.read].
 *
 * ```kotlin
 * TulaInvitationLink.read(openedUrl)?.let { link ->
 *     val preview = client.organizations.invitations.preview(link.token)
 *     // show preview.organizationName, then, once the user signed in as preview.email:
 *     val joined = client.organizations.invitations.accept(link.token)
 * }
 * ```
 */
class TulaOrganizationInvitations internal constructor(private val context: FlowContext) {
    /**
     * What an invitation's token shows before anyone has signed in: the organization's name,
     * the role's key and the address invited, to prefill a sign-up. Needs no session.
     *
     * @param token The token from the link's fragment.
     * @return What the invitation is for.
     * @throws TulaError `organization.invitation_not_found`, `organization.invitation_expired`,
     *   `organization.invitation_revoked`, `organization.invitation_used`.
     */
    suspend fun preview(token: String): InvitationPreview = context.transport.decode(
        InvitationPreview.serializer(),
        context.transport.call(
            TulaOperations.previewOrganizationInvitation,
            CallInput(body = encode(InvitationTokenRequest.serializer(), InvitationTokenRequest(token))),
        ),
    )

    /**
     * Join the organization the token invites to, with the invitation's role. Only the
     * account the invitation was sent to may, and only with a verified address. The session
     * does not switch to it; [TulaOrganizations.setActive] does.
     *
     * @param token The token from the link's fragment.
     * @return The organization joined, with the role and its permission keys.
     * @throws TulaError `organization.invitation_wrong_account`,
     *   `organization.invitation_email_unverified`, `organization.invitation_role_gone`,
     *   `organization.member_exists`, and what [preview] is refused with.
     */
    suspend fun accept(token: String): AcceptedInvitation {
        val joined = context.transport.decode(
            AcceptedInvitation.serializer(),
            context.session.authorized(
                TulaOperations.acceptOrganizationInvitation,
                CallInput(body = encode(InvitationTokenRequest.serializer(), InvitationTokenRequest(token))),
            ),
        )
        if (joined.id.isEmpty()) {
            throw context.transport.invalid()
        }
        return joined
    }

    /**
     * Turn an invitation down: it is used up and nobody joins.
     *
     * @param token The token from the link's fragment.
     * @throws TulaError As [accept], but a deleted role does not matter.
     */
    suspend fun decline(token: String) {
        context.session.authorized(
            TulaOperations.declineOrganizationInvitation,
            CallInput(body = encode(InvitationTokenRequest.serializer(), InvitationTokenRequest(token))),
        )
    }

    /**
     * An organization's pending invitations, newest first, for a member whose role holds
     * `org:sys:invitations:manage`. Never a token. Only the first page.
     *
     * @param organizationId The organization.
     * @return The first page of pending invitations.
     * @throws TulaError `organization.not_a_member`, `organization.permission_required`,
     *   `organization.disabled`.
     */
    suspend fun list(organizationId: String): OrganizationInvitationList = context.transport.decode(
        OrganizationInvitationList.serializer(),
        context.session.authorized(
            TulaOperations.listMyOrganizationInvitations,
            CallInput(params = mapOf("organizationId" to organizationId)),
        ),
    )

    /**
     * Email an invitation. The link leads to [redirectUrl] (one of the environment's allowed
     * redirect URLs) with the token in its fragment. The role must be within the permissions
     * of the inviter's own.
     *
     * @param organizationId The organization.
     * @param email The address to invite.
     * @param role The key of the role the invitation gives.
     * @param redirectUrl Where the emailed link leads: the app's link, say.
     * @return The invitation. The token is only in the email.
     * @throws TulaError `organization.not_a_member`, `organization.permission_required`,
     *   `organization.role_not_assignable`, `organization.role_unknown`,
     *   `organization.member_exists`, `organization.invitation_exists`,
     *   `request.redirect_not_allowed`, `rate_limited`.
     */
    suspend fun invite(organizationId: String, email: String, role: String, redirectUrl: String): OrganizationInvitation =
        context.transport.decode(
            OrganizationInvitation.serializer(),
            context.session.authorized(
                TulaOperations.inviteToMyOrganization,
                CallInput(
                    params = mapOf("organizationId" to organizationId),
                    body = encode(
                        CreateOrganizationInvitationRequest.serializer(),
                        CreateOrganizationInvitationRequest(email = email, role = role, redirectUrl = redirectUrl),
                    ),
                ),
            ),
        )

    /**
     * Withdraw a pending invitation: its link stops working.
     *
     * @param organizationId The organization.
     * @param invitationId The invitation.
     * @throws TulaError `organization.invitation_used`, `organization.invitation_revoked`,
     *   `organization.invitation_expired` for one that is no longer pending, and what [list]
     *   is refused with.
     */
    suspend fun revoke(organizationId: String, invitationId: String) {
        context.session.authorized(
            TulaOperations.revokeMyOrganizationInvitation,
            CallInput(params = mapOf("organizationId" to organizationId, "invitationId" to invitationId)),
        )
    }

    override fun toString(): String = "TulaOrganizationInvitations"
}
