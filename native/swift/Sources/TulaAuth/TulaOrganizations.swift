import Foundation

// The signed-in user's organizations (ADR 0065): which they belong to, which one the session
// acts in, an invitation to one, and the organizations a verified address is offered. The
// types and the operations are generated (ADR 0050); this file is the calls, and the one
// reading of the claims an access token carries for the active organization.

/// The active organization an access token says its session acts in: the `org_id`,
/// `org_role` and `org_perms` claims (ADR 0065).
///
/// **Read for showing, never for deciding.** The claims are read from the token the client
/// holds, without verifying its signature: this decides what an app draws, and the app's
/// own server checks the same keys from a token it verifies. They are as old as the token
/// (a role changed since is seen at the next refresh, within a minute).
///
/// The three claims are returned together or not at all, as `@tula-tech/core` and
/// `@tula-tech/nextjs` read them: a token with one but not the others, a value of another
/// type, an id or a role key outside their grammar, more than 32 permissions, a permission
/// outside the permission grammar or claims over 2,560 bytes has **no** active organization,
/// whole. Never repaired and never partly believed.
///
/// ```swift
/// if let organization = try await tula.organizations.active(), organization.has(permission: "org:billing:read") {
///     showBilling()
/// }
/// ```
public struct TulaOrganizationClaims: Hashable, Sendable {
    /// The claim that holds the organization's id.
    public static let idClaim = "org_id"
    /// The claim that holds the key of the member's role.
    public static let roleClaim = "org_role"
    /// The claim that holds the role's permission keys.
    public static let permissionsClaim = "org_perms"
    /// Most permissions a role (and so the claim) holds.
    public static let maxPermissions = 32
    /// The longest a permission key may be, in characters.
    public static let maxPermissionKeyLength = 100
    /// The most bytes the three claims' JSON may take.
    public static let maxBytes = 2560

    /// The active organization's id.
    public let organizationId: String
    /// The key of the member's role in it (`admin`, `member`, …).
    public let role: String
    /// The permission keys of that role, as of the token's issue.
    public let permissions: [String]

    /// Whether the active organization's role holds a permission. Exact: there is no
    /// wildcard (`org:billing:*` matches nothing) and no key implies another (`manage` does
    /// not include `read`). An empty key never matches.
    ///
    /// - Parameter permission: A permission key such as `org:billing:read`.
    /// - Returns: Whether the role's permissions list that very key.
    public func has(permission: String) -> Bool {
        !permission.isEmpty && permissions.contains(permission)
    }

    /// Whether the member's role in the active organization is this one. An empty key never
    /// matches.
    ///
    /// - Parameter role: A role key such as `admin`.
    /// - Returns: Whether it is the member's role.
    public func has(role: String) -> Bool {
        !role.isEmpty && self.role == role
    }

    /// The organization claims of an access token, or `nil` when it has no active
    /// organization (or claims that are not what a Tula server issues). The signature is not
    /// verified: see the type's note.
    ///
    /// - Parameter accessToken: An access token, such as `tula.session.getToken()` returns.
    /// - Returns: The claims, or `nil`.
    public static func read(accessToken: String?) -> TulaOrganizationClaims? {
        guard let accessToken, case .object(let claims)? = TulaOrganizationClaims.payload(of: accessToken) else {
            return nil
        }
        return read(claims: claims)
    }

    /// The organization claims of a token's payload, under the rules in the type's note.
    static func read(claims: [String: TulaJSONValue]) -> TulaOrganizationClaims? {
        guard
            case .string(let id)? = claims[idClaim], isIdentifier(id),
            case .string(let role)? = claims[roleClaim], isRoleKey(role),
            case .array(let listed)? = claims[permissionsClaim], listed.count <= maxPermissions
        else {
            return nil
        }
        var permissions: [String] = []
        for entry in listed {
            guard case .string(let key) = entry, isPermissionKey(key) else {
                return nil
            }
            permissions.append(key)
        }
        let found = TulaOrganizationClaims(organizationId: id, role: role, permissions: permissions)
        return found.bytes > maxBytes ? nil : found
    }

    /// The UTF-8 length of the JSON of the three claims, which `maxBytes` caps. Everything
    /// that passed the grammars is ASCII.
    var bytes: Int {
        let keys = permissions.map { "\"\($0)\"" }.joined(separator: ",")
        let json =
            "{\"\(TulaOrganizationClaims.idClaim)\":\"\(organizationId)\","
            + "\"\(TulaOrganizationClaims.roleClaim)\":\"\(role)\","
            + "\"\(TulaOrganizationClaims.permissionsClaim)\":[\(keys)]}"
        return json.utf8.count
    }

    /// The payload of a JWT, or `nil` for what is not one.
    static func payload(of token: String) -> TulaJSONValue? {
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else {
            return nil
        }
        var payload = parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let data = Data(base64Encoded: payload) else {
            return nil
        }
        return try? JSONDecoder().decode(TulaJSONValue.self, from: data)
    }

    // The grammars of `@tula-tech/contract` (`custom-claims.ts`, `organization-permissions.ts`),
    // written out by hand: ASCII only, so a lookalike letter is never a letter.

    /// An organization's id in a token: URL-safe characters, at most 64.
    private static func isIdentifier(_ text: String) -> Bool {
        let scalars = Array(text.unicodeScalars)
        return (1...64).contains(scalars.count)
            && scalars.allSatisfy { isLetter($0) || isDigit($0) || $0 == "_" || $0 == "-" }
    }

    /// `[a-z][a-z0-9_]{0,31}`: a role key, and each part of a permission key.
    private static func isRoleKey(_ text: String) -> Bool {
        let scalars = Array(text.unicodeScalars)
        guard (1...32).contains(scalars.count), let first = scalars.first, isLowerLetter(first) else {
            return false
        }
        return scalars.dropFirst().allSatisfy { isLowerLetter($0) || isDigit($0) || $0 == "_" }
    }

    /// `org:<feature>:<action>`, or `org:sys:<feature>:<action>`; the feature `sys` is reserved
    /// for the second form.
    private static func isPermissionKey(_ text: String) -> Bool {
        guard text.count <= maxPermissionKeyLength else {
            return false
        }
        let parts = text.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        guard parts.first == "org" else {
            return false
        }
        switch parts.count {
        case 3:
            return parts[1] != "sys" && isRoleKey(parts[1]) && isRoleKey(parts[2])
        case 4:
            return parts[1] == "sys" && isRoleKey(parts[2]) && isRoleKey(parts[3])
        default:
            return false
        }
    }

    private static func isLowerLetter(_ scalar: Unicode.Scalar) -> Bool { scalar.value >= 97 && scalar.value <= 122 }
    private static func isLetter(_ scalar: Unicode.Scalar) -> Bool {
        isLowerLetter(scalar) || (scalar.value >= 65 && scalar.value <= 90)
    }
    private static func isDigit(_ scalar: Unicode.Scalar) -> Bool { scalar.value >= 48 && scalar.value <= 57 }
}

/// An invitation's token as read from the address an emailed link opened the app with.
///
/// The token travels in the address's fragment (`#tula_invitation=…`), which is never sent
/// to a server: it is in no log of the web page the link may lead to first, and in no
/// `Referer`. The app is opened by a universal link or a custom scheme; read the token from
/// that address, hand it to `tula.organizations.invitations`, and drop the address.
///
/// It is a secret: it prints as its type's name, and it is never logged or put in an error.
public struct TulaInvitationLink: Sendable, TulaRedacted {
    /// The fragment parameter the token travels in.
    public static let fragmentParameter = "tula_invitation"

    /// The token, for `preview(token:)`, `accept(token:)` and `decline(token:)`.
    public let token: String
    /// The address without the token, to keep instead of the one that carried it.
    public let cleanURL: String

    /// Read the invitation token from the address a link opened the app with.
    ///
    /// - Parameter url: The address, as the app was opened with it.
    /// - Returns: The token and the address without it, or `nil` when the address carries no
    ///   token (or an empty one).
    public static func read(_ url: String) -> TulaInvitationLink? {
        guard let hash = url.firstIndex(of: "#") else {
            return nil
        }
        let base = String(url[..<hash])
        let pairs = url[url.index(after: hash)...].split(separator: "&", omittingEmptySubsequences: true)
        var token: String?
        var rest: [Substring] = []
        for pair in pairs {
            let name = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)[0]
            if name.removingPercentEncoding == fragmentParameter {
                // The first one is the token, as `URLSearchParams.get` reads; all are dropped.
                if token == nil {
                    let value = pair.dropFirst(name.count + 1)
                    token = String(value).replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? ""
                }
            } else {
                rest.append(pair)
            }
        }
        guard let token, !token.isEmpty else {
            return nil
        }
        let remaining = rest.joined(separator: "&")
        return TulaInvitationLink(token: token, cleanURL: remaining.isEmpty ? base : "\(base)#\(remaining)")
    }

    /// Read the invitation token from the address a link opened the app with.
    ///
    /// - Parameter url: The address, as the app was opened with it.
    /// - Returns: The token and the address without it, or `nil` when it carries none.
    public static func read(_ url: URL) -> TulaInvitationLink? {
        read(url.absoluteString)
    }
}

/// The signed-in user's organizations (ADR 0065) and the one the session acts in. While the
/// environment's `organizations.enabled` setting is off, each call answers
/// `organization.disabled`.
///
/// ```swift
/// let page = try await tula.organizations.list()
/// let acme = try await tula.organizations.create(name: "Acme", slug: "acme")
/// try await tula.organizations.setActive(acme.id)   // the next access token carries the claims
/// ```
public struct TulaOrganizations: Sendable, TulaRedacted {
    let context: FlowContext

    /// Invitations by email: previewing, accepting and declining one with the token its link
    /// carries, and, for a member who may, inviting and withdrawing.
    public var invitations: TulaOrganizationInvitations { TulaOrganizationInvitations(context: context) }

    /// The organizations the user belongs to, with their role and its permission keys in each,
    /// and the one the session acts in. Only the first page the API answers.
    ///
    /// - Returns: The page; `activeOrganizationId` is `nil` for the personal account.
    /// - Throws: `TulaError`: `auth.unauthenticated` when signed out, `organization.disabled`.
    public func list() async throws -> UserOrganizationList {
        try await context.session.authorized(TulaOperations.listMyOrganizations, as: UserOrganizationList.self)
    }

    /// Create an organization the user owns: they hold the environment's creator role in it.
    /// The session does not switch to it; `setActive(_:)` does.
    ///
    /// - Parameters:
    ///   - name: Its name.
    ///   - slug: Its slug: lower-case letters, digits and hyphens, unique in the environment.
    /// - Returns: The organization, with the user's role and its permission keys.
    /// - Throws: `TulaError`: `organization.creation_disabled`, `organization.limit_reached`,
    ///   `organization.slug_taken`, `organization.disabled`.
    public func create(name: String, slug: String) async throws -> UserOrganization {
        try TulaOrganizations.checked(
            await context.session.authorized(
                TulaOperations.createMyOrganization,
                body: CreateOrganizationRequest(name: name, slug: slug), as: UserOrganization.self))
    }

    /// Make an organization the one the session acts in, or `nil` for the personal account.
    /// The client installs the access token the API answers with, which carries `org_id`,
    /// `org_role` and `org_perms` (read them with `active()`); the refresh token is not
    /// replaced. A refresh keeps the choice and reads the membership again.
    ///
    /// - Parameter organizationId: The organization, or `nil`.
    /// - Returns: The session's active organization now.
    /// - Throws: `TulaError`: `organization.not_a_member` (also for an organization that does
    ///   not exist), `organization.personal_account_disabled` for `nil` where the environment
    ///   has no personal accounts, `organization.disabled`, `auth.unauthenticated` when the
    ///   client was signed out, or signed in as someone else, while the call was in flight.
    @discardableResult
    public func setActive(_ organizationId: String?) async throws -> ActiveOrganization {
        try await context.session.setActiveOrganization(organizationId)
    }

    /// Go back to the personal account: the same as `setActive(nil)`.
    ///
    /// - Throws: As `setActive(_:)`.
    @discardableResult
    public func clearActive() async throws -> ActiveOrganization {
        try await setActive(nil)
    }

    /// The active organization the client's access token says, or `nil` for the personal
    /// account. A token about to expire is refreshed first. See `TulaOrganizationClaims` for
    /// what this is good for: showing, not deciding.
    ///
    /// - Returns: The claims, or `nil` when no organization is active (or nobody is signed in).
    /// - Throws: `TulaError` when a refresh was needed and could not be made.
    public func active() async throws -> TulaOrganizationClaims? {
        TulaOrganizationClaims.read(accessToken: try await context.session.getToken())
    }

    /// Whether the active organization's role holds a permission: `active()?.has(permission:)`,
    /// `false` with no active organization.
    ///
    /// - Parameter permission: A permission key such as `org:billing:read`.
    /// - Returns: Whether the active organization's role holds that very key.
    /// - Throws: As `active()`.
    public func has(permission: String) async throws -> Bool {
        try await active()?.has(permission: permission) ?? false
    }

    /// Whether the member's role in the active organization is this one, `false` with no
    /// active organization.
    ///
    /// - Parameter role: A role key such as `admin`.
    /// - Returns: Whether it is the member's role in the active organization.
    /// - Throws: As `active()`.
    public func has(role: String) async throws -> Bool {
        try await active()?.has(role: role) ?? false
    }

    /// The organizations the user may join because their **verified** email address is on a
    /// domain the organization verified: each one's id, name and slug, and nothing else. The
    /// list is empty for an address that is not verified and for a domain that is not
    /// exactly the address's.
    ///
    /// - Returns: The page of suggestions, empty when there are none.
    /// - Throws: `TulaError`: `auth.unauthenticated` when signed out, `organization.disabled`.
    public func suggestions() async throws -> OrganizationSuggestionList {
        try await context.session.authorized(
            TulaOperations.listMyOrganizationSuggestions, as: OrganizationSuggestionList.self)
    }

    /// Join a suggested organization with the environment's default role. The server decides
    /// again, so an organization that is no longer offered is refused whatever the list said.
    ///
    /// - Parameter organizationId: The organization, from `suggestions()`.
    /// - Returns: The organization, with the user's role and its permission keys.
    /// - Throws: `TulaError`: `organization.suggestion_unavailable`,
    ///   `organization.member_exists`, `organization.disabled`.
    public func join(_ organizationId: String) async throws -> UserOrganization {
        try TulaOrganizations.checked(
            await context.session.authorized(
                TulaOperations.joinOrganizationSuggestion, params: ["organizationId": organizationId],
                as: UserOrganization.self))
    }

    /// Rename an organization, or change its slug. Needs `org:sys:organization:manage`, which
    /// the API reads from the user's membership on every call.
    ///
    /// - Parameters:
    ///   - organizationId: The organization.
    ///   - name: A new name, or `nil` to keep it.
    ///   - slug: A new slug, or `nil` to keep it.
    /// - Returns: The organization with the user's role, as it is now.
    /// - Throws: `TulaError`: `organization.not_a_member`, `organization.permission_required`,
    ///   `organization.slug_taken`, `organization.disabled`.
    public func update(organizationId: String, name: String? = nil, slug: String? = nil) async throws
        -> UserOrganization
    {
        try TulaOrganizations.checked(
            await context.session.authorized(
                TulaOperations.updateMyOrganization, params: ["organizationId": organizationId],
                body: UpdateOrganizationRequest(name: name, slug: slug), as: UserOrganization.self))
    }

    /// Delete an organization for good, with its memberships, invitations and domains. Needs
    /// `org:sys:organization:delete`. Members' sessions leave it at their next refresh; if it
    /// was this session's active organization, call `setActive(_:)` for another one.
    ///
    /// - Parameter organizationId: The organization.
    /// - Throws: `TulaError`: `organization.not_a_member`, `organization.permission_required`,
    ///   `organization.disabled`.
    public func remove(organizationId: String) async throws {
        _ = try await context.session.authorized(
            TulaOperations.deleteMyOrganization, params: ["organizationId": organizationId],
            as: NoAnswer.self)
    }

    /// Leave an organization: remove the signed-in user's own membership, which needs no
    /// permission. The last member who can manage members cannot leave.
    ///
    /// - Parameter organizationId: The organization.
    /// - Throws: `TulaError`: `organization.not_a_member`, `organization.last_manager`,
    ///   `organization.disabled`.
    public func leave(organizationId: String) async throws {
        let userId: String
        if case .signedIn(_, let known?) = await context.session.state {
            userId = known.id
        } else {
            userId = try await context.session.authorized(TulaOperations.getMe, as: CurrentUser.self).id
        }
        try await members.remove(organizationId: organizationId, userId: userId)
    }

    /// The roles the user may give to an invitation or a member: those whose permissions they
    /// hold themselves. Needs `org:sys:invitations:manage` or `org:sys:memberships:manage`.
    ///
    /// - Parameter organizationId: The organization.
    /// - Returns: The roles' keys and names.
    /// - Throws: `TulaError`: `organization.not_a_member`, `organization.permission_required`,
    ///   `organization.disabled`.
    public func roles(organizationId: String) async throws -> AssignableRoleList {
        try await context.session.authorized(
            TulaOperations.listMyOrganizationRoles, params: ["organizationId": organizationId],
            as: AssignableRoleList.self)
    }

    /// An organization's members: reading, changing a role, removing one.
    public var members: TulaOrganizationMembers { TulaOrganizationMembers(context: context) }

    /// An organization's domains: claiming one with an emailed code and what a verified one does.
    public var domains: TulaOrganizationDomains { TulaOrganizationDomains(context: context) }

    /// An organization the API answered, checked before it is handed on: a 200 that names no
    /// organization is not one.
    static func checked(_ organization: UserOrganization) throws -> UserOrganization {
        guard !organization.id.isEmpty else {
            throw TulaError.client(TulaClientErrorCode.responseInvalid)
        }
        return organization
    }
}

/// Invitations to an organization (ADR 0065), by email.
///
/// The token an invitation's link carries is a secret: it is sent in a request body and
/// nowhere else, and it is in no error, no log line and no URL the client builds. Read it
/// from the opened address with `TulaInvitationLink.read(_:)`.
///
/// ```swift
/// if let link = TulaInvitationLink.read(openedURL) {
///     let preview = try await tula.organizations.invitations.preview(token: link.token)
///     // …show preview.organizationName, then, once the user signed in as preview.email:
///     let joined = try await tula.organizations.invitations.accept(token: link.token)
/// }
/// ```
public struct TulaOrganizationInvitations: Sendable, TulaRedacted {
    let context: FlowContext

    /// What an invitation's token shows before anyone has signed in: the organization's name,
    /// the role's key and the address invited, to prefill a sign-up. Needs no session.
    ///
    /// - Parameter token: The token from the link's fragment.
    /// - Returns: What the invitation is for.
    /// - Throws: `TulaError`: `organization.invitation_not_found`,
    ///   `organization.invitation_expired`, `organization.invitation_revoked`,
    ///   `organization.invitation_used`.
    public func preview(token: String) async throws -> InvitationPreview {
        try await context.transport.call(
            TulaOperations.previewOrganizationInvitation, body: InvitationTokenRequest(token: token),
            as: InvitationPreview.self)
    }

    /// Join the organization the token invites to, with the invitation's role. Only the
    /// account the invitation was sent to may, and only with a verified address. The session
    /// does not switch to it; `TulaOrganizations.setActive(_:)` does.
    ///
    /// - Parameter token: The token from the link's fragment.
    /// - Returns: The organization joined, with the role and its permission keys.
    /// - Throws: `TulaError`: `organization.invitation_wrong_account`,
    ///   `organization.invitation_email_unverified`, `organization.invitation_role_gone`,
    ///   `organization.member_exists`, and what `preview(token:)` is refused with.
    public func accept(token: String) async throws -> AcceptedInvitation {
        let joined = try await context.session.authorized(
            TulaOperations.acceptOrganizationInvitation, body: InvitationTokenRequest(token: token),
            as: AcceptedInvitation.self)
        guard !joined.id.isEmpty else {
            throw TulaError.client(TulaClientErrorCode.responseInvalid)
        }
        return joined
    }

    /// Turn an invitation down: it is used up and nobody joins.
    ///
    /// - Parameter token: The token from the link's fragment.
    /// - Throws: `TulaError`: as `accept(token:)`, but a deleted role does not matter.
    public func decline(token: String) async throws {
        _ = try await context.session.authorized(
            TulaOperations.declineOrganizationInvitation, body: InvitationTokenRequest(token: token),
            as: NoAnswer.self)
    }

    /// An organization's pending invitations, newest first, for a member whose role holds
    /// `org:sys:invitations:manage`. Never a token. Only the first page.
    ///
    /// - Parameter organizationId: The organization.
    /// - Returns: The first page of pending invitations.
    /// - Throws: `TulaError`: `organization.not_a_member`, `organization.permission_required`,
    ///   `organization.disabled`.
    public func list(organizationId: String) async throws -> OrganizationInvitationList {
        try await context.session.authorized(
            TulaOperations.listMyOrganizationInvitations, params: ["organizationId": organizationId],
            as: OrganizationInvitationList.self)
    }

    /// Email an invitation. The link leads to `redirectURL` (one of the environment's allowed
    /// redirect URLs) with the token in its fragment. The role must be within the permissions
    /// of the inviter's own.
    ///
    /// - Parameters:
    ///   - organizationId: The organization.
    ///   - email: The address to invite.
    ///   - role: The key of the role the invitation gives.
    ///   - redirectURL: Where the emailed link leads: the app's universal link, say.
    /// - Returns: The invitation. The token is only in the email.
    /// - Throws: `TulaError`: `organization.not_a_member`, `organization.permission_required`,
    ///   `organization.role_not_assignable`, `organization.role_unknown`,
    ///   `organization.member_exists`, `organization.invitation_exists`,
    ///   `request.redirect_not_allowed`, `rate_limited`.
    public func invite(organizationId: String, email: String, role: String, redirectURL: String) async throws
        -> OrganizationInvitation
    {
        try await context.session.authorized(
            TulaOperations.inviteToMyOrganization, params: ["organizationId": organizationId],
            body: CreateOrganizationInvitationRequest(email: email, role: role, redirectUrl: redirectURL),
            as: OrganizationInvitation.self)
    }

    /// Withdraw a pending invitation: its link stops working.
    ///
    /// - Parameters:
    ///   - organizationId: The organization.
    ///   - invitationId: The invitation.
    /// - Throws: `TulaError`: `organization.invitation_used`, `organization.invitation_revoked`,
    ///   `organization.invitation_expired` for one that is no longer pending, and what
    ///   `list(organizationId:)` is refused with.
    public func revoke(organizationId: String, invitationId: String) async throws {
        _ = try await context.session.authorized(
            TulaOperations.revokeMyOrganizationInvitation,
            params: ["organizationId": organizationId, "invitationId": invitationId], as: NoAnswer.self)
    }
}
