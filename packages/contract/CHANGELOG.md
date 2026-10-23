# @tula-tech/contract

## 0.3.0

### Minor Changes

- d57ea22: `GET /v1/admin/users/{userId}/organizations` lists the organizations a user belongs to with their role in each (`listUserOrganizations` in `@tula-tech/admin`, `UserMembershipListSchema` in `@tula-tech/contract`). The dashboard's user page, Organizations, Roles and Organization settings screens use it.
- 110ae64: Deleting an organization from the client needs a recent sign-in, and a user can list and answer their own invitations (TULA-131). `DELETE /v1/client/me/organizations/{organizationId}` now answers `auth.step_up_required` (403) for a session that has not proven itself lately; `<OrganizationProfile>` runs the step-up dialog and repeats the delete, and shows no error when the user closes it. New routes `GET /v1/client/me/organization-invitations` (the pending invitations sent to the user's own verified address: an id, the organization's name, the role and the expiry, never the token; paged) and `POST …/{invitationId}/accept` and `…/decline` (the session authorizes it; an id that is not the caller's is `organization.invitation_not_found`). `@tula-tech/contract` gains `MyOrganizationInvitationSchema`, `MyOrganizationInvitationListSchema` and `MyOrganizationInvitationQuerySchema`. `@tula-tech/core` gains `organizations.invitations.mine()`, `.acceptMine(id)` and `.declineMine(id)`. `<OrganizationSwitcher>` lists those invitations when the panel opens, with Accept and Decline; its words are `organizationSwitcher.pendingInvitationsTitle`, `pendingInvitationText`, `pendingInvitationAcceptLabel` and `pendingInvitationDeclineLabel`. `@tula-tech/nextjs` re-exports the components. The member list now looks its users up in one call.
- 568bcec: The organization components (Orgs 07). `@tula-tech/react` and `@tula-tech/nextjs` get `<OrganizationSwitcher>` (the active organization, the user's others, the personal account, suggestions from their email domain, an invitation they opened, and the way to create or manage an organization), `<CreateOrganization>` and `<OrganizationProfile>` (General: rename, leave, delete; Members: roles, removal; Invitations: invite, revoke; Domains: claim, verify with the emailed code, what a verified domain does), each drawn only where the user's role permits, themed, localized (the `organizationSwitcher`, `createOrganization` and `organizationProfile` groups) and accessible. They read the new `organizations` member of the public configuration (whether organizations are on, whether users may create them, whether there is a personal account); a configuration without it means organizations are off. `<TulaProvider>` takes `organizationProfileUrl`, `createOrganizationUrl` and `invitationUrl`, and both packages re-export `readInvitationLink`. `@tula-tech/core` gets the calls the screens make: `organizations.update`, `.remove`, `.leave`, `.roles`, `.members.list`, `.members.changeRole`, `.members.remove` and `.domains.list`, `.start`, `.verify`, `.update`, `.remove`. The API gets the client routes behind them under `/v1/client/me/organizations` (rename, delete, the member list, a member's role and removal, the assignable roles); a change of role or a removal that would leave an organization without a member who can manage members is refused with `organization.last_manager`. `@tula-tech/contract` gets `OrganizationMember`, `AssignableRole`, the `organizations` member of `ClientConfig`, and the Zod-free `@tula-tech/contract/organization-permissions` gains `ORGANIZATION_MANAGE_PERMISSION`, `ORGANIZATION_DELETE_PERMISSION` and `MEMBERSHIPS_READ_PERMISSION`, the keys the screens check.
- 595f5d9: Custom organization roles (ADR 0065). An environment defines roles of its own beside `admin` and `member`: `/v1/admin/organization-roles` (list, define, read, change, remove; `listOrganizationRoles`, `createOrganizationRole`, `getOrganizationRole`, `updateOrganizationRole`, `deleteOrganizationRole` in `@tula-tech/admin`). A role is its key, a name and up to 32 permissions of the form `org:<feature>:<action>` (a custom role may hold the system permissions Tula defines, such as `org:sys:memberships:manage`, and no other `org:sys:*` key); an environment has up to 50. A change is made over the role's version (`ETag` / `If-Match`), and giving a role a permission is recorded as a weakening. The contract gains the role schemas, `@tula-tech/contract/organization-permissions` (the grammar, the limits and `organizationRoleWeakenings`, Zod-free), the error codes `organization.role_exists`, `organization.role_in_use`, `organization.role_built_in` and `organization.role_limit`, and the activity types `organization_role.created`, `.updated` and `.deleted` (their data holds the role's key, a count and the names of the fields, never a name or a permission). `@tula-tech/config` accepts an `organizationRoles` list per environment (left out, roles are not managed; the fingerprint of an existing file is unchanged), and `tula diff` / `tula apply` plan and write them: a role is its key, the permissions are a set, `--prune` removes an unlisted role, a role that gains a permission needs `--allow-weaker` under `--yes`, and every write carries the version the plan read. `@tula-tech/core` gets the new error codes in its generated types.
- 2d098d6: A verification of an organization's domain now lasts a year (ADR 0065, "Lapse"). Past it, the domain matches nobody: no auto-join at sign-up and no suggestion, until a manager claims the domain again and enters the new emailed code. The contract gains `DOMAIN_VERIFICATION_LIFETIME_DAYS` (365), `DOMAIN_REMINDER_DAYS` (30 and 7), `DOMAIN_REVERIFICATION_GRACE_DAYS` (30, for domains verified before this change) and `ORGANIZATION_DOMAIN_STATUSES`; an `OrganizationDomain` gains `status` (`pending`, `verified` or `needs_reverification`) and `expiresAt`, and `codeExpiresAt` is also set while a verified domain is being proven again. The event `organization_domain.verified` gains an optional `reverified: true`. The email kind `organization_domain_expiring` (a notice with the placeholders `appName` and `expiresInDays`) is the reminder sent to an organization's managers 30 and 7 days ahead; it names the organization and a count, never a domain. `@tula-tech/core` and `@tula-tech/admin` only carry the new fields. Sending codes is also fairer: an organization a user created sends 10 a day (30 for one an administrator made), all of one user's organizations share 20 a day, and being told that a name is claimed elsewhere (`organization.domain_taken`) spends one of the organization's ten sends an hour.
- e15bd1c: Verified domains for organizations (Orgs 05). An organization claims a domain by entering a 6-digit code emailed to an address on it, and a user whose verified email address is exactly on a verified domain is offered the organization (`suggest`) or joined to it at sign-up (`auto_join`). `@tula-tech/core` gets `client.organizations.suggestions()` and `.join(organizationId)`; `@tula-tech/admin` gets `/v1/admin/organizations/{id}/domains` (list, claim, verify, change the mode, remove). The contract gains the schemas, the Zod-free entry point `@tula-tech/contract/organization-domain-rules` (the domain grammar, `domainRefusal`, `isPublicEmailDomain`, `domainOfAddress` and the documented list of public mail domains), the permission `org:sys:domains:manage`, the email kind `organization_domain_verification`, the activity types `organization_domain.claimed`, `.verified`, `.updated` and `.removed`, an optional `via` on `organization_membership.added`, and the error codes `organization.domain_public`, `organization.domain_taken`, `organization.domain_address_mismatch`, `organization.domain_limit` and `organization.suggestion_unavailable`.
- ef6030d: Organizations, first step (ADR 0065): the `organizations` environment settings (off by default), the schemas, role keys and permission grammar of organizations and memberships, six new activity types, and five `organization.*` error codes. `@tula-tech/admin` gains the typed admin routes for organizations and their memberships. `@tula-tech/config` leaves the section out of an environment's fingerprint while it is the default. `@tula-tech/core` carries the new error codes in its generated types.
- 2ee73d3: A signed-in user's own organizations and the active organization. `@tula-tech/core` gets `client.organizations.list()`, `.create(input)` and `.setActive(id | null)`, and the signed-in state gains `organizationId`, read from the access token's `org_id`. The access token carries `org_id`, `org_role` and `org_perms` while an organization is active (reserved claim names, a cap of their own, none of them when over it); a refresh re-reads the membership, so a removal or a demotion takes effect at the next refresh and the session stays. The contract gains the schemas for `GET`/`POST /v1/client/me/organizations` and `PUT /v1/client/me/organizations/active`, `readOrganizationClaims` and the error codes `organization.not_a_member`, `organization.creation_disabled`, `organization.limit_reached` and `organization.personal_account_disabled`. `@tula-tech/react` and `@tula-tech/nextjs` only follow the new field of the auth state.
- 24288d6: Invitations to an organization by email (ADR 0065, Orgs 04). `@tula-tech/core` gets `client.organizations.invitations` (`invite`, `list`, `revoke`, `preview`, `accept`, `decline`) and `readInvitationLink(url)`, which reads the token from the `#tula_invitation=…` fragment of the emailed link and returns the URL without it. Only the account the invitation was sent to, with that address verified, can accept or decline it; the token is single use, valid for 7 days, stored only as a hash and never in a response. `@tula-tech/admin` gains the admin routes (`GET`/`POST /v1/admin/organizations/{id}/invitations`, `DELETE …/{invitationId}`). The contract gains the invitation schemas, the email kind `organization_invitation` (with the template placeholder `expiresInDays`; there is none for the organization's name or the address), the permission constant `INVITATIONS_MANAGE_PERMISSION`, four activity types (`organization_invitation.created`, `.accepted`, `.declined`, `.revoked`) and ten error codes (`organization.permission_required`, `.role_not_assignable`, `.invitation_exists`, `.invitation_not_found`, `.invitation_expired`, `.invitation_revoked`, `.invitation_used`, `.invitation_wrong_account`, `.invitation_email_unverified`, `.invitation_role_gone`). `@tula-tech/react`, `@tula-tech/nextjs` and `@tula-tech/expo` only carry the new types and error codes.
- 358f646: The active organization and `has()` in Next.js and React. `@tula-tech/nextjs`: `auth()` returns `orgId`, `orgRole`, `orgPermissions` and `has({ permission } | { role })` (exact match, no wildcard, `false` with no active organization); `tulaMiddleware` takes `access` rules (a route matcher and the permission or role it needs) and `forbiddenUrl`, so a route group can be refused before it renders, with a 403 for an API route; the three organization claims reach `auth()` only as a set that passed the contract's checks, from a verified token, the stateful session's answer and the sealed `x-tula-auth` header alike. A token that carries a maximal role (up to 32 permissions of 100 characters) outgrows one browser cookie (measured: 5.3 kB against a 4,096-byte limit), so the access token is now stored in up to two cookies, `tula_at` and `tula_at_1`, read back in order and verified as one token; a token too large for two is not stored and the session lives on its refresh cookie. `@tula-tech/react`, and `@tula-tech/nextjs` which re-exports them: `useOrganization()` (the active organization, the role and permissions of the session, and `has()`) and `useOrganizationList()` (the user's organizations, `setActive()` and `create()`), keyed to the session so that a result for an earlier session is never shown. `@tula-tech/contract`: `readOrganizationClaims` now checks the organization id, the role key and every permission against the permission grammar, and `hasOrganizationAccess` and the `OrganizationCheck` type are the one `has()` rule every package shares.
- 9c2bafb: Paging and search over organizations. `client.organizations.list({ page, size })` in `@tula-tech/core` reads any page of the signed-in user's organizations (the generated client types now carry the documented `page` and `size` query of `GET /v1/client/me/organizations`, and `meta` says how many pages there are); a call with no argument reads the first page as before. `GET /v1/admin/organizations` takes `q`, a name or slug prefix of up to 100 characters matched ignoring case (`%` and `_` match themselves), counted and paged as a match; `@tula-tech/admin`'s `listOrganizations` types it. The contract gains `OrganizationSearchQuerySchema`.
- ad8b8e2: `tula import` reports the users of a retried batch correctly. When a batch got no answer and was sent again, the users the first attempt had made were counted as skipped and a Clerk member was found by address. `POST /v1/admin/users/import` now answers a skipped `email_exists` row with the existing user's `id` and `sameExternalId` (whether their stored external id is the row's); `tula import` counts such a row in a retried batch as created and pairs Clerk members by the recorded id. The answer is additive.
- 721ed9e: User import takes two more password hash formats. `pbkdf2_sha256` (Django's `pbkdf2_sha256$…`, PHC and passlib `$pbkdf2-sha256$…` strings, or a base64 derived key with `params` `{ iterations, salt }`; 100,000 to 2,000,000 iterations) and `firebase_scrypt` (Firebase's `passwordHash`, with the user's `salt` in `params`). The Firebase project's hash parameters go once per call in the new `firebaseScrypt` field of `ImportUsersRequest` (`FirebaseScryptParamsSchema`: `signerKey`, `saltSeparator`, `rounds`, `memCost`); the server seals them and never returns them. The `user.imported` event's `passwordAlgorithm` also takes `pbkdf2_sha256` and `firebase_scrypt`. The first sign-in replaces either hash with argon2id.
- ece0a87: Bulk user import. `POST /v1/admin/users/import` (`importUsers` in `@tula-tech/admin`) takes up to 500 users per call, each with an email, `emailVerified`, an optional name, metadata and external id, and an optional password hash in the tagged form `{ algorithm, hash, params? }` (`bcrypt`, `argon2id`, `argon2i`). The answer reports every row as `created`, `skipped` (the address exists, or repeats in the call) or `refused` with a contract error code. The contract gains `ImportUsersRequestSchema`, `ImportUsersResultSchema` and the row schemas, `MAX_IMPORT_ROWS`, the error codes `import.unsupported_algorithm`, `import.hash_malformed`, `import.hash_parameters_too_weak`, `import.hash_parameters_too_costly`, and the activity type `user.imported` (its data holds booleans and the closed `passwordAlgorithm` only), so an import does not fire `user.created`. `@tula-tech/core` gets the new error codes and event type in its generated types.

### Patch Changes

- 048f982: Deleting a user who is the only member holding `org:sys:memberships:manage` of an organization is refused with the new `user.last_organization_manager` error code (409, `params.organizationIds` and `params.count`), as removing or demoting that member already was. Add another manager or delete the organization first. `@tula-tech/admin` and `@tula-tech/core` carry the new error code in their generated types.

## 0.2.0

### Minor Changes

- f56f6b5: A deliberate change of the default theme: Tula's own "ink and paper" replaces the purple one. Warm neutrals (ink `#1a1a18`, paper `#f1efe8`), a primary button that is ink in light and paper in dark, one restrained violet kept for links and the focus ring, 10px and 6px radii, and ink surfaces with paper text in dark. Token names are unchanged and an app that sets `primary` (or any token) keeps its value; only the defaults moved, on web, Swift and Kotlin alike, and every default pair still passes WCAG AA in both schemes. `@tula-tech/react`'s stylesheet is refined (spacing and type rhythm, a crisp focus ring with a soft halo, quiet elevation, entrances and press feedback that stop under `prefers-reduced-motion`, a card that keeps a sensible width from a 320px phone to an ultrawide screen); class names and the public API are unchanged.

## 0.1.1

No changes in this release.

## 0.1.0

### Minor Changes

- a036657: How a user signs in, for a server or the dashboard.
  
  - `@tula-tech/contract`: `UserAuthenticationSchema` / `UserAuthentication`, the answer of
    `GET /v1/admin/users/{userId}/authentication`: whether the account has a password and a
    verified address, its linked provider accounts, its confirmed second factors with the number
    of unused backup codes, its passkeys, and `canSignInWithoutPasskeys` (whether a reset of
    two-step verification would leave the user a way in). Never a secret or a credential id.
  - `@tula-tech/admin`: the admin client gains `getUserAuthentication`.
- a34eb0e: Agent keys and proposals ([ADR 0053](../docs/adr/0053-proposals.md)): the key kind `agent`
  (`tula_ak_…`, `AGENT_KEY_PREFIX`), the proposal's schemas and closed lists
  (`PROPOSAL_OPERATIONS`, `PROPOSAL_OPERATION_TARGETS`, `PROPOSAL_STATUSES`,
  `PROPOSAL_APPROVAL_REFUSALS`, `PROPOSAL_FAILURE_REASONS`, `PROPOSAL_EXPIRY_REASONS`,
  `PROPOSAL_APPROVER_TYPES`, `proposalSummary`), the audit
  target `proposal`, and four event types (`proposal.created`, `proposal.approved`,
  `proposal.executed`, `proposal.failed`). `user.banned` may carry `proposalId` and
  `approvedBy` when an agent's approved proposal carried it out, both or neither. A
  proposal whose agent key was revoked reads as `expired` with `expiryReason:
  'agent_key_revoked'`. No new error code.
- 1c76ead: App-link and custom-scheme redirects ([docs/native-apps.md](../docs/native-apps.md),
  ADR 0044).
  
  - `@tula-tech/contract`: a new Zod-free entry point, `@tula-tech/contract/redirect-url`
    (`redirectUrlKind`, `isRedirectUrl`, `isCustomSchemeRedirectUrl`,
    `REDIRECT_SCHEMES_NEVER_CUSTOM`, `OAUTH_PROVIDERS_WITH_PKCE`,
    `OAUTH_PROVIDERS_WITHOUT_PKCE`, `bindsCodeWithPkce`, `customSchemeRedirectRefusal`).
    `urls.allowedRedirectUrls` accepts a custom scheme in reverse-domain form
    (`com.example.app:/oauth`); listing one is a weakening (`urls.allowedRedirectUrls`). A
    web entry must now start with `https://` or `http://` as written. A native app has
    `appLinkPaths` (`isAppLinkPath`, `normalizeAppLinkPaths`, `MAX_APP_LINK_PATHS`); the two
    file builders serve `applinks` and `handle_all_urls` for an app that has some;
    `nativeAppWeakenings` reports a gained path; the `native_app.*` events carry a count of
    paths. `request.redirect_not_allowed` may carry `params.reason`.
  - `@tula-tech/admin`: the generated types have `appLinkPaths` on a native app and on its create
    and update bodies.
  - `@tula-tech/config`: `appLinkPaths` on a `nativeApps` entry.
  - `@tula-tech/cli`: `tula diff` and `tula apply` plan `appLinkPaths` as a set. Left out of an
    entry the paths are unmanaged (kept, and the diff says how many the server has); written,
    also as `[]`, the list is the whole set. A gained path is `nativeApps.<platform>/<identifier>.appLinkPaths` and needs
    `--allow-weaker` under `--yes`, as does a custom-scheme redirect URL the file adds.
- 55115bc: `tula approve` shows a session with whose it is and whether it is still live, and says
  when an approval found nothing left to change.
  
  - **A session in the question.** For `end_session` the command reads the session and its
    user with the operator's key and prints the owner's id, address and name, the kind of
    client, when the session was signed in and "live now" or "already ended". A read that
    fails is said in fixed words beside the id ("could not be read", "no such session now")
    and is never guessed. The user agent and the IP address are not printed.
  - **`GET /v1/admin/sessions/{sessionId}`** (`getSession` in `@tula-tech/admin`) reads one
    session of an environment by its id: the session list's shape with `userId` and `active`
    (`AdminSessionSchema` / `AdminSession` in `@tula-tech/contract`). An unknown id and another
    environment's are the same 404.
  - **`changed` on an approval's answer.** `ProposalSchema` gains an optional boolean,
    present only in the answer to the approval that carried the proposal out, and
    `proposal.executed` gains the same field: `false` when the operation ran and found the
    target already so (the session had ended, the user was not banned, the provider was
    off). `tula approve` then prints "carried out; … so nothing changed" in place of the
    sentence that describes the change, and still exits 0. A later read of the proposal does
    not carry the field.
  
  A stored proposal whose operation the server has no branch for is now `failed` with
  `error` when it is approved; it was recorded as carried out.
- 0a5e496: `audit.retentionDays` takes effect: the server's retention job now deletes an environment's
  audit entries older than the period, permanently. The schema and its default (`null`: keep
  entries for ever) are unchanged.
  
  **Check the setting in every environment before you upgrade the server.** Until now the
  setting was stored and did nothing. An environment that already holds a number starts
  deleting its older audit entries, for good, with the first retention run of the new version
  (migration `0017`; runs happen at start-up and every ten minutes, and a large backlog takes
  several). `null`, the default, keeps everything, as before. Saving a period, or a shorter
  one, deletes the older entries for good, starting with the next retention run: export first
  (`GET /v1/admin/audit-logs`).
  
  `settingsWeakenings` now lists `audit.retentionDays` when a period is set where there was
  none or is made shorter (not when it is lengthened or removed). So the server's audit entry
  for such a change carries `weakened: true`, `tula diff` warns about it and
  `tula apply --yes` refuses it without `--allow-weaker`.
- 9166270: Settings as code (ADR 0030): `tula.config.ts`, `tula diff` and `tula apply`.
  
  - `@tula-tech/admin` (new): a typed client for every `/v1/admin/*` operation, generated from the
    OpenAPI contract. `createAdminClient({ baseUrl, secretKey })`, one `call(operationId, input)`
    function, one error class (`TulaAdminError`) carrying the contract's code, field errors and
    `Retry-After`. Server-side only: it refuses a publishable key, refuses to be created in a
    browser, and its `browser` export condition resolves to a module that throws. A plain
    `http:` `baseUrl` is refused unless the host is this machine or `allowInsecureHttp` is set,
    and a path parameter that is not a single path segment is refused before the request
    (`client.invalid_param`).
  - `@tula-tech/config` (new): `defineConfig()` for `tula.config.ts`, validated with the contract's
    schemas. One file describes several environments: the settings document and the OAuth
    providers of each. A provider's secret is `env('NAME')` and nothing else; a literal is a type
    error and a load error. `loadConfig()`, `selectEnvironment()`, `hashEnvironmentConfig()`.
  - `@tula-tech/cli` (new): the `tula` executable. `tula diff` prints what would change and exits 2
    when something would; `tula apply` asks, then replaces the settings under `If-Match` and
    creates, updates or (with `--prune`) deletes providers, in an order the server accepts.
    `apply` refuses a plan that would reset settings this version does not know
    (`--allow-unknown`) and, with `--yes`, one that weakens security (`--allow-weaker`).
    `--insecure-http` allows a plain http API URL that is not localhost. A key file readable by
    others is warned about, and `--secret-key-file -` is refused at a terminal.
  - `@tula-tech/contract`: `settingsWeakenings()` (the one definition of "weakened", now shared by
    the server's audit entry and the CLI's warning), `SettingsManagedBySchema`, and the headers
    `x-tula-managed-by` / `x-tula-config-hash` with which a replace records the tool and config
    that manage an environment's settings. `GET /v1/admin/settings` answers `managedBy`
    (additive; `null` when nobody manages them), with `drifted` once they are changed around
    the file.
- d013691: The server side of the dashboard (ADR 0032).
  
  - `@tula-tech/contract`: the dashboard's header names (`DASHBOARD_HEADER`, `DASHBOARD_HEADER_VALUE`,
    `ENVIRONMENT_HEADER`) and cookie name (`DASHBOARD_SESSION_COOKIE`) in `@tula-tech/contract/headers`;
    the `instance_admin` audit actor; `INSTANCE_ACTIVITY_TYPES` and `INSTANCE_AUDIT_TARGET_TYPES`
    for the instance audit log.
  - `@tula-tech/admin`: the admin client gains `listUserSessions` and `revokeUserSession`, and the
    audit log's `actorType`, `from` and `to`; the instance client gains workspaces, projects,
    environments and the instance audit log. Both still take the secret key and the instance
    admin token: the dashboard's cookie session is a browser's and is not part of this package.
- f3216d0: A device-binding option on a session profile
  ([docs/device-binding.md](../docs/device-binding.md), ADR 0043): `deviceBinding` is `none`,
  `optional` or `required`. Under `required` a native app that starts a sign-in without a
  device key is refused; under `none` one that brings a key is. Browsers are not affected by
  any value. The default is `none` for the `web` profile and `optional` for every other, which
  is how sessions behaved before. A change applies to new sign-ins only.
  
  - `@tula-tech/contract`: `DeviceBindingPolicySchema`, `DeviceBindingPolicy`,
    `defaultDeviceBinding(name)` and `WebSessionProfileSchema`; `deviceBinding` on a session
    profile; the error code `device.binding_required` (400); `deviceBound` on `SessionSchema`
    (the session lists); and `settingsWeakenings` lists
    `sessions.profiles.<name>.deviceBinding` when a profile asks less for a key.
  - `@tula-tech/core`: the message of `device.binding_required`, which never ends the local
    session; `session.list()` entries carry `deviceBound`.
  - `@tula-tech/react`: `<UserProfile>` marks a session that is bound to a device key, in words
    (`userProfile.deviceBound`).
  - `@tula-tech/admin`: the generated types carry the option, the code and `deviceBound`.
  - `@tula-tech/config`: `deviceBinding` on a profile in `tula.config.ts`. Left out, it is the
    profile's default and is not part of the file's hash.
  - `@tula-tech/cli`: `tula diff` shows the option and flags a profile that asks less as
    `! weakens security`; `tula apply --yes` refuses that without `--allow-weaker`.
  - `@tula-tech/mcp`: `list_user_sessions` returns `deviceBound` (a yes or no, never a key) and
    `get_settings` a profile's `deviceBinding`.
- 75b1b36: Device binding on refresh ([docs/device-binding.md](../docs/device-binding.md), ADR 0043): a
  session of a client that is not a browser can be bound, when its sign-in starts, to a key
  the client holds. Every refresh of such a session then needs a DPoP proof (RFC 9449) signed
  by that key. A refresh without one is refused and changes nothing: the session is not ended
  and no token is rotated. A session that is not bound behaves as before.
  
  - `@tula-tech/contract`: a new Zod-free entry point, `@tula-tech/contract/device-binding`
    (`DPOP_HEADER`, `DPOP_NONCE_HEADER`, `DPOP_PROOF_TYPE`, `DPOP_ALGORITHMS`,
    `MAX_DPOP_PROOF_LENGTH`, `DeviceKey`, `DevicePublicJwk`, `createDpopProof`,
    `jwkThumbprint`, `isDevicePublicJwk`, `isKeyThumbprint`, `generateSoftwareDeviceKey`);
    the error codes `device.proof_invalid` (401), `device.nonce_required` (400) and
    `device.binding_not_supported` (400); the optional `cnf: { jkt }` on
    `AccessTokenClaimsSchema`; the event type `session.refresh_proof_refused`; and the
    optional `deviceBound` on `session.created`.
  - `@tula-tech/core`: `createTulaClient({ deviceKey })` binds the client's sessions. The client
    sends a proof when it starts a sign-up, a sign-in or a reset and at every refresh, keeps
    the server's nonce and repeats a request once when asked for a fresh one, inside the same
    deadline. A refresh refused for its proof does not sign the client out. `DeviceKey`,
    `DevicePublicJwk` and `generateSoftwareDeviceKey` are exported; a key whose `sign` throws
    is the client-side code `device.key_failed`. A `web` client cannot be given a key.
  - `@tula-tech/admin`: the generated types carry the new event type, `deviceBound` and `cnf`.
- 9d2a864: An email address for an account that has none, and the accounts a provider's removal locks
  out (ADR 0059).
  
  - The error code `email.already_set` (409): the account already has an address.
  - The activity `user.email_added` (`method`: `self` or `admin`; `verified`), with its
    schema and fixture.
  - Two email kinds, `email_in_use` (what an address that already has an account is sent
    instead of a code) and `email_added` (the notice to the address that was added).
  - `OAuthProviderDependentsSchema` (`{ provider, accounts, more }`) and
    `DEPENDENT_ACCOUNTS_SCAN_LIMIT`: how many accounts could not sign in without a provider.
    A number and a boolean, never who.
  - `oauthProviderWeakenings` now also takes `enabled` and the counted `dependents`, and
    names `enabled` when a provider that accounts depend on is switched off or removed.
    `oauth_provider.updated` and `.deleted` gain `dependentAccounts` and
    `dependentAccountsIncomplete`.
  - The OpenAPI document gains `requestEmailAddressCode`, `verifyEmailAddress`,
    `setUserEmail` and `getOAuthProviderDependents`.
- 4e15bd1: Signing in by email: a 6-digit code, a link that works only in the browser that asked for it,
  and sign-up without a password.
  
  - `@tula-tech/contract`: `EnvironmentSettings` gains `signIn.methods.emailCode` and
    `signIn.methods.emailLink` (both off by default; `emailLink` needs `emailCode`) and
    `signUp.password` (`required` by default, or `optional`, which needs `emailCode`).
    `ClientConfig` gains `signUp.password`. The `needs_first_factor` step gains an optional
    `prepared: { strategy, destination }`, `FlowAttempt` an optional `linkBinding`, and
    `SignUpRequest.password` becomes optional. New request shapes `FirstFactorPrepareRequest`,
    `FirstFactorAttemptRequest`, `EmailLinkRequest` and `EmailLinkResult`; new error codes
    `verification.different_browser` (409) and `request.redirect_not_allowed` (400); and
    `EMAIL_LINK_TOKEN_PARAM` / `EMAIL_LINK_ATTEMPT_PARAM` in the Zod-free `/headers` entry point.
    All additive: documents saved earlier read with the new methods off.
  - `@tula-tech/core`: sign-in flows gain `prepareFirstFactor`, `attemptFirstFactor`,
    `waitForEmailLink` (polling with cancellation, nudged across tabs, obeys `Retry-After`) and
    `discard`; `signIn.canUseEmailLink()` and `signIn.handleEmailLink()` for the page a link
    leads to; `signUp.start` takes an optional password. An emailed link's binding is kept in
    `localStorage` (it is not a token; see the README's security notes), and the link's token is
    read from the URL fragment and removed from the address before anything is sent. A link's
    page must be on the origin that asks: another origin is refused locally with the new client
    code `link.cross_origin`.
  - `@tula-tech/react`: `<SignIn>` draws the emailed code and link and lets the user switch between
    the methods on offer (new prop `emailLinkUrl`, also on the provider); `<SignUp>` marks the
    password optional where the environment says so; new `<EmailLinkCallback>` and
    `useEmailLinkCallback()` for the landing page; `useSignIn` gains the matching actions. New
    element names `alternatives` and `waiting`, and new localization keys under `signIn`,
    `signUp` and `emailLink`.
- bce497c: Email templates: an environment's own subject and wording for each email
  (`emails.templates` in the settings, keyed by the kind of message).
  
  - `@tula-tech/contract` gains the kinds, the placeholders and the rules of each kind
    (`EMAIL_TEMPLATE_KINDS`, `EMAIL_TEMPLATE_PLACEHOLDERS`, `EMAIL_TEMPLATE_RULES`), the
    checks (`emailTemplateProblems`, `readsAsLink`, `parseEmailTemplate`) and the schemas
    (`EmailTemplateSchema`, `EmailTemplatesSchema`, `EmailSettingsSchema`). The settings
    document has a new section, `emails`, with no template by default: an environment that
    has saved nothing sends the email it always did.
  - A template is text with `{{name}}` placeholders. One that lacks the code or the link its
    message needs is refused when saved, and so is one of any kind that holds something that
    reads as a link, an address or a domain name (`EMAIL_LINK_SCHEMES`): the only link in an
    email is the server's own. A security notice can be given no code and no link, its
    subject cannot start with a digit (`EMAIL_TEMPLATE_DIGIT_PLACEHOLDERS`), and it always ends
    with the server's own facts and its own sentence of what to do if the reader did not do
    what the notice reports. A text-direction control, a private-use or unassigned character
    and a lone surrogate are refused (`hidden_character`), never stripped.
  - `app.name` is refused, when it is set, if it holds a text-direction control, a
    private-use or unassigned character or half a surrogate pair. A name already stored is
    still read.
  - `@tula-tech/config` accepts `settings.emails.templates`, validated when the file is loaded. A
    file with no template hashes as before.
  - `tula diff` shows a template field by field (`emails.templates.<kind>.subject`), and
    `tula apply` removes the template of a kind the file leaves out, as for every setting.
  - `@tula-tech/admin`'s settings types include the section.
- ac05f56: Apple's and Google's own sign-in sheets, a session bound to a device key, and a config
  plugin in an Expo app ([docs/expo.md](../docs/expo.md), ADR 0052). **None of it has been
  run on a device, a simulator or in Expo Go**: no provider's sheet was shown, no key was
  made in a phone's secure hardware, none of the three native modules was installed, and
  Expo never ran the plugin. All of it is tested with stand-ins
  (`docs/plans/phase-2-unverified.md`).
  
  `@tula-tech/contract`:
  
  - `DeviceKey.proofId?()` (`@tula-tech/contract/device-binding`): a key may bring the id of its
    proofs, for a runtime with no `crypto.getRandomValues`. Left out, nothing changes.
  
  `@tula-tech/core`:
  
  - `Environment.deviceKey` (`DeviceKeySource`): for a runtime that finds its key by a call
    that takes time, the transport asks for the key before each request a key proves, and
    `undefined` means "send this one without a proof". A source that throws is
    `device.key_failed`. Finding the key and signing with it are inside the call's
    deadline: a key store that never answers is `network.timeout`, with nothing sent. `createTulaClient({ deviceKey })` is unchanged.
  
  `@tula-tech/expo`:
  
  - `createTulaExpoClient({ apple, google, deviceKeys })`, all optional. `@tula-tech/expo/apple`
    (`appleSheet`, over `expo-apple-authentication`), `@tula-tech/expo/google` (`googleSheet(ids)`,
    over `react-native-nitro-google-signin` 2.3 or later; a development build, and the
    import throws in Expo Go) and `@tula-tech/expo/device-key` (`hardwareDeviceKeys`, over
    `@pagopa/io-react-native-crypto` 1.2.5 or later; a development build) are adapters, each
    an entry point with an optional peer.
  - `useSignIn().withIdToken({ provider })` and, outside a component,
    `signInWithIdToken(client, { provider })`: the sheet is shown between the two steps of
    `@tula-tech/core`'s `signIn.withIdToken`. For Apple the package hands the sheet the SHA-256 of
    the server's nonce and passes the sheet's name on beside the token. A dismissed sheet
    sets `dismissed` and never `error`; one sheet of any kind at a time (`flow.busy`).
  - `useIdTokenProviders()`: `{ google, apple }`, `false` until the sheet is known to be
    there, so a control is hidden where the native module or the sign-in is missing.
  - With `deviceKeys`, a session is bound to a key the device keeps and every refresh
    carries a proof. A stored session whose key is gone (a new key, another key, no key
    store) is dropped when the app starts, with no request: the user signs in again. A
    token is marked as bound only when the server's answer says it is, and a key is made
    only after the key store said "not found" twice. A key
    store that cannot be reached is `storage.failed` and the session is kept. `deviceKey`
    is still refused as an option: an app hands over a key store (`DeviceKeyStore`).
  - `@tula-tech/expo/plugin`: `withTula(config, props)` adds Associated Domains, app-link intent
    filters, the Sign in with Apple entitlement and Google's client ids to an Expo
    configuration, and `reversedGoogleClientId(iosClientId)`. It writes no native file.
  - `flowScreen(step, ways)`: a provider counts as a way for a client with a browser or
    with that provider's sheet.
- f686a47: First prerelease of the contract and the headless client.
  
  - `@tula-tech/contract`: the API's schemas, flow protocol, error codes, token claims and password
    policy, with Zod-free entry points (`/error-codes`, `/headers`, `/password-rules`) for clients.
  - `@tula-tech/core`: `createTulaClient` with server-driven sign-up, sign-in and password-reset flows,
    session management with single-flight token refresh (its own 8-second timeout and one immediate
    retry when no answer comes, both inside the server's reuse grace period), validated responses, and typed errors.
- 48d9bea: Hooks: an environment can register an endpoint the server asks before a sign-up creates an
  account (`/v1/admin/hooks`, [docs/hooks.md](../docs/hooks.md)). The contract gains the hook's
  schemas, its question (`HOOK_QUESTION_SCHEMAS`, `HOOK_QUESTION_FIXTURES`) and answer
  (`HookAnswerSchema`), `hookWeakenings`, the event types `hook.created`, `hook.updated` and
  `hook.deleted`, the optional `hookBypassed` on `user.created`, and the error codes
  `hook.denied`, `hook.unavailable` and `hook.url_not_allowed`. `@tula-tech/admin` gains
  `verifyHook`, `TulaHookQuestion` and `TulaHookAnswer`, and the typed operations
  `createHook`, `listHooks`, `getHook`, `updateHook` and `deleteHook`. `@tula-tech/core` carries the
  three new codes and their messages: 50 bytes gzipped, and its bundle budget moved from 15,500
  to 15,550 bytes with them.
- 2dce8af: A hook's read answer says what its recent calls came to
  ([ADR 0035](../docs/adr/0035-hooks.md#2026-10-12-recent-outcomes-tula-67),
  [docs/hooks.md](../docs/hooks.md)). The server counts every call of a hook, by the hour,
  as `allowed`, `denied`, `failed` or `timed_out`, and `GET /v1/admin/hooks` (and every other
  answer that carries a hook) has `recentOutcomes`: the four counts of the current hour and
  the 23 before it, where the window starts, when the hook was last asked and what that call
  came to. A count is written after the sign-in was answered and is not waited for, so it
  may land a moment later, and a server killed hard loses the ones on their way.
  `lastCallAt` is the time of the latest sign-in or sign-up that asked the hook, to the
  millisecond, and is answered by the admin API only. Counts
  only: no call is kept by itself, and nothing of a question or of an answer but which of
  the four it was. `lastFailedAt` and `lastFailureReason` are unchanged.
  
  **`@tula-tech/contract`**: `HOOK_OUTCOMES`, `HookOutcome`, `HOOK_OUTCOME_WINDOW_HOURS`,
  `hookFailureOutcome(reason)`, `hookLastCallFailed(lastOutcome)` (whether the most recent
  call failed or timed out; it does not say a hook is failing now, the call may be up to a
  day old), `HookRecentOutcomesSchema`, and the
  required `recentOutcomes` of `HookSchema`.
  
  **`@tula-tech/admin`**: the generated type of a hook has `recentOutcomes`. A server from before
  this change does not send it.
  
  The dashboard's Hooks screen shows the counts and what the most recent call came to, with
  when it was ("Last call failed", never "failing now"). `@tula-tech/cli` and `@tula-tech/mcp` are unchanged: neither reads the field.
- c760b08: Hooks before a session and before a token ([docs/hooks.md](../docs/hooks.md)). An
  environment can register two more hooks: `before_session`, asked once every factor of a
  sign-in is proven and able to refuse it, and `before_token`, which answers with claims that
  are issued under `ext` of the session's access tokens. The contract gains the two points
  (`HOOK_POINTS`), their questions (`HookBeforeSessionDataSchema`,
  `HookBeforeTokenDataSchema`, in `HOOK_QUESTION_SCHEMAS` and `HOOK_QUESTION_FIXTURES`), the
  claims answer (`HookClaimsAnswerSchema`, `readHookClaimsAnswer`), the failure reasons
  `claims_invalid` and `claims_too_large`, `checkCustomClaims` in `@tula-tech/contract/custom-claims`,
  and the optional `hookBypassed` and `claimsHookBypassed` on `session.created` and
  `claimsHookBypassed` on `session.stepped_up`. `@tula-tech/admin`'s `verifyHook` accepts the two new
  questions, `TulaHookQuestion` is a union to narrow on `type`, and `TulaHookClaimsAnswer` is
  the answer of a claims hook. No error code is added: `hook.denied` and `hook.unavailable`
  now answer a refused sign-in too, and their messages no longer say "sign-up" ("This was not
  allowed.", "This is unavailable right now. Try again later."), which is the whole change to
  `@tula-tech/core`.
- 0de4f8d: JWT templates: an environment can add custom claims to its sessions
  ([docs/jwt-templates.md](../docs/jwt-templates.md), ADR 0036). A template is a named set of
  claims under `sessions.jwtTemplates`, each read from a closed list of sources (the user's
  address, whether it is verified, when the account and the session began, the client kind) or a
  constant; a session profile names the one it uses (`jwtTemplate`). The claims are issued under
  the one claim `ext` of the access token, and in what the server answers for a stateful
  session. A token of a profile without a template is unchanged.
  
  - `@tula-tech/contract`: `JwtTemplateSchema`, `JwtTemplateClaimSchema`, `JWT_TEMPLATE_SOURCES`,
    `jwtTemplateMaxBytes`, `readStoredJwtTemplate`, `jwtTemplateOfProfile`,
    `isSessionProfileName` (the one rule for a profile's and a template's name), the optional `ext`
    on `AccessTokenClaimsSchema`, and `settingsWeakenings` reports
    `sessions.profiles.<name>.jwtTemplate` when a profile's sessions lose a claim or get a
    redefined one. A new Zod-free entry point, `@tula-tech/contract/custom-claims`:
    `CUSTOM_CLAIMS_CLAIM`, `RESERVED_CLAIM_NAMES`, the caps (`MAX_CUSTOM_CLAIMS_BYTES` and
    others), `isCustomClaimKey`, `isCustomClaimValue`, `customClaimsBytes` and
    `readCustomClaims`.
  - `@tula-tech/nextjs`: `auth()` returns `customClaims` (a read-only record of `unknown` values;
    empty when signed in with none, `null` when signed out), for token and stateful sessions
    alike, and `SessionClaims` gains the optional `ext`. An `ext` that is not what Tula issues
    is treated as absent.
  - `@tula-tech/admin`: the settings types carry `jwtTemplates` and a profile's `jwtTemplate`.
  - `@tula-tech/config`: both are part of `settings`. An environment without templates keeps the
    fingerprint it had.
  - `@tula-tech/cli`: `tula diff` compares templates by name and their claims by key, shows a changed
    claim as one value, and reports a profile whose sessions would lose claims as weaker, which
    `tula apply --yes` refuses without `--allow-weaker`.
- ea7f074: Two-step verification: an authenticator app (TOTP), backup codes, step-up and a policy per
  environment.
  
  - `@tula-tech/contract`: new flow step `needs_factor_enrolment { methods }` and request shape
    `SecondFactorRequest`; `FlowAttempt` gains the optional `backupCodes` and
    `backupCodesRemaining`. New `Factors`, `TotpEnrolment`, `TotpConfirmRequest`, `BackupCodes`,
    `StepUpRequest` and `StepUpMethod`. Access-token claims gain `auth_time` (when the user last
    proved a factor for the session; refreshing does not move it) and `amr` (what they proved:
    a set, whose order is not part of the contract), with `AUTHENTICATION_METHODS` and
    `STEP_UP_MAX_AGE_SECONDS`. `EnvironmentSettings` gains `mfa.policy` (`off`, `optional` by
    default, `required`) and `notifications.mfaChanged`; `ClientConfig` gains the optional
    `mfa.policy`. New error codes `mfa.invalid_code`, `mfa.already_enabled`, `mfa.not_enabled`,
    `mfa.enrolment_expired`, `mfa.not_available`, `mfa.required_by_policy` and
    `auth.step_up_required` (its `params.methods` is a comma-separated list). New activity types
    `user.mfa_enabled`, `user.mfa_disabled`, `user.backup_codes_regenerated`,
    `user.backup_code_used` and `session.stepped_up`. All additive.
  - `@tula-tech/react`: `<SignIn>` (also after a password reset) and `<SignUp>` draw the second
    factor (authenticator code or a backup code) and, where the environment requires it, the
    enrolment inside the flow. `<UserProfile>` gains a "Two-step verification" section: turn on
    with a QR code and the setup key, backup codes with copy, download and an explicit
    confirmation, new codes, turn off. New hook `useStepUp()` runs a sensitive action and, when
    the API asks, opens the provider's step-up dialog and retries. `useSignIn`, `useSignUp` and
    `useResetPassword` gain `submitSecondFactor`, `startTotpEnrolment` and
    `confirmTotpEnrolment`. New element names (`modal`, `qrCode`, `secret`, `backupCodes`,
    `backupCode`, `checkbox`) and strings (`mfa`, `stepUp`). The QR code is drawn by the package
    itself, in a chunk loaded on demand; the build now emits that chunk beside `index.js`.
- 784639a: Native app identity ([docs/native-apps.md](../docs/native-apps.md)). An environment
  registers its iOS apps (a team ID and a bundle ID) and Android apps (a package name and the
  SHA-256 fingerprints of its signing certificates) through `/v1/admin/native-apps`, and the
  server serves Apple's `apple-app-site-association` and Android's `assetlinks.json` for it
  under `/v1/environments/<id>/.well-known/`. The files name the apps for the domain's
  credentials only (`webcredentials`, `get_login_creds`); they hand an app no link.
  
  `@tula-tech/contract` gains the schemas, the identifier patterns and caps, the two file builders
  (`appleAppSiteAssociation`, `assetLinks`), `nativeAppWeakenings` and three event types
  (`native_app.created`, `native_app.updated`, `native_app.deleted`). `@tula-tech/admin` gains the
  typed operations. `@tula-tech/config` takes `nativeApps` on an environment and exports
  `NativeAppConfig`, `IosAppConfig` and `AndroidAppConfig`; an environment without the key is
  not read, not changed and keeps its fingerprint. `tula diff` plans them (an app is its
  platform and its identifier) and marks as weaker an app registered, an iOS app's changed
  team and a gained fingerprint; `tula apply --yes` refuses such a plan without
  `--allow-weaker`, writes native apps last, and `--json` gains `nativeApps`.
- 095a866: Native Sign in with Apple by identity token
  ([docs/native-apps.md](../docs/native-apps.md#signing-in-with-apple-without-a-browser),
  ADR 0047).
  
  - `@tula-tech/contract`: `ID_TOKEN_PROVIDERS` gains `apple`. Which client kinds may start the
    sign-in is per provider (`ID_TOKEN_CLIENT_KINDS`: `ios` and `android` for Google, `ios`
    alone for Apple), and `takesAdditionalClientIds` says which provider has
    `additionalClientIds` (Google alone). The exchange's body
    (`IdTokenExchangeRequestSchema`) may carry `givenName` and `familyName` beside the token
    (`MAX_ID_TOKEN_NAME_LENGTH`), read for Apple only.
  - `@tula-tech/core`: `signIn.withIdToken({ provider: 'apple' })` for an `ios` client, and
    `exchange(idToken, name?)`, which passes on the name the Sign in with Apple sheet gave
    the app (`IdTokenName`). The client does not hash the nonce: an app hands the sheet the
    lowercase hexadecimal SHA-256 of `nonce`.
  
  **For an operator.** A native Apple token is accepted for the bundle ID of an iOS app the
  environment has registered. An environment that already has a registered iOS app **and**
  Apple enabled accepts such tokens for that app once the server is upgraded, with no new
  setting.
- 1f189d8: Native sign-in with Google's ID token
  ([docs/native-apps.md](../docs/native-apps.md#signing-in-with-google-without-a-browser),
  ADR 0045).
  
  - `@tula-tech/contract`: the two requests of the sign-in (`IdTokenStartRequestSchema`,
    `IdTokenStartSchema`, `IdTokenExchangeRequestSchema`, `ID_TOKEN_PROVIDERS`,
    `MAX_ID_TOKEN_LENGTH`). A provider's settings have `additionalClientIds`
    (`AdditionalClientIdsSchema`, `isGoogleClientId`, `MAX_ADDITIONAL_CLIENT_IDS`): the
    client ids, beside the provider's own, whose ID tokens are accepted. Google only, and
    never the provider's own `clientId` (`ownClientIdAmong`; the admin API and
    `@tula-tech/config` refuse it). A
    gained one is a weakening (`oauthProviderWeakenings`); `oauth_provider.updated` may name
    the field in `changed` and carry `additionalClientIdCount`.
  - `@tula-tech/core`: `signIn.withIdToken({ provider: 'google' })` for an `ios` or `android`
    client. It answers the server's nonce and an `exchange(idToken)` that returns the flow.
    The start carries a device proof when the client has a device key.
  - `@tula-tech/admin`: the generated types have `additionalClientIds` on a provider and on its
    update body.
  - `@tula-tech/config`: `providers.google.additionalClientIds` (`GoogleProviderConfig`). Left out
    means none. A file that names none keeps its fingerprint.
  - `@tula-tech/cli`: `tula diff` and `tula apply` plan Google's `additionalClientIds` as a set.
    The file's list is the whole set; a gained id is `providers.google.additionalClientIds`
    and needs `--allow-weaker` under `--yes`. A `ProviderChange` has `weakened`.
  - `@tula-tech/mcp`: `list_oauth_providers` returns `additionalClientIds`.
- 1b61d3e: `androidApkKeyHashOrigin(fingerprint)` and `ANDROID_APK_KEY_HASH_PREFIX`: the origin an
  Android app's passkey response carries (`android:apk-key-hash:` and the SHA-256 fingerprint
  of its signing certificate as base64url without padding), from a fingerprint in either
  spelling; `null` for a value that is not one. The API accepts a passkey response from a
  registered native app by that origin (Android) or by `https://<rpId>` (iOS, once an iOS app
  is registered and the environment's `urls.allowedOrigins` lists that origin), for a request
  with no `Origin` that says `x-tula-client: ios` or `android`.
- c04622e: `@tula-tech/nextjs`: Tula for the Next.js App Router (ADR 0029).
  
  - `@tula-tech/nextjs/handlers`: `createTulaHandlers()`, a catch-all route handler that stands in
    for the API's `/v1/client/*` on the app's own origin. The browser's client talks to it and
    never to the API's host, so the refresh cookie, a `stateful` session's cookie and a new
    access-token cookie are first-party, `HttpOnly` cookies of the app. It forwards the
    browser's `Origin` unchanged, refuses requests that do not come from the app's own pages,
    never forwards the admin API and never follows a redirect. It trusts no forwarding header
    by default: the visitor's address reaches the API only with `trustedProxyHops`
    (`TULA_TRUSTED_PROXY_HOPS`) or `clientIp`. A sign-in replaces the browser's session
    whatever its kind, and request bodies and JSON answers are capped at 1 MiB.
  - `@tula-tech/nextjs/middleware`: `tulaMiddleware()` for `proxy.ts` (Next.js 16) or `middleware.ts`
    (Next.js 15). Verifies the access token offline against the environment's JWKS, refreshes it
    once through the API when it is missing or expiring, protects routes by matcher and
    redirects to sign-in with a same-origin `redirect_url` (`safeRedirectPath`). It clears the
    cookies only when the API says the session is over; a refusal caused by the app's own
    configuration (origin, key) keeps them and is reported once (`onWarning`).
  - `@tula-tech/nextjs` refuses a configuration that would send the secret key (`stateful` session
    profiles) to a plain `http:` `apiUrl` that is not this machine; `allowInsecureHttp`
    (`TULA_ALLOW_INSECURE_HTTP=true`) allows it on a private network you trust.
  - `@tula-tech/nextjs/server`: `auth()`, `currentUser()` and `getToken()` for Server Components,
    Route Handlers and Server Actions.
  - `@tula-tech/nextjs`: `<TulaProvider>` for the App Router (takes the server's `initialState`, so
    the first paint is right) and every `@tula-tech/react` component and hook, marked `'use client'`.
  - `@tula-tech/contract/issuer`: `environmentIssuer` and `jwksUrl` as a Zod-free entry point (still
    exported from the index).
  - `@tula-tech/core`: `TulaClient` has an optional `serverState`, set by a framework integration.
    `@tula-tech/react` renders it during server rendering and hydration instead of `loading`.
- d72fb3d: Sign in with Discord and LinkedIn.
  
  - `@tula-tech/contract`: `discord` and `linkedin` in `OAUTH_PROVIDERS`; the first-factor
    strategies `oauth_discord` and `oauth_linkedin`, which are also `user.created` methods and
    `HOOK_SIGN_UP_METHODS`, so a `before_sign_up` hook may be asked with either `method`. Each
    takes `clientId` and `clientSecret`, like Google and GitHub.
  - `@tula-tech/core` and `@tula-tech/admin`: the generated types carry the two providers and
    strategies. No run-time change.
  - `@tula-tech/react`: "Continue with Discord" and "Continue with LinkedIn" buttons on `<SignIn>`
    and `<SignUp>`, and both names under "Connected accounts". The marks are drawn inline;
    nothing is fetched. They were drawn without either brand page open: check them against
    Discord's and LinkedIn's brand guidelines before shipping.
  - `@tula-tech/config`: `providers.discord` and `providers.linkedin` (`clientId`,
    `clientSecret: env('NAME')`).
  - `@tula-tech/cli`: `tula diff` and `tula apply` manage both.
  
  LinkedIn's sign-in has no PKCE and no nonce (LinkedIn documents neither). The account is the
  `sub` of the verified ID token; the address and whether it is verified are read from
  LinkedIn's userinfo endpoint. See `docs/providers/linkedin.md` before offering it.
- 07eff2f: Sign in with Microsoft (Entra ID work and school accounts, and personal accounts).
  
  - `@tula-tech/contract`: `microsoft` in `OAUTH_PROVIDERS`; the first-factor strategy
    `oauth_microsoft`; `MicrosoftTenantSchema`, `MicrosoftTenant` and
    `MICROSOFT_TENANT_ALIASES`; `tenant` on `OAuthProviderUpdate` (required for Microsoft:
    `common`, `organizations`, `consumers` or a tenant id; a domain name is refused) and, as
    `string | null`, on `OAuthProviderSettings`; `oauth_microsoft` as a `user.created` method
    and `tenant` as a name in `oauth_provider.updated.changed`; `oauth_microsoft` among
    `HOOK_SIGN_UP_METHODS`, so a `before_sign_up` hook may be asked with that `method`.
  - `@tula-tech/core` and `@tula-tech/admin`: the generated types carry the new provider, strategy and
    field. No run-time change in `@tula-tech/core`.
  - `@tula-tech/react`: a "Continue with Microsoft" button on `<SignIn>` and `<SignUp>` and
    "Microsoft" under "Connected accounts". The mark is drawn inline; nothing is fetched.
  - `@tula-tech/config`: `providers.microsoft` (`clientId`, `clientSecret: env('NAME')`, `tenant`)
    and the type `MicrosoftProviderConfig`.
  - `@tula-tech/cli`: `tula diff` and `tula apply` manage Microsoft and its `tenant`. A change of
    tenant keeps the stored secret, as switching a provider on or off does.
  - `@tula-tech/mcp`: `list_oauth_providers` returns each provider's `tenant`.
  - `create-tula`: the scaffold's comments about the mock provider no longer list the
    providers by name.
- 82d87eb: Sign in with X and Facebook, and accounts with no email address.
  
  Neither provider is asked for an email address, so a first sign-in with either makes an
  account that has none. **`User.email` is now `string | null`** in the contract and in every
  generated type: code that reads a user's `email` has to allow for `null`. The same holds
  for the `before_sign_up` hook's question (`data.email`).
  
  - `@tula-tech/contract`: `x` and `facebook` in `OAUTH_PROVIDERS`; `OAUTH_PROVIDERS_WITHOUT_ADDRESS`
    and `givesNoAddress(provider)`, the one place that says which providers give no address;
    the strategies `oauth_x` and `oauth_facebook`, which are also `user.created` methods and
    `HOOK_SIGN_UP_METHODS`. `UserSchema.email` and `HookBeforeSignUpDataSchema.email` are
    nullable.
  - `@tula-tech/core` and `@tula-tech/admin`: the generated types carry the two providers, the two
    strategies and the nullable `email`. No run-time change. `verifyHook`'s examples check
    the address for `null`.
  - `@tula-tech/react`: "Continue with X" and "Continue with Facebook" buttons on `<SignIn>` and
    `<SignUp>`, and both names under "Connected accounts". The marks are drawn inline and
    were not checked against X's or Meta's brand guidelines. `<UserButton>` and
    `<UserProfile>` draw a user with no address by name, with no address line, no
    verification badge and no password section.
  - `@tula-tech/nextjs`: `currentUser()` may return a user whose `email` is `null`.
  - `@tula-tech/config`: `providers.x` and `providers.facebook` (`clientId`,
    `clientSecret: env('NAME')`; for Facebook the app id and the app secret).
  - `@tula-tech/cli`: `tula diff` and `tula apply` manage both.
  - `@tula-tech/mcp`: `get_user` and `list_users` return `email: null` for such a user; the
    scaffolds greet a user who has neither a first name nor an address.
  - `create-tula`: the app templates do the same.
  
  An account with no address gets no security emails, cannot sign in by emailed code or link,
  cannot have a password, and cannot be given an address yet. Switching its provider off,
  or removing the provider's credentials, locks it out until the provider is configured
  again, and nothing warns first. A JWT template's `user.email` and `user.email_verified`
  claims are both left out of its tokens (absent, not `false`); `user.created` still says
  `emailVerified: false` for it. Facebook's sign-in has no PKCE
  and no nonce (Meta documents neither for this flow). What X charges for the API call a
  sign-in makes was not confirmed. See `docs/providers/x.md` and `docs/providers/facebook.md`
  before offering either.
- fc7d990: Sign in with Google, GitHub and Apple, with an environment's own OAuth credentials.
  
  - `@tula-tech/contract`: new `OAuthProvider`, `OAuthStartRequest`, `OAuthStart`,
    `OAuthExchangeRequest`, `Identity`, `IdentityList`, `IdentityLinkStart`,
    `OAuthProviderSettings` and `OAuthProviderUpdate`; error codes `oauth.access_denied`,
    `oauth.provider_error`, `oauth.state_invalid`, `oauth.ticket_invalid`,
    `oauth.different_browser`, `oauth.email_missing`, `oauth.email_unverified`,
    `oauth.account_exists`, `oauth.identity_in_use`, `oauth.already_linked` and
    `identity.last_sign_in_method`; `ClientConfig.signIn.oauth`; the setting
    `notifications.identityChanged`; the fragment parameters `OAUTH_TICKET_PARAM` and
    `OAUTH_ERROR_PARAM`. **Changed:** the settings schema no longer refuses a document with
    every sign-in method off (the server does, unless an OAuth provider is enabled);
    `hasEnabledSignInMethod` and `AT_LEAST_ONE_SIGN_IN_METHOD` are exported for that check.
  - `@tula-tech/core`: `signIn.withOAuth`, `signIn.handleOAuthCallback`, `signIn.canUseOAuth` and
    `user.identities.{list, link, unlink}`. The round trip's binding is kept in
    `sessionStorage` for the tab; no token is.
  - `@tula-tech/react`: "Continue with …" buttons on `<SignIn>` and `<SignUp>`, `<OAuthCallback>` and
    `useOAuthCallback()`, "Connected accounts" in `<UserProfile>`, the `oauthCallbackUrl` option,
    new localization strings (`oauth`, and seven under `userProfile`) and element names
    (`oauthButtons`, `oauthIcon`, `divider`, `identityList`, `identityItem`).
- 596b4cd: Passkeys (WebAuthn): registration, usernameless sign-in, second factor and step-up.
  
  - `@tula-tech/contract`: the `passkey` schemas (`Passkey`, creation and request options, the
    browser's registration and assertion responses, the register, rename and sign-in requests),
    `signIn.methods.passkey` and `passkeys.rpId` in the environment settings (with
    `isRelyingPartyId` and `originMatchesRelyingParty`), `passkey` as a second-factor proof and a
    step-up method, the `amr` values `hwk`, `swk` and `user`, the audit actions
    `user.passkey_*`, and the error codes `passkey.registration_failed`,
    `passkey.already_registered`, `passkey.limit_reached` and `passkey.last_sign_in_method`.
    `CAN_STILL_SIGN_IN_HEADER` (`x-tula-can-still-sign-in`, in `@tula-tech/contract/headers`): the
    response header of the admin factor reset, which removes passkeys too and says with it
    whether the user can still sign in (the route keeps answering `204`). Passkey sign-in
    starts have a per-environment ceiling of their own.
  - `@tula-tech/core`: `signIn.canUsePasskey()`, `signIn.canAutofillPasskey()` and
    `signIn.withPasskey({ signal, autofill })`; `flow.submitSecondFactorWithPasskey()` on the
    sign-in and password-reset flows; `session.stepUpWithPasskey()`;
    `user.passkeys.{list,add,rename,remove}`. No dependency: the client calls
    `navigator.credentials` itself. New client codes, all `status: 0`: `passkey.unsupported`,
    `passkey.cancelled`, `passkey.already_on_device` and `passkey.failed`. `stepUpMethods` now
    returns `passkey` where the server lists it.
- 894b927: `password.expiryDays` takes effect: where it is set, a user who signs in with a password
  that was set that many days ago or longer has to choose a new one before the sign-in
  completes.
  
  **Check the setting in every environment, and `PASSWORD_POLICY`, before you upgrade the
  server.** Until now the number was stored and did nothing, and the `legacy` preset has it at
  90. Age is counted from when a password was last set; for the passwords that already exist
  that is the last time their row was written (migration `0029`). A user whose password is
  older than the period is asked for a new one at their next sign-in with it. Nobody is signed
  out and no email is sent. Only a sign-in with the password is affected: an emailed or texted
  code, a link, a passkey and a provider sign in whatever the password's age.
  
  **Upgrade clients before the server.** An app built on a `@tula-tech/react` or `@tula-tech/core` older
  than this release shows "This step is not supported" where the new password is asked for,
  so a user with an expired password cannot sign in through it. Or set `expiryDays` to `null`
  until every client is upgraded.
  
  - `@tula-tech/contract`: the `needs_new_password` step gains an optional `reason`
    (`NewPasswordReasonSchema`: `expired`). With a reason its `strategies` is empty; a
    password reset's step is unchanged. A new operation,
    `POST /v1/client/sign-ins/{attemptId}/new-password` (`submitSignInNewPassword`).
  - `@tula-tech/core`: a sign-in flow gains `submitNewPassword({ password })`, for the step
    `needs_new_password` with `reason: 'expired'`. A refused password (`password.*`) leaves the
    flow on the step.
  - `@tula-tech/react`: `<SignIn>` draws a "Your password has expired" screen for that step, with
    the policy's checklist. Four new strings, under `expiredPassword` in the localization
    table (`title`, `subtitle`, `newPasswordLabel`, `submit`): an app with a complete
    localization of its own adds them.
  - `@tula-tech/nextjs`: its `<SignIn>` is `@tula-tech/react`'s and gains the screen; the route handler
    forwards the new operation like every `/v1/client/*` call.
- 751eae5: `password.history` takes effect: where it is 1 or more, the server refuses, as a user's new
  password, their current password and the ones before it, as many as the number says, in a
  password change and in a reset.
  
  **Check the setting in every environment before you upgrade the server.** Until now the
  number was stored and did nothing, and the `strict` preset has it at 5. The history starts
  empty (migration `0026`): only passwords changed after the upgrade are remembered. Lowering
  the number deletes the stored hashes it no longer covers; raising it brings nothing back.
  
  - `@tula-tech/contract`: the error code `password.reused` (422, `params.history`), and
    `MAX_PASSWORD_HISTORY` (24), the ceiling `history` already had.
  - `@tula-tech/core`: the message of `password.reused`. `user.changePassword` and a reset's
    `submit` can now throw it.
  - `@tula-tech/react` (and `@tula-tech/nextjs`, which has the same components): the checklist under a
    new password on `<UserProfile>` and in the reset of `<SignIn>` lists the rule where the
    policy remembers passwords, as "checked when you save" and, once the server refuses the
    password, as not met; it is never drawn as met. New strings in the localization:
    `password.history`, `password.historyCurrent`, `password.checkedOnSave`. A custom
    localization that is a complete `Localization` object has to add them.
  - `@tula-tech/admin`: the generated types name the new error code. A password an administrator
    sets (`setUserPassword`) is remembered and is not compared with the history.
- 59c2709: A phone number on an account, proven with a texted code (ADR 0037).
  
  - `@tula-tech/contract`: phone numbers as plain data, exported from the index (`parsePhoneNumber`,
    `maskPhoneNumber`, `COUNTRY_CALLING_PREFIXES`, `SMS_COUNTRIES`, `isSmsCountry`,
    `phoneNumberCountries`, `isPhoneNumberAllowed`). A user gains `phoneNumber` and
    `phoneNumberVerifiedAt`. The settings gain `sms` (`enabled`, default `false`;
    `allowedCountries`, default `[]`, where empty means nothing is sent), and the client
    configuration `phone.enabled`. New error codes `phone.invalid`, `sms.disabled`,
    `sms.country_not_allowed` and `sms.unavailable`; new events `user.phone_number_added` and
    `user.phone_number_removed`, whose payload holds no number. New schemas
    `PhoneNumberRequestSchema`, `PhoneCodeSentSchema`, `PhoneNumberVerifyRequestSchema` and
    `SmsCountrySchema`.
  - `@tula-tech/core`: `client.user.phone.request({ phoneNumber })`, `.verify({ code })` and
    `.remove()` for the signed-in user, and the type `PhoneCodeSent`. The answers are checked
    before anything is built from them, and a user is installed only for the session that asked.
  - `@tula-tech/react`: `<UserProfile>` gains a "Phone number" section (add with a texted code,
    change, remove), shown where the environment can text a code or the user has a number.
    New strings under `phone` in the localization table.
  - `@tula-tech/admin`: the generated types know the three operations, the `sms` settings and a
    user's phone fields.
  - `@tula-tech/cli`: `tula diff` and `tula apply` compare `sms.allowedCountries` as a set.
  - `@tula-tech/mcp`: `get_settings` returns `sms`. A user's phone number is not returned by any
    tool.
- 99593eb: An agent can propose three more changes, each of which an administrator can put back with
  one call: lifting a ban (`unban_user`), ending one session by its id (`end_session`) and
  switching one OAuth provider off (`disable_oauth_provider`: `enabled: false`, its
  credentials kept, and refused when it would remove an environment's last way to sign in,
  when it is proposed and again when it is approved). `@tula-tech/mcp` gains
  `propose_unban_user`, `propose_end_session` and `propose_disable_oauth_provider`;
  `tula approve` shows and asks about each in words of its own.
  
  A production environment accepts proposals only where its settings say so: the new
  setting `agents.proposalsInProduction`, off by default. Switching it on is a weakening
  (recorded in the audit log, asked about in the dashboard, and refused by
  `tula apply --yes` without `--allow-weaker`). In `tula.config.ts` the key left out is
  `false`; the default does not change a config's fingerprint.
  
  Proposals are limited to five a minute for each operation, beside the ten a minute an
  environment's agents share. A proposal's `target.id` is a UUID for a user and a session
  and a provider's name for a provider; `failureReason` gains `last_sign_in_method`, and an
  approval can be refused with `production_environment`.
- c97d084: First prerelease of the React SDK.
  
  - `@tula-tech/react`: `TulaProvider`, the hooks (`useAuth`, `useUser`, `useSession`, `useSignIn`,
    `useSignUp`, `useResetPassword`, `usePasswordChecklist`, `useClientConfig`, `useTula`),
    `SignedIn` / `SignedOut` / `TulaLoading`, and the prebuilt `SignIn` (with forgotten
    password), `SignUp`, `UserButton` and `UserProfile`, with one themeable stylesheet
    (`@tula-tech/react/styles.css`), an `appearance` prop and a typed localization table.
  - `@tula-tech/contract`: a Zod-free `/theme` entry point: the theme tokens shared by every front
    end, their light and dark defaults, `themeToCssVariables`, `isValidThemeValue` (theme values
    are validated against a strict grammar and dropped when they do not match) and
    `contrastRatio`.
  - `@tula-tech/core`: a tab waiting for the cross-tab lock now waits for as long as a refresh can
    take with its one retry, so an app with a small `timeoutMs` no longer has two tabs refresh at
    once; `user.get()` no longer installs a user fetched for an earlier session; and a 204's
    empty body is read, so browsers stop listing successful sign-outs as cancelled requests.
- 79bc411: Security notice emails, and a loading-state fix.
  
  - `@tula-tech/contract`: `EnvironmentSettings` gains `notifications: { passwordChanged, newSignIn }`
    (both `true` by default): whether an account's owner is emailed when their password changes
    and when the account is signed in to from a new device. Additive; documents saved earlier
    read as "on".
  - `@tula-tech/react`: `useSession` reports `isLoading: true` for the whole first fetch under
    React's StrictMode. The effect runs twice in development; its second run cleared the flag and
    then joined the first run's request without setting it again.
- 190bb99: Session profiles, the stateful session type and session rules (ADR 0028).
  
  - `@tula-tech/contract`: `sessions` in the environment settings (`SessionSettings`): named
    `profiles` (`web` and `mobile` always; `SessionProfile` now has `type`, `accessTokenTtl`,
    `idleTimeout`, `absoluteTimeout`, `refresh.reuseGracePeriod`, `stepUpAfter`,
    `clientSelectable`, with documented bounds; `accessTokenTtl` may not be longer than
    `idleTimeout`), `maxPerUser` and `onLimit`. Helpers
    `resolveSessionProfile`, `profileOfSession`, `builtInSessionProfile`, `stepUpWindowSeconds`.
    New: the `x-tula-session-profile` header (`SESSION_PROFILE_HEADER`), the error code
    `session.limit_reached`, the access-token claim `sp`, `VerifySessionRequest`
    (`POST /v1/admin/sessions/verify`), `HybridSessionTokens`.
    **Breaking:** `SessionTokens.accessToken` and `accessTokenExpiresAt` are optional (absent
    for a session of a `stateful` profile); `SessionType` is now `hybrid | stateful`;
    `SessionProfile` lost `refresh.rotate`, `refresh.reuseDetection`, `multiSession` and
    `maxConcurrent` (never read by a server), and `IMPLEMENTED_SESSION_TYPES` is gone;
    `refresh.reuseGracePeriod` may be `null`.
  - `@tula-tech/core`: `createTulaClient({ sessionProfile })` asks for a profile. A browser client
    works against a `stateful` profile: it holds no token (`session.getToken()` returns `null`),
    authenticated calls rely on the httpOnly cookie, a refused call signs the client and its
    other tabs out at once, and sign-out is unchanged. `session.limit_reached` has a message.
- 259f896: A sign-in test ([ADR 0058](../docs/adr/0058-test-signin.md)): the setting
  `agents.testSignIn` (`true`, `false` or `null`, the default: on in a development
  environment, off in a production one; writing `true` is a weakening), `testSignInAllowed`,
  the report's schema (`SignInTestReportSchema`) and its closed lists, the reserved address
  of a throwaway user (`testAddress`, `isTestAddress`, `TEST_ADDRESS_DOMAIN`), the activity
  types `sign_in_test.started` and `sign_in_test.finished`, and an optional `test: true` on
  `user.created`. An address in the reserved domain is no longer accepted as a person's.
- 61af5e2: Text messages in the dashboard, and a wider reach of a required texted second step is a
  weakening ([ADR 0025](../docs/adr/0025-mfa.md), [ADR 0037](../docs/adr/0037-phone-numbers-and-sms.md),
  [docs/phone-numbers.md](../docs/phone-numbers.md)).
  
  **`@tula-tech/contract`**
  
  - `settingsWeakenings` lists two more changes, both only where `mfa.smsCode` is on and
    `mfa.policy` is `required` after the change: text messages switched on or a first country
    allowed (`mfa.smsCode`), and a country added where a texted code could already be that
    second step (`sms.allowedCountries`). A save that makes either is recorded with
    `weakened: true`, asked about by the dashboard and refused by `tula apply --yes` without
    `--allow-weaker`. Nothing that was listed before is listed differently.
  - `smsCostLimits(dailyMessageLimit)`, `SMS_PREFIX_HOURLY_SHARE`,
    `SMS_ENVIRONMENT_HOURLY_SHARE` and `SmsCostLimits`: what a daily limit allows in an hour
    in all and to one destination prefix. The server holds a send to this function; it was
    the server's own before.
  - `smsPrefixCountries(prefix)`: every country of the table that a destination prefix covers.
  
  **`@tula-tech/cli`**
  
  - `tula diff` and `tula apply` say in words, under the plan, when it switches off the
    texted code as the second step (`mfa.smsCode` off in the file, or left out of it): users
    whose only second step is a texted code cannot sign in until it is on again or an
    administrator resets them. The plan is as before and is still not a weakening.
  - The same for a plan that takes a country out of `sms.allowedCountries` (the countries are
    named) and for one that switches `sms.enabled` off: users there can no longer receive a
    code. Neither changes the plan or needs a flag.
  - The two new weakenings are in `plan.weakened`.
  
  The dashboard (not published) has a **Text messages** screen: the SMS settings and both
  uses of a texted code on the one save model, whether the deployment has a sender, and the
  codes sent and never used by destination prefix.
- a0377de: A code texted to the account's proven phone number as the second step of a sign-in
  (ADR 0025, "a texted code as the second factor"). Off by default. **Upgrade `@tula-tech/core`
  and `@tula-tech/react` before switching it on**: an older client shows "not supported" at a
  second step whose only option is a texted code.
  
  - `@tula-tech/contract`: the second-factor method `sms_code` (in `SecondFactorMethod`, in a
    step's `options` and its new `prepared` part, and among the step-up methods), the setting
    `mfa.smsCode.enabled` (default off) and `mfa.smsCode` in the client configuration,
    `Factors.sms` (`enabled`, `enabledAt`, `inUse`, `available`), the event types
    `user.sms_factor_enabled` and `user.sms_factor_removed`, the email template kinds
    `sms_factor_enabled` and `sms_factor_removed`, the text message template kind
    `second_factor` (one wording for the three texted second-step codes), and the error codes
    `mfa.needs_other_sign_in` (403), `mfa.sms_not_allowed` (409) and
    `mfa.phone_number_required` (409). `settingsWeakenings` lists `mfa.smsCode` when it is
    switched on where the policy is `required` after the change. A texted code records `sms`
    in `amr` and never `mfa`.
  - `@tula-tech/core`: `tula.mfa.startSms()`, `tula.mfa.confirmSms({ code })` and
    `tula.mfa.disableSms()`; `flow.prepareSecondFactor({ method: 'sms_code' })` on the
    sign-in and password-reset flows, and `submitSecondFactor({ method: 'sms_code', code })`;
    `session.prepareStepUp({ method: 'sms_code' })` and
    `session.stepUp({ method: 'sms_code', code })`. Three more messages in the error table.
  - `@tula-tech/react`: the second-step screen and the step-up dialog gain "Text me a code" (the
    message is asked for with a button, never sent on arrival), and `<UserProfile>` offers,
    confirms and turns off a texted code as the second step. New strings under `mfa`
    (`smsSubtitle`, `smsSend`, `smsOffer`, `smsTurnOn`, `smsStatusOn`, `smsNotInUse`,
    `smsWeaker`, `smsTurnOff`, `smsTurnedOn`, `smsTurnedOff`), `stepUp` (`smsSubtitle`) and
    `passkey` (`replacesTextedCode`: shown above "Add a passkey" to a user whose second step
    is a texted code, which the passkey replaces and which has no backup codes; `addChecking`
    and `addUnchecked`: read with that button, which is unavailable until the account's
    second step has been read, and stays so when the read fails). A texted
    code set aside by a stronger factor is said to come back when that factor is removed.
    Where the app has switched texted codes, text messages or the number's country off, the
    texted-code form shows the message of that refusal (`auth.method_disabled`,
    `sms.disabled`, `sms.country_not_allowed`) and removes its buttons.
  - `@tula-tech/admin`: the generated types know the routes, the setting, the method and the
    codes; a user's `authentication.factors` may hold `{ type: 'sms' }`.
  - `@tula-tech/mcp`: `get_settings` returns `mfa.smsCode`.
  - `@tula-tech/config`: a config accepts `mfa.smsCode`. An environment that leaves it off keeps
    the fingerprint it had: the key is hashed only when it is on.
- 73cadb2: SMS send limits and a daily limit per environment (ADR 0037).
  
  - `@tula-tech/contract`: the settings gain `sms.dailyMessageLimit` (default `500`, 1 to
    1,000,000, no value switches it off): the most text messages an environment sends in one
    UTC day. Raising it is a weakening (`settingsWeakenings` lists `sms.dailyMessageLimit`).
    New: `DEFAULT_SMS_DAILY_MESSAGE_LIMIT`, `MAX_SMS_DAILY_MESSAGE_LIMIT`,
    `phoneNumberPrefix` (a number's destination prefix: the calling prefix the country list
    matched) and `SMS_PREFIX_MAX_DIGITS`; `SmsUsageSchema` and `SmsPrefixUsageSchema` with
    `SMS_USAGE_MAX_DAYS`, `SMS_USAGE_DEFAULT_DAYS` and `SMS_USAGE_MAX_PREFIXES`, for the new
    operation `getSmsUsage` (`GET /v1/admin/sms/usage`): codes texted and used, by destination
    prefix. No new error code: a limit answers `rate_limited`.
  - `@tula-tech/config`: `settings.sms.dailyMessageLimit` in `tula.config.ts`. An environment that
    leaves it at the default keeps the fingerprint it had.
  - `@tula-tech/admin`: the generated types know `getSmsUsage` and the new setting.
  - `@tula-tech/cli`: `tula diff` flags a higher `sms.dailyMessageLimit` as a weakening, and
    `tula apply --yes` refuses it without `--allow-weaker`. A file that leaves the limit out
    asks for the default.
  - `@tula-tech/mcp`: `get_settings` returns `sms.dailyMessageLimit`.
- 9c90e25: Signing in with a code texted to a phone number an account has proven (ADR 0037). Off by
  default.
  
  - `@tula-tech/contract`: the first-factor strategy `sms_code` (in `FirstFactorStrategy`, in the
    prepare and attempt requests, and as a step's `prepared.strategy`), the setting
    `signIn.methods.smsCode` (default off; never the only method, see
    `SIGN_IN_METHODS_WITHOUT_SIGN_UP`), the authentication method `sms` in `amr`, and the
    error code `mfa.enrolment_needs_other_sign_in` (403). `settingsWeakenings` lists
    `signIn.methods.smsCode` when a texted code can sign someone in after a change and could
    not before, and `sms.allowedCountries` when a country is added while one does. The client
    configuration lists `smsCode` among `signIn.methods` where it is offered.
  - `@tula-tech/core`: `flow.prepareFirstFactor({ strategy: 'sms_code' })` and
    `flow.attemptFirstFactor({ strategy: 'sms_code', code })`, for a sign-in started with a
    phone number as its identifier. One more message in the error table.
  - `@tula-tech/react`: `<SignIn>` takes a phone number in its first field where the environment
    lists the method, and gains the "Text me a code" and "Check your phone" screens. New
    strings under `signIn` in the localization table (`identifierLabel`, `identifierHint`,
    `smsCode`, `smsCodePrompt`, `smsTitle`, `smsCodeSubtitle`, `smsResend`, `smsResendIn`,
    `smsResent`, `smsCodeWrong`). A version from before this one leaves the strategy out.
  - `@tula-tech/admin`: the generated types know the setting, the strategy and the error code.
  - `@tula-tech/mcp`: `get_settings` returns `signIn.methods.smsCode`.
  - `@tula-tech/config`: a config accepts `signIn.methods.smsCode`. An environment that leaves it
    off keeps the fingerprint it had: the key is hashed only when it is on.
- 0435d00: Text message wording and a preview of any message (`sms.templates` in the settings, and
  `POST /v1/admin/message-preview`).
  
  - `@tula-tech/contract` gains the kinds of text message, their placeholders and rules
    (`SMS_TEMPLATE_KINDS`, `SMS_TEMPLATE_PLACEHOLDERS`, `SMS_TEMPLATE_RULES`,
    `MAX_SMS_TEMPLATE_LENGTH`), the checks (`smsTemplateProblems`, `isSmsTemplateKind`,
    `readStoredSmsTemplates`), an estimate of what a text costs (`smsSegments`) and the
    schemas (`SmsTemplateSchema`, `SmsTemplatesSchema`). The `sms` settings have a new
    field, `templates`, empty by default: an environment that has saved nothing sends the
    message it always did.
  - A template is one sentence with `{{code}}` exactly once and, at most once, `{{appName}}`.
    The server still adds the last line (`@host #code`) itself. A template is refused when
    saved if it lacks the code, is over 140 characters, holds a line break, a hidden
    character, four digits in a row, a word that starts with `@` or `#`, something that
    reads as a link, or a letter, a digit or a combining mark directly beside a placeholder, or does not start with a letter.
  - `@tula-tech/config` accepts `settings.sms.templates`, validated when the file is loaded. A
    file with no wording hashes as before.
  - `tula diff` shows `sms.templates.<kind>.text` as one line, and `tula apply` removes the
    wording of a kind the file leaves out, as for every setting.
  - `@tula-tech/admin` has the `previewMessage` operation and the new settings types.
  - `@tula-tech/mcp`'s `get_settings` still returns `enabled`, `allowedCountries` and
    `dailyMessageLimit` of `sms`, and not the wording.
- d615c72: Step-up by emailed code, `hasPassword` on the signed-in user, and a colour-scheme fix.
  
  - `@tula-tech/contract`: `StepUpMethod` gains `email_code`, `StepUpRequest` accepts
    `{ method: 'email_code', code }`, and `StepUpEmailCode` is the receipt of
    `POST /v1/client/sessions/step-up/email-code`. `GET /v1/client/me` answers `CurrentUser`: a
    `User` plus `hasPassword`. All additive.
  - `@tula-tech/core`: `session.prepareStepUp({ method: 'email_code' })` emails the signed-in user a
    code (for a user with a verified address and no two-step verification) and
    `session.stepUp({ method: 'email_code', code })` proves it. `stepUpMethods(error)` now
    returns `email_code` when the server lists it. New type `StepUpPrepared`; `User` now has
    `hasPassword`.
  - `@tula-tech/react`: the step-up dialog offers the emailed code: next to the password as "Email
    me a code instead" (sent only when chosen), and at once when it is the user's only method,
    with resend and the server's cooldown. `<UserProfile>` tells a user without a password how
    to add one instead of showing the change-password form. Buttons no longer fade their
    background: when the colour scheme changed under an open page the label was unreadable for
    a few frames. New localization strings: `stepUp.emailSubtitle`, `stepUp.emailSubtitleSent`,
    `stepUp.emailSending`, `stepUp.emailSend`, `stepUp.emailInstead`, `stepUp.passwordInstead`
    and `userProfile.passwordNotSet`.
- e12e6d6: Typed, versioned event payloads (ADR 0012): what a webhook will deliver is a contract from its
  first delivery.
  
  - `@tula-tech/contract/event-types` (new entry point, no Zod): `ACTIVITY_TYPES` and `ActivityType`
    (moved here; still exported from the index), `EVENT_SCHEMA_VERSION` (1) and
    `EVENT_TARGET_TYPES` / `EventTargetType`, which says what each event's `target.id` is the id
    of.
  - `EVENT_DATA_SCHEMAS`: the `data` of every event type. `EVENT_SCHEMAS`: the event itself,
    `{ id, type, schemaVersion, occurredAt, actor, target, data }`, with no IP address and no
    user agent. `TulaEventSchema` and the `TulaEvent` type are their union by `type` (not
    `Event`, which is the DOM's); `EventOf<T>` and
    `EventData<T>` name one type's. A payload is an allow-list: ids, values from closed sets,
    booleans; never an email address, a token or a secret.
  - `EVENT_FIXTURES`: a valid example of every event type, as plain data.
  - `MAX_CHANGED_SETTINGS` and `MAX_SETTING_NAME_LENGTH`: the bounds of the names an
    `environment.settings_updated` event lists in `changed`. The set of names is open.
  - `openapi.json` gains the schemas as components (`TulaEvent`, `<Name>Event`, `<Name>EventData`,
    `EventActor`). No route changes.
- 1df35b8: Webhook retries, the delivery log, test events and sending a delivery again.
  
  - `@tula-tech/contract`:
    - A webhook endpoint gains `disabledReason` (`failing`, `gone`, or `null`), `failingSince`
      and `lastFailedAt`.
    - A new event type, `webhook_endpoint.disabled`, with `data.reason`
      (`WEBHOOK_DISABLED_REASONS`): the server switched an endpoint off because every request to
      it failed for five days with no silence longer than the retry schedule, or because it
      answered `410 Gone`.
    - Every event envelope gains an optional `test`, which is `true` on a test event and absent
      on a real one. `EVENT_SCHEMA_VERSION` stays 1.
    - `WebhookDeliverySchema`, `WebhookDeliveryDetailSchema`, `WebhookDeliveryAttemptSchema`,
      `WebhookDeliveryListSchema`, `SendTestWebhookRequestSchema`, `WebhookSendResultSchema`,
      `WEBHOOK_DELIVERY_STATES` and `WEBHOOK_REDELIVER_REFUSALS`.
    - A new error code, `webhook.cannot_redeliver` (409), whose `params.reason` is
      `delivery_pending`, `endpoint_disabled`, `event_gone` or `attempt_limit`.
  - `@tula-tech/admin`: the admin client gains `listWebhookDeliveries`, `getWebhookDelivery`,
    `sendTestWebhook` and `redeliverWebhook`. `verifyWebhook` returns a test event with
    `event.test === true` and refuses a `test` that is anything else; its documentation now says
    that a delivery is retried, that order is not guaranteed, and to check `test` before acting.
  - `@tula-tech/core`: the generated types and the error-message table follow the contract (one new
    code).
- 7d7600d: Webhook secret rotation: an endpoint's signing secret is replaced without dropping a delivery.
  
  - `@tula-tech/contract`:
    - A webhook endpoint gains `rotationOverlapEndsAt`: when the previous secret stops signing,
      or `null` when one secret signs. Until then every delivery carries two signatures in
      `webhook-signature`, the new secret's first.
    - `RotatedWebhookSecretSchema`: the answer of a rotation, the endpoint with its new secret
      (shown once) and `rotationOverlapEndsAt`.
    - Two new event types: `webhook_endpoint.secret_rotated` (`data.rotationOverlapEndsAt`) and
      `webhook_endpoint.previous_secret_revoked` (no data). Neither carries anything of a
      secret. `EVENT_SCHEMA_VERSION` stays 1.
    - A new error code, `webhook.rotation_refused` (409), whose `params.reason` is one of
      `WEBHOOK_ROTATION_REFUSALS`: `rotation_in_progress`, `no_rotation_in_progress` or
      `secret_unreadable`.
  - `@tula-tech/admin`:
    - The admin client gains `rotateWebhookSecret` and `revokePreviousWebhookSecret`.
    - `verifyWebhook` takes one secret **or a list of at most two** (`WEBHOOK_MAX_SECRETS`,
      `WebhookSecrets`): the delivery is accepted when any signature is right for any secret
      given. Every secret listed must be a signing secret; an empty list, a third secret or a
      malformed entry is `webhook.invalid_secret`. A single secret behaves as before.
  - `@tula-tech/core`: the generated types and the error-message table follow the contract (one new
    code).
- 5e51183: Webhooks, first step: an environment's events are delivered, signed, to an endpoint an
  operator registers (`/v1/admin/webhook-endpoints`; [ADR 0034](../docs/adr/0034-webhooks.md),
  [docs/webhooks.md](../docs/webhooks.md)). One attempt per endpoint and event for now: a
  failed delivery is recorded and not repeated.
  
  **`@tula-tech/contract`**
  
  - A new Zod-free entry point, `@tula-tech/contract/webhook-signature`: the Standard Webhooks header
    names (`WEBHOOK_ID_HEADER`, `WEBHOOK_TIMESTAMP_HEADER`, `WEBHOOK_SIGNATURE_HEADER`), the
    secret prefix, the five-minute tolerance, and `signWebhook`, `webhookSecretBytes` and
    `formatWebhookSecret`.
  - The webhook endpoint schemas of the admin API (`WebhookEndpointSchema`,
    `CreatedWebhookEndpointSchema`, the create and update requests, `MAX_WEBHOOK_ENDPOINTS`).
  - Three event types, each with a `data` schema and a fixture: `webhook_endpoint.created`,
    `webhook_endpoint.updated` and `webhook_endpoint.deleted`. Their target is a new target
    type, `webhook_endpoint`. An event never carries an endpoint's address or its secret.
  - A new error code, `webhook.url_not_allowed` (422): the server may not call the address.
    `params.reason` is a fixed word, never the address.
  
  A receiver or an SDK that switches on `type` or on `target.type` sees values it did not list
  before; both lists only grow within `schemaVersion` 1, as documented.
  
  **`@tula-tech/admin`**
  
  - `verifyWebhook(body, headers, secret, options?)`: verifies a delivery (the signature, in
    constant time, accepting any one of several; the headers; a timestamp within five minutes
    either way) and returns the typed event, `TulaWebhookEvent`. It throws `TulaAdminError`
    with one of five new client codes (`webhook.invalid_secret`, `webhook.invalid_headers`,
    `webhook.timestamp_out_of_tolerance`, `webhook.invalid_signature`,
    `webhook.invalid_payload`), never with the secret, a signature or the body in it. Zod-free,
    web platform APIs only.
  - The five webhook endpoint operations (`createWebhookEndpoint`, `listWebhookEndpoints`,
    `getWebhookEndpoint`, `updateWebhookEndpoint`, `deleteWebhookEndpoint`), and the event
    types under `AdminSchemas['TulaEvent']`.
  
  **`@tula-tech/core`**: the generated `ErrorCode` type lists `webhook.url_not_allowed`. Nothing a
  client calls changed.
  
  **`@tula-tech/mcp`**: a webhook signing secret (`whsec_…`) is redacted wherever it turns up in a
  result, like the other secret shapes. There is no webhook tool.
  
  **Before you upgrade the server**: migration `0018` adds a unique key and an index to the
  outbox table (`events`), which locks it for writes while they build; and the first start of
  the new version marks every event recorded so far as settled, without sending any
  ([docs/self-host.md](../docs/self-host.md#upgrading)).

### Patch Changes

- b38efc0: Licensed under Apache-2.0. Every package has the `license` field and ships the repository's
  `LICENSE` file.
- 462aee1: Review fixes of the dashboard step (ADR 0032).
  
  - The OpenAPI snapshot: `POST /v1/instance/session` now says that a sign-in is counted in a
    bucket of its own (10 a minute per IP) and that failed sign-ins are recorded at most once a
    minute per address. The request and response shapes are unchanged.
  - Documented: an application under a Content-Security-Policy without `'unsafe-eval'` should
    set Zod's `jitless` before importing `@tula-tech/contract` (docs/releasing.md).
- 7f204ac: `tula doctor` says when a session profile requires a device key on a deployment that can
  accept none ([ADR 0043](../docs/adr/0043-device-binding.md#a-deployment-that-cannot-bind-and-a-profile-that-requires-a-key-added-2026-10-12-tula-72),
  [docs/device-binding.md](../docs/device-binding.md#a-deployment-that-cannot-bind)). The
  server's diagnostics answer one more check, `device_binding`: `ok` where a device-binding
  proof can name `PUBLIC_URL`; a warning where none can (no session is bound, and a sign-in
  that brings a key is refused); a failure, with a count of environments, where the profile a
  native app gets by default also says `deviceBinding: "required"`, because a native sign-in
  there is refused with a key and without; and a warning with a count where only a profile a
  sign-in has to ask for requires one. Nothing about a sign-in changed: the setting is still
  saved, and `required` is never skipped.
  
  **`@tula-tech/contract`**: the OpenAPI document's description of `getInstanceDiagnostics` names
  the check. No schema changed: a check's `id` was and is a string.
  
  `@tula-tech/cli` and `@tula-tech/mcp` print whatever checks the server answers and are unchanged.
- ee1e737: `tula doctor` checks an environment's native apps
  ([ADR 0040](../docs/adr/0040-native-app-identity.md#what-tula-doctor-checks-added-2026-10-09-tula-35),
  [docs/cli.md](../docs/cli.md#tula-doctor)). The server's diagnostics answer three more
  checks: `native_app_identities` (every registered app is well formed),
  `native_app_files` (the association files name exactly the registered apps, and the server's
  own `PUBLIC_URL` serves them) and `native_app_passkeys` (the passkey relying party is a
  domain an app can be associated with). With no app registered they are `skipped`. Apps
  registered where passkeys are off is `ok` and said (the files serve saved passwords too).
  
  **Breaking for a deployment, not for a package**: the server now refuses to start when
  `PUBLIC_URL` holds a user name, a password, a query or a fragment. It is the issuer of every
  access token and the address the server requests to check itself, where the credentials
  would be sent as basic authentication. Remove them from the value.
  
  **`@tula-tech/contract`**: the OpenAPI document's description of `getInstanceDiagnostics` names
  them. No schema changed: a check's `id` was and is a string.
  
  `@tula-tech/cli` and `@tula-tech/mcp` print whatever checks the server answers and are unchanged. The
  server never requests an operator's own domain: whether Apple or Android can reach the files
  there is not checked, and the checks' text says so.
- 8a4734a: The first release to npm, as alphas under the `alpha` dist-tag. Each of the nine packages
  says where it comes from (`repository`, `homepage`, `bugs`, `keywords`), and its README says
  how to install it and that the API may change between alphas. `@tula-tech/contract` has a README.
  
  `@tula-tech/expo` and `@tula-tech/expo-screens` are held back until they have been run on a device.
  `create-tula --framework expo` therefore refuses, before anything is written, to scaffold a
  project that could not be installed, unless `--tula-packages` points it at tarballs from a
  checkout of the repository.
- 633d73b: The OpenAPI document says more of what the API already does.
  
  - Every `/v1/admin/*` and `/v1/instance/*` operation documents the answers of the dashboard's
    way in: 400 (two credentials in one request), 401, 403 `request.origin_not_allowed` and 404
    (an unknown environment). The routes themselves did not change.
  - An API key's `name` refuses control characters (`^[^\u0000-\u001f\u007f]*$`).
- 9178d46: The OpenAPI document lists a `501` for `sendTestWebhook` and `redeliverWebhook`.
  
  A server can now run its webhook worker as a service of its own (`WEBHOOK_WORKER=separate`;
  docs/self-host.md, "The webhook worker as its own service"). Its API instances then make no
  request to an endpoint, so a test event and a delivery sent again are refused there:
  `not_implemented` (501) with `params.reason: "worker_separate"`. The code is an existing one
  and no schema changed; a deployment that leaves the variable alone answers as before.

## 0.1.0-alpha.1

No changes in this release.

## 0.1.0-alpha.0

### Minor Changes

- a036657: How a user signs in, for a server or the dashboard.
  
  - `@tula-tech/contract`: `UserAuthenticationSchema` / `UserAuthentication`, the answer of
    `GET /v1/admin/users/{userId}/authentication`: whether the account has a password and a
    verified address, its linked provider accounts, its confirmed second factors with the number
    of unused backup codes, its passkeys, and `canSignInWithoutPasskeys` (whether a reset of
    two-step verification would leave the user a way in). Never a secret or a credential id.
  - `@tula-tech/admin`: the admin client gains `getUserAuthentication`.
- a34eb0e: Agent keys and proposals ([ADR 0053](../docs/adr/0053-proposals.md)): the key kind `agent`
  (`tula_ak_…`, `AGENT_KEY_PREFIX`), the proposal's schemas and closed lists
  (`PROPOSAL_OPERATIONS`, `PROPOSAL_OPERATION_TARGETS`, `PROPOSAL_STATUSES`,
  `PROPOSAL_APPROVAL_REFUSALS`, `PROPOSAL_FAILURE_REASONS`, `PROPOSAL_EXPIRY_REASONS`,
  `PROPOSAL_APPROVER_TYPES`, `proposalSummary`), the audit
  target `proposal`, and four event types (`proposal.created`, `proposal.approved`,
  `proposal.executed`, `proposal.failed`). `user.banned` may carry `proposalId` and
  `approvedBy` when an agent's approved proposal carried it out, both or neither. A
  proposal whose agent key was revoked reads as `expired` with `expiryReason:
  'agent_key_revoked'`. No new error code.
- 1c76ead: App-link and custom-scheme redirects ([docs/native-apps.md](../docs/native-apps.md),
  ADR 0044).
  
  - `@tula-tech/contract`: a new Zod-free entry point, `@tula-tech/contract/redirect-url`
    (`redirectUrlKind`, `isRedirectUrl`, `isCustomSchemeRedirectUrl`,
    `REDIRECT_SCHEMES_NEVER_CUSTOM`, `OAUTH_PROVIDERS_WITH_PKCE`,
    `OAUTH_PROVIDERS_WITHOUT_PKCE`, `bindsCodeWithPkce`, `customSchemeRedirectRefusal`).
    `urls.allowedRedirectUrls` accepts a custom scheme in reverse-domain form
    (`com.example.app:/oauth`); listing one is a weakening (`urls.allowedRedirectUrls`). A
    web entry must now start with `https://` or `http://` as written. A native app has
    `appLinkPaths` (`isAppLinkPath`, `normalizeAppLinkPaths`, `MAX_APP_LINK_PATHS`); the two
    file builders serve `applinks` and `handle_all_urls` for an app that has some;
    `nativeAppWeakenings` reports a gained path; the `native_app.*` events carry a count of
    paths. `request.redirect_not_allowed` may carry `params.reason`.
  - `@tula-tech/admin`: the generated types have `appLinkPaths` on a native app and on its create
    and update bodies.
  - `@tula-tech/config`: `appLinkPaths` on a `nativeApps` entry.
  - `@tula-tech/cli`: `tula diff` and `tula apply` plan `appLinkPaths` as a set. Left out of an
    entry the paths are unmanaged (kept, and the diff says how many the server has); written,
    also as `[]`, the list is the whole set. A gained path is `nativeApps.<platform>/<identifier>.appLinkPaths` and needs
    `--allow-weaker` under `--yes`, as does a custom-scheme redirect URL the file adds.
- 55115bc: `tula approve` shows a session with whose it is and whether it is still live, and says
  when an approval found nothing left to change.
  
  - **A session in the question.** For `end_session` the command reads the session and its
    user with the operator's key and prints the owner's id, address and name, the kind of
    client, when the session was signed in and "live now" or "already ended". A read that
    fails is said in fixed words beside the id ("could not be read", "no such session now")
    and is never guessed. The user agent and the IP address are not printed.
  - **`GET /v1/admin/sessions/{sessionId}`** (`getSession` in `@tula-tech/admin`) reads one
    session of an environment by its id: the session list's shape with `userId` and `active`
    (`AdminSessionSchema` / `AdminSession` in `@tula-tech/contract`). An unknown id and another
    environment's are the same 404.
  - **`changed` on an approval's answer.** `ProposalSchema` gains an optional boolean,
    present only in the answer to the approval that carried the proposal out, and
    `proposal.executed` gains the same field: `false` when the operation ran and found the
    target already so (the session had ended, the user was not banned, the provider was
    off). `tula approve` then prints "carried out; … so nothing changed" in place of the
    sentence that describes the change, and still exits 0. A later read of the proposal does
    not carry the field.
  
  A stored proposal whose operation the server has no branch for is now `failed` with
  `error` when it is approved; it was recorded as carried out.
- 0a5e496: `audit.retentionDays` takes effect: the server's retention job now deletes an environment's
  audit entries older than the period, permanently. The schema and its default (`null`: keep
  entries for ever) are unchanged.
  
  **Check the setting in every environment before you upgrade the server.** Until now the
  setting was stored and did nothing. An environment that already holds a number starts
  deleting its older audit entries, for good, with the first retention run of the new version
  (migration `0017`; runs happen at start-up and every ten minutes, and a large backlog takes
  several). `null`, the default, keeps everything, as before. Saving a period, or a shorter
  one, deletes the older entries for good, starting with the next retention run: export first
  (`GET /v1/admin/audit-logs`).
  
  `settingsWeakenings` now lists `audit.retentionDays` when a period is set where there was
  none or is made shorter (not when it is lengthened or removed). So the server's audit entry
  for such a change carries `weakened: true`, `tula diff` warns about it and
  `tula apply --yes` refuses it without `--allow-weaker`.
- 9166270: Settings as code (ADR 0030): `tula.config.ts`, `tula diff` and `tula apply`.
  
  - `@tula-tech/admin` (new): a typed client for every `/v1/admin/*` operation, generated from the
    OpenAPI contract. `createAdminClient({ baseUrl, secretKey })`, one `call(operationId, input)`
    function, one error class (`TulaAdminError`) carrying the contract's code, field errors and
    `Retry-After`. Server-side only: it refuses a publishable key, refuses to be created in a
    browser, and its `browser` export condition resolves to a module that throws. A plain
    `http:` `baseUrl` is refused unless the host is this machine or `allowInsecureHttp` is set,
    and a path parameter that is not a single path segment is refused before the request
    (`client.invalid_param`).
  - `@tula-tech/config` (new): `defineConfig()` for `tula.config.ts`, validated with the contract's
    schemas. One file describes several environments: the settings document and the OAuth
    providers of each. A provider's secret is `env('NAME')` and nothing else; a literal is a type
    error and a load error. `loadConfig()`, `selectEnvironment()`, `hashEnvironmentConfig()`.
  - `@tula-tech/cli` (new): the `tula` executable. `tula diff` prints what would change and exits 2
    when something would; `tula apply` asks, then replaces the settings under `If-Match` and
    creates, updates or (with `--prune`) deletes providers, in an order the server accepts.
    `apply` refuses a plan that would reset settings this version does not know
    (`--allow-unknown`) and, with `--yes`, one that weakens security (`--allow-weaker`).
    `--insecure-http` allows a plain http API URL that is not localhost. A key file readable by
    others is warned about, and `--secret-key-file -` is refused at a terminal.
  - `@tula-tech/contract`: `settingsWeakenings()` (the one definition of "weakened", now shared by
    the server's audit entry and the CLI's warning), `SettingsManagedBySchema`, and the headers
    `x-tula-managed-by` / `x-tula-config-hash` with which a replace records the tool and config
    that manage an environment's settings. `GET /v1/admin/settings` answers `managedBy`
    (additive; `null` when nobody manages them), with `drifted` once they are changed around
    the file.
- d013691: The server side of the dashboard (ADR 0032).
  
  - `@tula-tech/contract`: the dashboard's header names (`DASHBOARD_HEADER`, `DASHBOARD_HEADER_VALUE`,
    `ENVIRONMENT_HEADER`) and cookie name (`DASHBOARD_SESSION_COOKIE`) in `@tula-tech/contract/headers`;
    the `instance_admin` audit actor; `INSTANCE_ACTIVITY_TYPES` and `INSTANCE_AUDIT_TARGET_TYPES`
    for the instance audit log.
  - `@tula-tech/admin`: the admin client gains `listUserSessions` and `revokeUserSession`, and the
    audit log's `actorType`, `from` and `to`; the instance client gains workspaces, projects,
    environments and the instance audit log. Both still take the secret key and the instance
    admin token: the dashboard's cookie session is a browser's and is not part of this package.
- f3216d0: A device-binding option on a session profile
  ([docs/device-binding.md](../docs/device-binding.md), ADR 0043): `deviceBinding` is `none`,
  `optional` or `required`. Under `required` a native app that starts a sign-in without a
  device key is refused; under `none` one that brings a key is. Browsers are not affected by
  any value. The default is `none` for the `web` profile and `optional` for every other, which
  is how sessions behaved before. A change applies to new sign-ins only.
  
  - `@tula-tech/contract`: `DeviceBindingPolicySchema`, `DeviceBindingPolicy`,
    `defaultDeviceBinding(name)` and `WebSessionProfileSchema`; `deviceBinding` on a session
    profile; the error code `device.binding_required` (400); `deviceBound` on `SessionSchema`
    (the session lists); and `settingsWeakenings` lists
    `sessions.profiles.<name>.deviceBinding` when a profile asks less for a key.
  - `@tula-tech/core`: the message of `device.binding_required`, which never ends the local
    session; `session.list()` entries carry `deviceBound`.
  - `@tula-tech/react`: `<UserProfile>` marks a session that is bound to a device key, in words
    (`userProfile.deviceBound`).
  - `@tula-tech/admin`: the generated types carry the option, the code and `deviceBound`.
  - `@tula-tech/config`: `deviceBinding` on a profile in `tula.config.ts`. Left out, it is the
    profile's default and is not part of the file's hash.
  - `@tula-tech/cli`: `tula diff` shows the option and flags a profile that asks less as
    `! weakens security`; `tula apply --yes` refuses that without `--allow-weaker`.
  - `@tula-tech/mcp`: `list_user_sessions` returns `deviceBound` (a yes or no, never a key) and
    `get_settings` a profile's `deviceBinding`.
- 75b1b36: Device binding on refresh ([docs/device-binding.md](../docs/device-binding.md), ADR 0043): a
  session of a client that is not a browser can be bound, when its sign-in starts, to a key
  the client holds. Every refresh of such a session then needs a DPoP proof (RFC 9449) signed
  by that key. A refresh without one is refused and changes nothing: the session is not ended
  and no token is rotated. A session that is not bound behaves as before.
  
  - `@tula-tech/contract`: a new Zod-free entry point, `@tula-tech/contract/device-binding`
    (`DPOP_HEADER`, `DPOP_NONCE_HEADER`, `DPOP_PROOF_TYPE`, `DPOP_ALGORITHMS`,
    `MAX_DPOP_PROOF_LENGTH`, `DeviceKey`, `DevicePublicJwk`, `createDpopProof`,
    `jwkThumbprint`, `isDevicePublicJwk`, `isKeyThumbprint`, `generateSoftwareDeviceKey`);
    the error codes `device.proof_invalid` (401), `device.nonce_required` (400) and
    `device.binding_not_supported` (400); the optional `cnf: { jkt }` on
    `AccessTokenClaimsSchema`; the event type `session.refresh_proof_refused`; and the
    optional `deviceBound` on `session.created`.
  - `@tula-tech/core`: `createTulaClient({ deviceKey })` binds the client's sessions. The client
    sends a proof when it starts a sign-up, a sign-in or a reset and at every refresh, keeps
    the server's nonce and repeats a request once when asked for a fresh one, inside the same
    deadline. A refresh refused for its proof does not sign the client out. `DeviceKey`,
    `DevicePublicJwk` and `generateSoftwareDeviceKey` are exported; a key whose `sign` throws
    is the client-side code `device.key_failed`. A `web` client cannot be given a key.
  - `@tula-tech/admin`: the generated types carry the new event type, `deviceBound` and `cnf`.
- 9d2a864: An email address for an account that has none, and the accounts a provider's removal locks
  out (ADR 0059).
  
  - The error code `email.already_set` (409): the account already has an address.
  - The activity `user.email_added` (`method`: `self` or `admin`; `verified`), with its
    schema and fixture.
  - Two email kinds, `email_in_use` (what an address that already has an account is sent
    instead of a code) and `email_added` (the notice to the address that was added).
  - `OAuthProviderDependentsSchema` (`{ provider, accounts, more }`) and
    `DEPENDENT_ACCOUNTS_SCAN_LIMIT`: how many accounts could not sign in without a provider.
    A number and a boolean, never who.
  - `oauthProviderWeakenings` now also takes `enabled` and the counted `dependents`, and
    names `enabled` when a provider that accounts depend on is switched off or removed.
    `oauth_provider.updated` and `.deleted` gain `dependentAccounts` and
    `dependentAccountsIncomplete`.
  - The OpenAPI document gains `requestEmailAddressCode`, `verifyEmailAddress`,
    `setUserEmail` and `getOAuthProviderDependents`.
- 4e15bd1: Signing in by email: a 6-digit code, a link that works only in the browser that asked for it,
  and sign-up without a password.
  
  - `@tula-tech/contract`: `EnvironmentSettings` gains `signIn.methods.emailCode` and
    `signIn.methods.emailLink` (both off by default; `emailLink` needs `emailCode`) and
    `signUp.password` (`required` by default, or `optional`, which needs `emailCode`).
    `ClientConfig` gains `signUp.password`. The `needs_first_factor` step gains an optional
    `prepared: { strategy, destination }`, `FlowAttempt` an optional `linkBinding`, and
    `SignUpRequest.password` becomes optional. New request shapes `FirstFactorPrepareRequest`,
    `FirstFactorAttemptRequest`, `EmailLinkRequest` and `EmailLinkResult`; new error codes
    `verification.different_browser` (409) and `request.redirect_not_allowed` (400); and
    `EMAIL_LINK_TOKEN_PARAM` / `EMAIL_LINK_ATTEMPT_PARAM` in the Zod-free `/headers` entry point.
    All additive: documents saved earlier read with the new methods off.
  - `@tula-tech/core`: sign-in flows gain `prepareFirstFactor`, `attemptFirstFactor`,
    `waitForEmailLink` (polling with cancellation, nudged across tabs, obeys `Retry-After`) and
    `discard`; `signIn.canUseEmailLink()` and `signIn.handleEmailLink()` for the page a link
    leads to; `signUp.start` takes an optional password. An emailed link's binding is kept in
    `localStorage` (it is not a token; see the README's security notes), and the link's token is
    read from the URL fragment and removed from the address before anything is sent. A link's
    page must be on the origin that asks: another origin is refused locally with the new client
    code `link.cross_origin`.
  - `@tula-tech/react`: `<SignIn>` draws the emailed code and link and lets the user switch between
    the methods on offer (new prop `emailLinkUrl`, also on the provider); `<SignUp>` marks the
    password optional where the environment says so; new `<EmailLinkCallback>` and
    `useEmailLinkCallback()` for the landing page; `useSignIn` gains the matching actions. New
    element names `alternatives` and `waiting`, and new localization keys under `signIn`,
    `signUp` and `emailLink`.
- bce497c: Email templates: an environment's own subject and wording for each email
  (`emails.templates` in the settings, keyed by the kind of message).
  
  - `@tula-tech/contract` gains the kinds, the placeholders and the rules of each kind
    (`EMAIL_TEMPLATE_KINDS`, `EMAIL_TEMPLATE_PLACEHOLDERS`, `EMAIL_TEMPLATE_RULES`), the
    checks (`emailTemplateProblems`, `readsAsLink`, `parseEmailTemplate`) and the schemas
    (`EmailTemplateSchema`, `EmailTemplatesSchema`, `EmailSettingsSchema`). The settings
    document has a new section, `emails`, with no template by default: an environment that
    has saved nothing sends the email it always did.
  - A template is text with `{{name}}` placeholders. One that lacks the code or the link its
    message needs is refused when saved, and so is one of any kind that holds something that
    reads as a link, an address or a domain name (`EMAIL_LINK_SCHEMES`): the only link in an
    email is the server's own. A security notice can be given no code and no link, its
    subject cannot start with a digit (`EMAIL_TEMPLATE_DIGIT_PLACEHOLDERS`), and it always ends
    with the server's own facts and its own sentence of what to do if the reader did not do
    what the notice reports. A text-direction control, a private-use or unassigned character
    and a lone surrogate are refused (`hidden_character`), never stripped.
  - `app.name` is refused, when it is set, if it holds a text-direction control, a
    private-use or unassigned character or half a surrogate pair. A name already stored is
    still read.
  - `@tula-tech/config` accepts `settings.emails.templates`, validated when the file is loaded. A
    file with no template hashes as before.
  - `tula diff` shows a template field by field (`emails.templates.<kind>.subject`), and
    `tula apply` removes the template of a kind the file leaves out, as for every setting.
  - `@tula-tech/admin`'s settings types include the section.
- ac05f56: Apple's and Google's own sign-in sheets, a session bound to a device key, and a config
  plugin in an Expo app ([docs/expo.md](../docs/expo.md), ADR 0052). **None of it has been
  run on a device, a simulator or in Expo Go**: no provider's sheet was shown, no key was
  made in a phone's secure hardware, none of the three native modules was installed, and
  Expo never ran the plugin. All of it is tested with stand-ins
  (`docs/plans/phase-2-unverified.md`).
  
  `@tula-tech/contract`:
  
  - `DeviceKey.proofId?()` (`@tula-tech/contract/device-binding`): a key may bring the id of its
    proofs, for a runtime with no `crypto.getRandomValues`. Left out, nothing changes.
  
  `@tula-tech/core`:
  
  - `Environment.deviceKey` (`DeviceKeySource`): for a runtime that finds its key by a call
    that takes time, the transport asks for the key before each request a key proves, and
    `undefined` means "send this one without a proof". A source that throws is
    `device.key_failed`. Finding the key and signing with it are inside the call's
    deadline: a key store that never answers is `network.timeout`, with nothing sent. `createTulaClient({ deviceKey })` is unchanged.
  
  `@tula-tech/expo`:
  
  - `createTulaExpoClient({ apple, google, deviceKeys })`, all optional. `@tula-tech/expo/apple`
    (`appleSheet`, over `expo-apple-authentication`), `@tula-tech/expo/google` (`googleSheet(ids)`,
    over `react-native-nitro-google-signin` 2.3 or later; a development build, and the
    import throws in Expo Go) and `@tula-tech/expo/device-key` (`hardwareDeviceKeys`, over
    `@pagopa/io-react-native-crypto` 1.2.5 or later; a development build) are adapters, each
    an entry point with an optional peer.
  - `useSignIn().withIdToken({ provider })` and, outside a component,
    `signInWithIdToken(client, { provider })`: the sheet is shown between the two steps of
    `@tula-tech/core`'s `signIn.withIdToken`. For Apple the package hands the sheet the SHA-256 of
    the server's nonce and passes the sheet's name on beside the token. A dismissed sheet
    sets `dismissed` and never `error`; one sheet of any kind at a time (`flow.busy`).
  - `useIdTokenProviders()`: `{ google, apple }`, `false` until the sheet is known to be
    there, so a control is hidden where the native module or the sign-in is missing.
  - With `deviceKeys`, a session is bound to a key the device keeps and every refresh
    carries a proof. A stored session whose key is gone (a new key, another key, no key
    store) is dropped when the app starts, with no request: the user signs in again. A
    token is marked as bound only when the server's answer says it is, and a key is made
    only after the key store said "not found" twice. A key
    store that cannot be reached is `storage.failed` and the session is kept. `deviceKey`
    is still refused as an option: an app hands over a key store (`DeviceKeyStore`).
  - `@tula-tech/expo/plugin`: `withTula(config, props)` adds Associated Domains, app-link intent
    filters, the Sign in with Apple entitlement and Google's client ids to an Expo
    configuration, and `reversedGoogleClientId(iosClientId)`. It writes no native file.
  - `flowScreen(step, ways)`: a provider counts as a way for a client with a browser or
    with that provider's sheet.
- f686a47: First prerelease of the contract and the headless client.
  
  - `@tula-tech/contract`: the API's schemas, flow protocol, error codes, token claims and password
    policy, with Zod-free entry points (`/error-codes`, `/headers`, `/password-rules`) for clients.
  - `@tula-tech/core`: `createTulaClient` with server-driven sign-up, sign-in and password-reset flows,
    session management with single-flight token refresh (its own 8-second timeout and one immediate
    retry when no answer comes, both inside the server's reuse grace period), validated responses, and typed errors.
- 48d9bea: Hooks: an environment can register an endpoint the server asks before a sign-up creates an
  account (`/v1/admin/hooks`, [docs/hooks.md](../docs/hooks.md)). The contract gains the hook's
  schemas, its question (`HOOK_QUESTION_SCHEMAS`, `HOOK_QUESTION_FIXTURES`) and answer
  (`HookAnswerSchema`), `hookWeakenings`, the event types `hook.created`, `hook.updated` and
  `hook.deleted`, the optional `hookBypassed` on `user.created`, and the error codes
  `hook.denied`, `hook.unavailable` and `hook.url_not_allowed`. `@tula-tech/admin` gains
  `verifyHook`, `TulaHookQuestion` and `TulaHookAnswer`, and the typed operations
  `createHook`, `listHooks`, `getHook`, `updateHook` and `deleteHook`. `@tula-tech/core` carries the
  three new codes and their messages: 50 bytes gzipped, and its bundle budget moved from 15,500
  to 15,550 bytes with them.
- 2dce8af: A hook's read answer says what its recent calls came to
  ([ADR 0035](../docs/adr/0035-hooks.md#2026-10-12-recent-outcomes-tula-67),
  [docs/hooks.md](../docs/hooks.md)). The server counts every call of a hook, by the hour,
  as `allowed`, `denied`, `failed` or `timed_out`, and `GET /v1/admin/hooks` (and every other
  answer that carries a hook) has `recentOutcomes`: the four counts of the current hour and
  the 23 before it, where the window starts, when the hook was last asked and what that call
  came to. A count is written after the sign-in was answered and is not waited for, so it
  may land a moment later, and a server killed hard loses the ones on their way.
  `lastCallAt` is the time of the latest sign-in or sign-up that asked the hook, to the
  millisecond, and is answered by the admin API only. Counts
  only: no call is kept by itself, and nothing of a question or of an answer but which of
  the four it was. `lastFailedAt` and `lastFailureReason` are unchanged.
  
  **`@tula-tech/contract`**: `HOOK_OUTCOMES`, `HookOutcome`, `HOOK_OUTCOME_WINDOW_HOURS`,
  `hookFailureOutcome(reason)`, `hookLastCallFailed(lastOutcome)` (whether the most recent
  call failed or timed out; it does not say a hook is failing now, the call may be up to a
  day old), `HookRecentOutcomesSchema`, and the
  required `recentOutcomes` of `HookSchema`.
  
  **`@tula-tech/admin`**: the generated type of a hook has `recentOutcomes`. A server from before
  this change does not send it.
  
  The dashboard's Hooks screen shows the counts and what the most recent call came to, with
  when it was ("Last call failed", never "failing now"). `@tula-tech/cli` and `@tula-tech/mcp` are unchanged: neither reads the field.
- c760b08: Hooks before a session and before a token ([docs/hooks.md](../docs/hooks.md)). An
  environment can register two more hooks: `before_session`, asked once every factor of a
  sign-in is proven and able to refuse it, and `before_token`, which answers with claims that
  are issued under `ext` of the session's access tokens. The contract gains the two points
  (`HOOK_POINTS`), their questions (`HookBeforeSessionDataSchema`,
  `HookBeforeTokenDataSchema`, in `HOOK_QUESTION_SCHEMAS` and `HOOK_QUESTION_FIXTURES`), the
  claims answer (`HookClaimsAnswerSchema`, `readHookClaimsAnswer`), the failure reasons
  `claims_invalid` and `claims_too_large`, `checkCustomClaims` in `@tula-tech/contract/custom-claims`,
  and the optional `hookBypassed` and `claimsHookBypassed` on `session.created` and
  `claimsHookBypassed` on `session.stepped_up`. `@tula-tech/admin`'s `verifyHook` accepts the two new
  questions, `TulaHookQuestion` is a union to narrow on `type`, and `TulaHookClaimsAnswer` is
  the answer of a claims hook. No error code is added: `hook.denied` and `hook.unavailable`
  now answer a refused sign-in too, and their messages no longer say "sign-up" ("This was not
  allowed.", "This is unavailable right now. Try again later."), which is the whole change to
  `@tula-tech/core`.
- 0de4f8d: JWT templates: an environment can add custom claims to its sessions
  ([docs/jwt-templates.md](../docs/jwt-templates.md), ADR 0036). A template is a named set of
  claims under `sessions.jwtTemplates`, each read from a closed list of sources (the user's
  address, whether it is verified, when the account and the session began, the client kind) or a
  constant; a session profile names the one it uses (`jwtTemplate`). The claims are issued under
  the one claim `ext` of the access token, and in what the server answers for a stateful
  session. A token of a profile without a template is unchanged.
  
  - `@tula-tech/contract`: `JwtTemplateSchema`, `JwtTemplateClaimSchema`, `JWT_TEMPLATE_SOURCES`,
    `jwtTemplateMaxBytes`, `readStoredJwtTemplate`, `jwtTemplateOfProfile`,
    `isSessionProfileName` (the one rule for a profile's and a template's name), the optional `ext`
    on `AccessTokenClaimsSchema`, and `settingsWeakenings` reports
    `sessions.profiles.<name>.jwtTemplate` when a profile's sessions lose a claim or get a
    redefined one. A new Zod-free entry point, `@tula-tech/contract/custom-claims`:
    `CUSTOM_CLAIMS_CLAIM`, `RESERVED_CLAIM_NAMES`, the caps (`MAX_CUSTOM_CLAIMS_BYTES` and
    others), `isCustomClaimKey`, `isCustomClaimValue`, `customClaimsBytes` and
    `readCustomClaims`.
  - `@tula-tech/nextjs`: `auth()` returns `customClaims` (a read-only record of `unknown` values;
    empty when signed in with none, `null` when signed out), for token and stateful sessions
    alike, and `SessionClaims` gains the optional `ext`. An `ext` that is not what Tula issues
    is treated as absent.
  - `@tula-tech/admin`: the settings types carry `jwtTemplates` and a profile's `jwtTemplate`.
  - `@tula-tech/config`: both are part of `settings`. An environment without templates keeps the
    fingerprint it had.
  - `@tula-tech/cli`: `tula diff` compares templates by name and their claims by key, shows a changed
    claim as one value, and reports a profile whose sessions would lose claims as weaker, which
    `tula apply --yes` refuses without `--allow-weaker`.
- ea7f074: Two-step verification: an authenticator app (TOTP), backup codes, step-up and a policy per
  environment.
  
  - `@tula-tech/contract`: new flow step `needs_factor_enrolment { methods }` and request shape
    `SecondFactorRequest`; `FlowAttempt` gains the optional `backupCodes` and
    `backupCodesRemaining`. New `Factors`, `TotpEnrolment`, `TotpConfirmRequest`, `BackupCodes`,
    `StepUpRequest` and `StepUpMethod`. Access-token claims gain `auth_time` (when the user last
    proved a factor for the session; refreshing does not move it) and `amr` (what they proved:
    a set, whose order is not part of the contract), with `AUTHENTICATION_METHODS` and
    `STEP_UP_MAX_AGE_SECONDS`. `EnvironmentSettings` gains `mfa.policy` (`off`, `optional` by
    default, `required`) and `notifications.mfaChanged`; `ClientConfig` gains the optional
    `mfa.policy`. New error codes `mfa.invalid_code`, `mfa.already_enabled`, `mfa.not_enabled`,
    `mfa.enrolment_expired`, `mfa.not_available`, `mfa.required_by_policy` and
    `auth.step_up_required` (its `params.methods` is a comma-separated list). New activity types
    `user.mfa_enabled`, `user.mfa_disabled`, `user.backup_codes_regenerated`,
    `user.backup_code_used` and `session.stepped_up`. All additive.
  - `@tula-tech/react`: `<SignIn>` (also after a password reset) and `<SignUp>` draw the second
    factor (authenticator code or a backup code) and, where the environment requires it, the
    enrolment inside the flow. `<UserProfile>` gains a "Two-step verification" section: turn on
    with a QR code and the setup key, backup codes with copy, download and an explicit
    confirmation, new codes, turn off. New hook `useStepUp()` runs a sensitive action and, when
    the API asks, opens the provider's step-up dialog and retries. `useSignIn`, `useSignUp` and
    `useResetPassword` gain `submitSecondFactor`, `startTotpEnrolment` and
    `confirmTotpEnrolment`. New element names (`modal`, `qrCode`, `secret`, `backupCodes`,
    `backupCode`, `checkbox`) and strings (`mfa`, `stepUp`). The QR code is drawn by the package
    itself, in a chunk loaded on demand; the build now emits that chunk beside `index.js`.
- 784639a: Native app identity ([docs/native-apps.md](../docs/native-apps.md)). An environment
  registers its iOS apps (a team ID and a bundle ID) and Android apps (a package name and the
  SHA-256 fingerprints of its signing certificates) through `/v1/admin/native-apps`, and the
  server serves Apple's `apple-app-site-association` and Android's `assetlinks.json` for it
  under `/v1/environments/<id>/.well-known/`. The files name the apps for the domain's
  credentials only (`webcredentials`, `get_login_creds`); they hand an app no link.
  
  `@tula-tech/contract` gains the schemas, the identifier patterns and caps, the two file builders
  (`appleAppSiteAssociation`, `assetLinks`), `nativeAppWeakenings` and three event types
  (`native_app.created`, `native_app.updated`, `native_app.deleted`). `@tula-tech/admin` gains the
  typed operations. `@tula-tech/config` takes `nativeApps` on an environment and exports
  `NativeAppConfig`, `IosAppConfig` and `AndroidAppConfig`; an environment without the key is
  not read, not changed and keeps its fingerprint. `tula diff` plans them (an app is its
  platform and its identifier) and marks as weaker an app registered, an iOS app's changed
  team and a gained fingerprint; `tula apply --yes` refuses such a plan without
  `--allow-weaker`, writes native apps last, and `--json` gains `nativeApps`.
- 095a866: Native Sign in with Apple by identity token
  ([docs/native-apps.md](../docs/native-apps.md#signing-in-with-apple-without-a-browser),
  ADR 0047).
  
  - `@tula-tech/contract`: `ID_TOKEN_PROVIDERS` gains `apple`. Which client kinds may start the
    sign-in is per provider (`ID_TOKEN_CLIENT_KINDS`: `ios` and `android` for Google, `ios`
    alone for Apple), and `takesAdditionalClientIds` says which provider has
    `additionalClientIds` (Google alone). The exchange's body
    (`IdTokenExchangeRequestSchema`) may carry `givenName` and `familyName` beside the token
    (`MAX_ID_TOKEN_NAME_LENGTH`), read for Apple only.
  - `@tula-tech/core`: `signIn.withIdToken({ provider: 'apple' })` for an `ios` client, and
    `exchange(idToken, name?)`, which passes on the name the Sign in with Apple sheet gave
    the app (`IdTokenName`). The client does not hash the nonce: an app hands the sheet the
    lowercase hexadecimal SHA-256 of `nonce`.
  
  **For an operator.** A native Apple token is accepted for the bundle ID of an iOS app the
  environment has registered. An environment that already has a registered iOS app **and**
  Apple enabled accepts such tokens for that app once the server is upgraded, with no new
  setting.
- 1f189d8: Native sign-in with Google's ID token
  ([docs/native-apps.md](../docs/native-apps.md#signing-in-with-google-without-a-browser),
  ADR 0045).
  
  - `@tula-tech/contract`: the two requests of the sign-in (`IdTokenStartRequestSchema`,
    `IdTokenStartSchema`, `IdTokenExchangeRequestSchema`, `ID_TOKEN_PROVIDERS`,
    `MAX_ID_TOKEN_LENGTH`). A provider's settings have `additionalClientIds`
    (`AdditionalClientIdsSchema`, `isGoogleClientId`, `MAX_ADDITIONAL_CLIENT_IDS`): the
    client ids, beside the provider's own, whose ID tokens are accepted. Google only, and
    never the provider's own `clientId` (`ownClientIdAmong`; the admin API and
    `@tula-tech/config` refuse it). A
    gained one is a weakening (`oauthProviderWeakenings`); `oauth_provider.updated` may name
    the field in `changed` and carry `additionalClientIdCount`.
  - `@tula-tech/core`: `signIn.withIdToken({ provider: 'google' })` for an `ios` or `android`
    client. It answers the server's nonce and an `exchange(idToken)` that returns the flow.
    The start carries a device proof when the client has a device key.
  - `@tula-tech/admin`: the generated types have `additionalClientIds` on a provider and on its
    update body.
  - `@tula-tech/config`: `providers.google.additionalClientIds` (`GoogleProviderConfig`). Left out
    means none. A file that names none keeps its fingerprint.
  - `@tula-tech/cli`: `tula diff` and `tula apply` plan Google's `additionalClientIds` as a set.
    The file's list is the whole set; a gained id is `providers.google.additionalClientIds`
    and needs `--allow-weaker` under `--yes`. A `ProviderChange` has `weakened`.
  - `@tula-tech/mcp`: `list_oauth_providers` returns `additionalClientIds`.
- 1b61d3e: `androidApkKeyHashOrigin(fingerprint)` and `ANDROID_APK_KEY_HASH_PREFIX`: the origin an
  Android app's passkey response carries (`android:apk-key-hash:` and the SHA-256 fingerprint
  of its signing certificate as base64url without padding), from a fingerprint in either
  spelling; `null` for a value that is not one. The API accepts a passkey response from a
  registered native app by that origin (Android) or by `https://<rpId>` (iOS, once an iOS app
  is registered and the environment's `urls.allowedOrigins` lists that origin), for a request
  with no `Origin` that says `x-tula-client: ios` or `android`.
- c04622e: `@tula-tech/nextjs`: Tula for the Next.js App Router (ADR 0029).
  
  - `@tula-tech/nextjs/handlers`: `createTulaHandlers()`, a catch-all route handler that stands in
    for the API's `/v1/client/*` on the app's own origin. The browser's client talks to it and
    never to the API's host, so the refresh cookie, a `stateful` session's cookie and a new
    access-token cookie are first-party, `HttpOnly` cookies of the app. It forwards the
    browser's `Origin` unchanged, refuses requests that do not come from the app's own pages,
    never forwards the admin API and never follows a redirect. It trusts no forwarding header
    by default: the visitor's address reaches the API only with `trustedProxyHops`
    (`TULA_TRUSTED_PROXY_HOPS`) or `clientIp`. A sign-in replaces the browser's session
    whatever its kind, and request bodies and JSON answers are capped at 1 MiB.
  - `@tula-tech/nextjs/middleware`: `tulaMiddleware()` for `proxy.ts` (Next.js 16) or `middleware.ts`
    (Next.js 15). Verifies the access token offline against the environment's JWKS, refreshes it
    once through the API when it is missing or expiring, protects routes by matcher and
    redirects to sign-in with a same-origin `redirect_url` (`safeRedirectPath`). It clears the
    cookies only when the API says the session is over; a refusal caused by the app's own
    configuration (origin, key) keeps them and is reported once (`onWarning`).
  - `@tula-tech/nextjs` refuses a configuration that would send the secret key (`stateful` session
    profiles) to a plain `http:` `apiUrl` that is not this machine; `allowInsecureHttp`
    (`TULA_ALLOW_INSECURE_HTTP=true`) allows it on a private network you trust.
  - `@tula-tech/nextjs/server`: `auth()`, `currentUser()` and `getToken()` for Server Components,
    Route Handlers and Server Actions.
  - `@tula-tech/nextjs`: `<TulaProvider>` for the App Router (takes the server's `initialState`, so
    the first paint is right) and every `@tula-tech/react` component and hook, marked `'use client'`.
  - `@tula-tech/contract/issuer`: `environmentIssuer` and `jwksUrl` as a Zod-free entry point (still
    exported from the index).
  - `@tula-tech/core`: `TulaClient` has an optional `serverState`, set by a framework integration.
    `@tula-tech/react` renders it during server rendering and hydration instead of `loading`.
- d72fb3d: Sign in with Discord and LinkedIn.
  
  - `@tula-tech/contract`: `discord` and `linkedin` in `OAUTH_PROVIDERS`; the first-factor
    strategies `oauth_discord` and `oauth_linkedin`, which are also `user.created` methods and
    `HOOK_SIGN_UP_METHODS`, so a `before_sign_up` hook may be asked with either `method`. Each
    takes `clientId` and `clientSecret`, like Google and GitHub.
  - `@tula-tech/core` and `@tula-tech/admin`: the generated types carry the two providers and
    strategies. No run-time change.
  - `@tula-tech/react`: "Continue with Discord" and "Continue with LinkedIn" buttons on `<SignIn>`
    and `<SignUp>`, and both names under "Connected accounts". The marks are drawn inline;
    nothing is fetched. They were drawn without either brand page open: check them against
    Discord's and LinkedIn's brand guidelines before shipping.
  - `@tula-tech/config`: `providers.discord` and `providers.linkedin` (`clientId`,
    `clientSecret: env('NAME')`).
  - `@tula-tech/cli`: `tula diff` and `tula apply` manage both.
  
  LinkedIn's sign-in has no PKCE and no nonce (LinkedIn documents neither). The account is the
  `sub` of the verified ID token; the address and whether it is verified are read from
  LinkedIn's userinfo endpoint. See `docs/providers/linkedin.md` before offering it.
- 07eff2f: Sign in with Microsoft (Entra ID work and school accounts, and personal accounts).
  
  - `@tula-tech/contract`: `microsoft` in `OAUTH_PROVIDERS`; the first-factor strategy
    `oauth_microsoft`; `MicrosoftTenantSchema`, `MicrosoftTenant` and
    `MICROSOFT_TENANT_ALIASES`; `tenant` on `OAuthProviderUpdate` (required for Microsoft:
    `common`, `organizations`, `consumers` or a tenant id; a domain name is refused) and, as
    `string | null`, on `OAuthProviderSettings`; `oauth_microsoft` as a `user.created` method
    and `tenant` as a name in `oauth_provider.updated.changed`; `oauth_microsoft` among
    `HOOK_SIGN_UP_METHODS`, so a `before_sign_up` hook may be asked with that `method`.
  - `@tula-tech/core` and `@tula-tech/admin`: the generated types carry the new provider, strategy and
    field. No run-time change in `@tula-tech/core`.
  - `@tula-tech/react`: a "Continue with Microsoft" button on `<SignIn>` and `<SignUp>` and
    "Microsoft" under "Connected accounts". The mark is drawn inline; nothing is fetched.
  - `@tula-tech/config`: `providers.microsoft` (`clientId`, `clientSecret: env('NAME')`, `tenant`)
    and the type `MicrosoftProviderConfig`.
  - `@tula-tech/cli`: `tula diff` and `tula apply` manage Microsoft and its `tenant`. A change of
    tenant keeps the stored secret, as switching a provider on or off does.
  - `@tula-tech/mcp`: `list_oauth_providers` returns each provider's `tenant`.
  - `create-tula`: the scaffold's comments about the mock provider no longer list the
    providers by name.
- 82d87eb: Sign in with X and Facebook, and accounts with no email address.
  
  Neither provider is asked for an email address, so a first sign-in with either makes an
  account that has none. **`User.email` is now `string | null`** in the contract and in every
  generated type: code that reads a user's `email` has to allow for `null`. The same holds
  for the `before_sign_up` hook's question (`data.email`).
  
  - `@tula-tech/contract`: `x` and `facebook` in `OAUTH_PROVIDERS`; `OAUTH_PROVIDERS_WITHOUT_ADDRESS`
    and `givesNoAddress(provider)`, the one place that says which providers give no address;
    the strategies `oauth_x` and `oauth_facebook`, which are also `user.created` methods and
    `HOOK_SIGN_UP_METHODS`. `UserSchema.email` and `HookBeforeSignUpDataSchema.email` are
    nullable.
  - `@tula-tech/core` and `@tula-tech/admin`: the generated types carry the two providers, the two
    strategies and the nullable `email`. No run-time change. `verifyHook`'s examples check
    the address for `null`.
  - `@tula-tech/react`: "Continue with X" and "Continue with Facebook" buttons on `<SignIn>` and
    `<SignUp>`, and both names under "Connected accounts". The marks are drawn inline and
    were not checked against X's or Meta's brand guidelines. `<UserButton>` and
    `<UserProfile>` draw a user with no address by name, with no address line, no
    verification badge and no password section.
  - `@tula-tech/nextjs`: `currentUser()` may return a user whose `email` is `null`.
  - `@tula-tech/config`: `providers.x` and `providers.facebook` (`clientId`,
    `clientSecret: env('NAME')`; for Facebook the app id and the app secret).
  - `@tula-tech/cli`: `tula diff` and `tula apply` manage both.
  - `@tula-tech/mcp`: `get_user` and `list_users` return `email: null` for such a user; the
    scaffolds greet a user who has neither a first name nor an address.
  - `create-tula`: the app templates do the same.
  
  An account with no address gets no security emails, cannot sign in by emailed code or link,
  cannot have a password, and cannot be given an address yet. Switching its provider off,
  or removing the provider's credentials, locks it out until the provider is configured
  again, and nothing warns first. A JWT template's `user.email` and `user.email_verified`
  claims are both left out of its tokens (absent, not `false`); `user.created` still says
  `emailVerified: false` for it. Facebook's sign-in has no PKCE
  and no nonce (Meta documents neither for this flow). What X charges for the API call a
  sign-in makes was not confirmed. See `docs/providers/x.md` and `docs/providers/facebook.md`
  before offering either.
- fc7d990: Sign in with Google, GitHub and Apple, with an environment's own OAuth credentials.
  
  - `@tula-tech/contract`: new `OAuthProvider`, `OAuthStartRequest`, `OAuthStart`,
    `OAuthExchangeRequest`, `Identity`, `IdentityList`, `IdentityLinkStart`,
    `OAuthProviderSettings` and `OAuthProviderUpdate`; error codes `oauth.access_denied`,
    `oauth.provider_error`, `oauth.state_invalid`, `oauth.ticket_invalid`,
    `oauth.different_browser`, `oauth.email_missing`, `oauth.email_unverified`,
    `oauth.account_exists`, `oauth.identity_in_use`, `oauth.already_linked` and
    `identity.last_sign_in_method`; `ClientConfig.signIn.oauth`; the setting
    `notifications.identityChanged`; the fragment parameters `OAUTH_TICKET_PARAM` and
    `OAUTH_ERROR_PARAM`. **Changed:** the settings schema no longer refuses a document with
    every sign-in method off (the server does, unless an OAuth provider is enabled);
    `hasEnabledSignInMethod` and `AT_LEAST_ONE_SIGN_IN_METHOD` are exported for that check.
  - `@tula-tech/core`: `signIn.withOAuth`, `signIn.handleOAuthCallback`, `signIn.canUseOAuth` and
    `user.identities.{list, link, unlink}`. The round trip's binding is kept in
    `sessionStorage` for the tab; no token is.
  - `@tula-tech/react`: "Continue with …" buttons on `<SignIn>` and `<SignUp>`, `<OAuthCallback>` and
    `useOAuthCallback()`, "Connected accounts" in `<UserProfile>`, the `oauthCallbackUrl` option,
    new localization strings (`oauth`, and seven under `userProfile`) and element names
    (`oauthButtons`, `oauthIcon`, `divider`, `identityList`, `identityItem`).
- 596b4cd: Passkeys (WebAuthn): registration, usernameless sign-in, second factor and step-up.
  
  - `@tula-tech/contract`: the `passkey` schemas (`Passkey`, creation and request options, the
    browser's registration and assertion responses, the register, rename and sign-in requests),
    `signIn.methods.passkey` and `passkeys.rpId` in the environment settings (with
    `isRelyingPartyId` and `originMatchesRelyingParty`), `passkey` as a second-factor proof and a
    step-up method, the `amr` values `hwk`, `swk` and `user`, the audit actions
    `user.passkey_*`, and the error codes `passkey.registration_failed`,
    `passkey.already_registered`, `passkey.limit_reached` and `passkey.last_sign_in_method`.
    `CAN_STILL_SIGN_IN_HEADER` (`x-tula-can-still-sign-in`, in `@tula-tech/contract/headers`): the
    response header of the admin factor reset, which removes passkeys too and says with it
    whether the user can still sign in (the route keeps answering `204`). Passkey sign-in
    starts have a per-environment ceiling of their own.
  - `@tula-tech/core`: `signIn.canUsePasskey()`, `signIn.canAutofillPasskey()` and
    `signIn.withPasskey({ signal, autofill })`; `flow.submitSecondFactorWithPasskey()` on the
    sign-in and password-reset flows; `session.stepUpWithPasskey()`;
    `user.passkeys.{list,add,rename,remove}`. No dependency: the client calls
    `navigator.credentials` itself. New client codes, all `status: 0`: `passkey.unsupported`,
    `passkey.cancelled`, `passkey.already_on_device` and `passkey.failed`. `stepUpMethods` now
    returns `passkey` where the server lists it.
- 894b927: `password.expiryDays` takes effect: where it is set, a user who signs in with a password
  that was set that many days ago or longer has to choose a new one before the sign-in
  completes.
  
  **Check the setting in every environment, and `PASSWORD_POLICY`, before you upgrade the
  server.** Until now the number was stored and did nothing, and the `legacy` preset has it at
  90. Age is counted from when a password was last set; for the passwords that already exist
  that is the last time their row was written (migration `0029`). A user whose password is
  older than the period is asked for a new one at their next sign-in with it. Nobody is signed
  out and no email is sent. Only a sign-in with the password is affected: an emailed or texted
  code, a link, a passkey and a provider sign in whatever the password's age.
  
  **Upgrade clients before the server.** An app built on a `@tula-tech/react` or `@tula-tech/core` older
  than this release shows "This step is not supported" where the new password is asked for,
  so a user with an expired password cannot sign in through it. Or set `expiryDays` to `null`
  until every client is upgraded.
  
  - `@tula-tech/contract`: the `needs_new_password` step gains an optional `reason`
    (`NewPasswordReasonSchema`: `expired`). With a reason its `strategies` is empty; a
    password reset's step is unchanged. A new operation,
    `POST /v1/client/sign-ins/{attemptId}/new-password` (`submitSignInNewPassword`).
  - `@tula-tech/core`: a sign-in flow gains `submitNewPassword({ password })`, for the step
    `needs_new_password` with `reason: 'expired'`. A refused password (`password.*`) leaves the
    flow on the step.
  - `@tula-tech/react`: `<SignIn>` draws a "Your password has expired" screen for that step, with
    the policy's checklist. Four new strings, under `expiredPassword` in the localization
    table (`title`, `subtitle`, `newPasswordLabel`, `submit`): an app with a complete
    localization of its own adds them.
  - `@tula-tech/nextjs`: its `<SignIn>` is `@tula-tech/react`'s and gains the screen; the route handler
    forwards the new operation like every `/v1/client/*` call.
- 751eae5: `password.history` takes effect: where it is 1 or more, the server refuses, as a user's new
  password, their current password and the ones before it, as many as the number says, in a
  password change and in a reset.
  
  **Check the setting in every environment before you upgrade the server.** Until now the
  number was stored and did nothing, and the `strict` preset has it at 5. The history starts
  empty (migration `0026`): only passwords changed after the upgrade are remembered. Lowering
  the number deletes the stored hashes it no longer covers; raising it brings nothing back.
  
  - `@tula-tech/contract`: the error code `password.reused` (422, `params.history`), and
    `MAX_PASSWORD_HISTORY` (24), the ceiling `history` already had.
  - `@tula-tech/core`: the message of `password.reused`. `user.changePassword` and a reset's
    `submit` can now throw it.
  - `@tula-tech/react` (and `@tula-tech/nextjs`, which has the same components): the checklist under a
    new password on `<UserProfile>` and in the reset of `<SignIn>` lists the rule where the
    policy remembers passwords, as "checked when you save" and, once the server refuses the
    password, as not met; it is never drawn as met. New strings in the localization:
    `password.history`, `password.historyCurrent`, `password.checkedOnSave`. A custom
    localization that is a complete `Localization` object has to add them.
  - `@tula-tech/admin`: the generated types name the new error code. A password an administrator
    sets (`setUserPassword`) is remembered and is not compared with the history.
- 59c2709: A phone number on an account, proven with a texted code (ADR 0037).
  
  - `@tula-tech/contract`: phone numbers as plain data, exported from the index (`parsePhoneNumber`,
    `maskPhoneNumber`, `COUNTRY_CALLING_PREFIXES`, `SMS_COUNTRIES`, `isSmsCountry`,
    `phoneNumberCountries`, `isPhoneNumberAllowed`). A user gains `phoneNumber` and
    `phoneNumberVerifiedAt`. The settings gain `sms` (`enabled`, default `false`;
    `allowedCountries`, default `[]`, where empty means nothing is sent), and the client
    configuration `phone.enabled`. New error codes `phone.invalid`, `sms.disabled`,
    `sms.country_not_allowed` and `sms.unavailable`; new events `user.phone_number_added` and
    `user.phone_number_removed`, whose payload holds no number. New schemas
    `PhoneNumberRequestSchema`, `PhoneCodeSentSchema`, `PhoneNumberVerifyRequestSchema` and
    `SmsCountrySchema`.
  - `@tula-tech/core`: `client.user.phone.request({ phoneNumber })`, `.verify({ code })` and
    `.remove()` for the signed-in user, and the type `PhoneCodeSent`. The answers are checked
    before anything is built from them, and a user is installed only for the session that asked.
  - `@tula-tech/react`: `<UserProfile>` gains a "Phone number" section (add with a texted code,
    change, remove), shown where the environment can text a code or the user has a number.
    New strings under `phone` in the localization table.
  - `@tula-tech/admin`: the generated types know the three operations, the `sms` settings and a
    user's phone fields.
  - `@tula-tech/cli`: `tula diff` and `tula apply` compare `sms.allowedCountries` as a set.
  - `@tula-tech/mcp`: `get_settings` returns `sms`. A user's phone number is not returned by any
    tool.
- 99593eb: An agent can propose three more changes, each of which an administrator can put back with
  one call: lifting a ban (`unban_user`), ending one session by its id (`end_session`) and
  switching one OAuth provider off (`disable_oauth_provider`: `enabled: false`, its
  credentials kept, and refused when it would remove an environment's last way to sign in,
  when it is proposed and again when it is approved). `@tula-tech/mcp` gains
  `propose_unban_user`, `propose_end_session` and `propose_disable_oauth_provider`;
  `tula approve` shows and asks about each in words of its own.
  
  A production environment accepts proposals only where its settings say so: the new
  setting `agents.proposalsInProduction`, off by default. Switching it on is a weakening
  (recorded in the audit log, asked about in the dashboard, and refused by
  `tula apply --yes` without `--allow-weaker`). In `tula.config.ts` the key left out is
  `false`; the default does not change a config's fingerprint.
  
  Proposals are limited to five a minute for each operation, beside the ten a minute an
  environment's agents share. A proposal's `target.id` is a UUID for a user and a session
  and a provider's name for a provider; `failureReason` gains `last_sign_in_method`, and an
  approval can be refused with `production_environment`.
- c97d084: First prerelease of the React SDK.
  
  - `@tula-tech/react`: `TulaProvider`, the hooks (`useAuth`, `useUser`, `useSession`, `useSignIn`,
    `useSignUp`, `useResetPassword`, `usePasswordChecklist`, `useClientConfig`, `useTula`),
    `SignedIn` / `SignedOut` / `TulaLoading`, and the prebuilt `SignIn` (with forgotten
    password), `SignUp`, `UserButton` and `UserProfile`, with one themeable stylesheet
    (`@tula-tech/react/styles.css`), an `appearance` prop and a typed localization table.
  - `@tula-tech/contract`: a Zod-free `/theme` entry point: the theme tokens shared by every front
    end, their light and dark defaults, `themeToCssVariables`, `isValidThemeValue` (theme values
    are validated against a strict grammar and dropped when they do not match) and
    `contrastRatio`.
  - `@tula-tech/core`: a tab waiting for the cross-tab lock now waits for as long as a refresh can
    take with its one retry, so an app with a small `timeoutMs` no longer has two tabs refresh at
    once; `user.get()` no longer installs a user fetched for an earlier session; and a 204's
    empty body is read, so browsers stop listing successful sign-outs as cancelled requests.
- 79bc411: Security notice emails, and a loading-state fix.
  
  - `@tula-tech/contract`: `EnvironmentSettings` gains `notifications: { passwordChanged, newSignIn }`
    (both `true` by default): whether an account's owner is emailed when their password changes
    and when the account is signed in to from a new device. Additive; documents saved earlier
    read as "on".
  - `@tula-tech/react`: `useSession` reports `isLoading: true` for the whole first fetch under
    React's StrictMode. The effect runs twice in development; its second run cleared the flag and
    then joined the first run's request without setting it again.
- 190bb99: Session profiles, the stateful session type and session rules (ADR 0028).
  
  - `@tula-tech/contract`: `sessions` in the environment settings (`SessionSettings`): named
    `profiles` (`web` and `mobile` always; `SessionProfile` now has `type`, `accessTokenTtl`,
    `idleTimeout`, `absoluteTimeout`, `refresh.reuseGracePeriod`, `stepUpAfter`,
    `clientSelectable`, with documented bounds; `accessTokenTtl` may not be longer than
    `idleTimeout`), `maxPerUser` and `onLimit`. Helpers
    `resolveSessionProfile`, `profileOfSession`, `builtInSessionProfile`, `stepUpWindowSeconds`.
    New: the `x-tula-session-profile` header (`SESSION_PROFILE_HEADER`), the error code
    `session.limit_reached`, the access-token claim `sp`, `VerifySessionRequest`
    (`POST /v1/admin/sessions/verify`), `HybridSessionTokens`.
    **Breaking:** `SessionTokens.accessToken` and `accessTokenExpiresAt` are optional (absent
    for a session of a `stateful` profile); `SessionType` is now `hybrid | stateful`;
    `SessionProfile` lost `refresh.rotate`, `refresh.reuseDetection`, `multiSession` and
    `maxConcurrent` (never read by a server), and `IMPLEMENTED_SESSION_TYPES` is gone;
    `refresh.reuseGracePeriod` may be `null`.
  - `@tula-tech/core`: `createTulaClient({ sessionProfile })` asks for a profile. A browser client
    works against a `stateful` profile: it holds no token (`session.getToken()` returns `null`),
    authenticated calls rely on the httpOnly cookie, a refused call signs the client and its
    other tabs out at once, and sign-out is unchanged. `session.limit_reached` has a message.
- 259f896: A sign-in test ([ADR 0058](../docs/adr/0058-test-signin.md)): the setting
  `agents.testSignIn` (`true`, `false` or `null`, the default: on in a development
  environment, off in a production one; writing `true` is a weakening), `testSignInAllowed`,
  the report's schema (`SignInTestReportSchema`) and its closed lists, the reserved address
  of a throwaway user (`testAddress`, `isTestAddress`, `TEST_ADDRESS_DOMAIN`), the activity
  types `sign_in_test.started` and `sign_in_test.finished`, and an optional `test: true` on
  `user.created`. An address in the reserved domain is no longer accepted as a person's.
- 61af5e2: Text messages in the dashboard, and a wider reach of a required texted second step is a
  weakening ([ADR 0025](../docs/adr/0025-mfa.md), [ADR 0037](../docs/adr/0037-phone-numbers-and-sms.md),
  [docs/phone-numbers.md](../docs/phone-numbers.md)).
  
  **`@tula-tech/contract`**
  
  - `settingsWeakenings` lists two more changes, both only where `mfa.smsCode` is on and
    `mfa.policy` is `required` after the change: text messages switched on or a first country
    allowed (`mfa.smsCode`), and a country added where a texted code could already be that
    second step (`sms.allowedCountries`). A save that makes either is recorded with
    `weakened: true`, asked about by the dashboard and refused by `tula apply --yes` without
    `--allow-weaker`. Nothing that was listed before is listed differently.
  - `smsCostLimits(dailyMessageLimit)`, `SMS_PREFIX_HOURLY_SHARE`,
    `SMS_ENVIRONMENT_HOURLY_SHARE` and `SmsCostLimits`: what a daily limit allows in an hour
    in all and to one destination prefix. The server holds a send to this function; it was
    the server's own before.
  - `smsPrefixCountries(prefix)`: every country of the table that a destination prefix covers.
  
  **`@tula-tech/cli`**
  
  - `tula diff` and `tula apply` say in words, under the plan, when it switches off the
    texted code as the second step (`mfa.smsCode` off in the file, or left out of it): users
    whose only second step is a texted code cannot sign in until it is on again or an
    administrator resets them. The plan is as before and is still not a weakening.
  - The same for a plan that takes a country out of `sms.allowedCountries` (the countries are
    named) and for one that switches `sms.enabled` off: users there can no longer receive a
    code. Neither changes the plan or needs a flag.
  - The two new weakenings are in `plan.weakened`.
  
  The dashboard (not published) has a **Text messages** screen: the SMS settings and both
  uses of a texted code on the one save model, whether the deployment has a sender, and the
  codes sent and never used by destination prefix.
- a0377de: A code texted to the account's proven phone number as the second step of a sign-in
  (ADR 0025, "a texted code as the second factor"). Off by default. **Upgrade `@tula-tech/core`
  and `@tula-tech/react` before switching it on**: an older client shows "not supported" at a
  second step whose only option is a texted code.
  
  - `@tula-tech/contract`: the second-factor method `sms_code` (in `SecondFactorMethod`, in a
    step's `options` and its new `prepared` part, and among the step-up methods), the setting
    `mfa.smsCode.enabled` (default off) and `mfa.smsCode` in the client configuration,
    `Factors.sms` (`enabled`, `enabledAt`, `inUse`, `available`), the event types
    `user.sms_factor_enabled` and `user.sms_factor_removed`, the email template kinds
    `sms_factor_enabled` and `sms_factor_removed`, the text message template kind
    `second_factor` (one wording for the three texted second-step codes), and the error codes
    `mfa.needs_other_sign_in` (403), `mfa.sms_not_allowed` (409) and
    `mfa.phone_number_required` (409). `settingsWeakenings` lists `mfa.smsCode` when it is
    switched on where the policy is `required` after the change. A texted code records `sms`
    in `amr` and never `mfa`.
  - `@tula-tech/core`: `tula.mfa.startSms()`, `tula.mfa.confirmSms({ code })` and
    `tula.mfa.disableSms()`; `flow.prepareSecondFactor({ method: 'sms_code' })` on the
    sign-in and password-reset flows, and `submitSecondFactor({ method: 'sms_code', code })`;
    `session.prepareStepUp({ method: 'sms_code' })` and
    `session.stepUp({ method: 'sms_code', code })`. Three more messages in the error table.
  - `@tula-tech/react`: the second-step screen and the step-up dialog gain "Text me a code" (the
    message is asked for with a button, never sent on arrival), and `<UserProfile>` offers,
    confirms and turns off a texted code as the second step. New strings under `mfa`
    (`smsSubtitle`, `smsSend`, `smsOffer`, `smsTurnOn`, `smsStatusOn`, `smsNotInUse`,
    `smsWeaker`, `smsTurnOff`, `smsTurnedOn`, `smsTurnedOff`), `stepUp` (`smsSubtitle`) and
    `passkey` (`replacesTextedCode`: shown above "Add a passkey" to a user whose second step
    is a texted code, which the passkey replaces and which has no backup codes; `addChecking`
    and `addUnchecked`: read with that button, which is unavailable until the account's
    second step has been read, and stays so when the read fails). A texted
    code set aside by a stronger factor is said to come back when that factor is removed.
    Where the app has switched texted codes, text messages or the number's country off, the
    texted-code form shows the message of that refusal (`auth.method_disabled`,
    `sms.disabled`, `sms.country_not_allowed`) and removes its buttons.
  - `@tula-tech/admin`: the generated types know the routes, the setting, the method and the
    codes; a user's `authentication.factors` may hold `{ type: 'sms' }`.
  - `@tula-tech/mcp`: `get_settings` returns `mfa.smsCode`.
  - `@tula-tech/config`: a config accepts `mfa.smsCode`. An environment that leaves it off keeps
    the fingerprint it had: the key is hashed only when it is on.
- 73cadb2: SMS send limits and a daily limit per environment (ADR 0037).
  
  - `@tula-tech/contract`: the settings gain `sms.dailyMessageLimit` (default `500`, 1 to
    1,000,000, no value switches it off): the most text messages an environment sends in one
    UTC day. Raising it is a weakening (`settingsWeakenings` lists `sms.dailyMessageLimit`).
    New: `DEFAULT_SMS_DAILY_MESSAGE_LIMIT`, `MAX_SMS_DAILY_MESSAGE_LIMIT`,
    `phoneNumberPrefix` (a number's destination prefix: the calling prefix the country list
    matched) and `SMS_PREFIX_MAX_DIGITS`; `SmsUsageSchema` and `SmsPrefixUsageSchema` with
    `SMS_USAGE_MAX_DAYS`, `SMS_USAGE_DEFAULT_DAYS` and `SMS_USAGE_MAX_PREFIXES`, for the new
    operation `getSmsUsage` (`GET /v1/admin/sms/usage`): codes texted and used, by destination
    prefix. No new error code: a limit answers `rate_limited`.
  - `@tula-tech/config`: `settings.sms.dailyMessageLimit` in `tula.config.ts`. An environment that
    leaves it at the default keeps the fingerprint it had.
  - `@tula-tech/admin`: the generated types know `getSmsUsage` and the new setting.
  - `@tula-tech/cli`: `tula diff` flags a higher `sms.dailyMessageLimit` as a weakening, and
    `tula apply --yes` refuses it without `--allow-weaker`. A file that leaves the limit out
    asks for the default.
  - `@tula-tech/mcp`: `get_settings` returns `sms.dailyMessageLimit`.
- 9c90e25: Signing in with a code texted to a phone number an account has proven (ADR 0037). Off by
  default.
  
  - `@tula-tech/contract`: the first-factor strategy `sms_code` (in `FirstFactorStrategy`, in the
    prepare and attempt requests, and as a step's `prepared.strategy`), the setting
    `signIn.methods.smsCode` (default off; never the only method, see
    `SIGN_IN_METHODS_WITHOUT_SIGN_UP`), the authentication method `sms` in `amr`, and the
    error code `mfa.enrolment_needs_other_sign_in` (403). `settingsWeakenings` lists
    `signIn.methods.smsCode` when a texted code can sign someone in after a change and could
    not before, and `sms.allowedCountries` when a country is added while one does. The client
    configuration lists `smsCode` among `signIn.methods` where it is offered.
  - `@tula-tech/core`: `flow.prepareFirstFactor({ strategy: 'sms_code' })` and
    `flow.attemptFirstFactor({ strategy: 'sms_code', code })`, for a sign-in started with a
    phone number as its identifier. One more message in the error table.
  - `@tula-tech/react`: `<SignIn>` takes a phone number in its first field where the environment
    lists the method, and gains the "Text me a code" and "Check your phone" screens. New
    strings under `signIn` in the localization table (`identifierLabel`, `identifierHint`,
    `smsCode`, `smsCodePrompt`, `smsTitle`, `smsCodeSubtitle`, `smsResend`, `smsResendIn`,
    `smsResent`, `smsCodeWrong`). A version from before this one leaves the strategy out.
  - `@tula-tech/admin`: the generated types know the setting, the strategy and the error code.
  - `@tula-tech/mcp`: `get_settings` returns `signIn.methods.smsCode`.
  - `@tula-tech/config`: a config accepts `signIn.methods.smsCode`. An environment that leaves it
    off keeps the fingerprint it had: the key is hashed only when it is on.
- 0435d00: Text message wording and a preview of any message (`sms.templates` in the settings, and
  `POST /v1/admin/message-preview`).
  
  - `@tula-tech/contract` gains the kinds of text message, their placeholders and rules
    (`SMS_TEMPLATE_KINDS`, `SMS_TEMPLATE_PLACEHOLDERS`, `SMS_TEMPLATE_RULES`,
    `MAX_SMS_TEMPLATE_LENGTH`), the checks (`smsTemplateProblems`, `isSmsTemplateKind`,
    `readStoredSmsTemplates`), an estimate of what a text costs (`smsSegments`) and the
    schemas (`SmsTemplateSchema`, `SmsTemplatesSchema`). The `sms` settings have a new
    field, `templates`, empty by default: an environment that has saved nothing sends the
    message it always did.
  - A template is one sentence with `{{code}}` exactly once and, at most once, `{{appName}}`.
    The server still adds the last line (`@host #code`) itself. A template is refused when
    saved if it lacks the code, is over 140 characters, holds a line break, a hidden
    character, four digits in a row, a word that starts with `@` or `#`, something that
    reads as a link, or a letter, a digit or a combining mark directly beside a placeholder, or does not start with a letter.
  - `@tula-tech/config` accepts `settings.sms.templates`, validated when the file is loaded. A
    file with no wording hashes as before.
  - `tula diff` shows `sms.templates.<kind>.text` as one line, and `tula apply` removes the
    wording of a kind the file leaves out, as for every setting.
  - `@tula-tech/admin` has the `previewMessage` operation and the new settings types.
  - `@tula-tech/mcp`'s `get_settings` still returns `enabled`, `allowedCountries` and
    `dailyMessageLimit` of `sms`, and not the wording.
- d615c72: Step-up by emailed code, `hasPassword` on the signed-in user, and a colour-scheme fix.
  
  - `@tula-tech/contract`: `StepUpMethod` gains `email_code`, `StepUpRequest` accepts
    `{ method: 'email_code', code }`, and `StepUpEmailCode` is the receipt of
    `POST /v1/client/sessions/step-up/email-code`. `GET /v1/client/me` answers `CurrentUser`: a
    `User` plus `hasPassword`. All additive.
  - `@tula-tech/core`: `session.prepareStepUp({ method: 'email_code' })` emails the signed-in user a
    code (for a user with a verified address and no two-step verification) and
    `session.stepUp({ method: 'email_code', code })` proves it. `stepUpMethods(error)` now
    returns `email_code` when the server lists it. New type `StepUpPrepared`; `User` now has
    `hasPassword`.
  - `@tula-tech/react`: the step-up dialog offers the emailed code: next to the password as "Email
    me a code instead" (sent only when chosen), and at once when it is the user's only method,
    with resend and the server's cooldown. `<UserProfile>` tells a user without a password how
    to add one instead of showing the change-password form. Buttons no longer fade their
    background: when the colour scheme changed under an open page the label was unreadable for
    a few frames. New localization strings: `stepUp.emailSubtitle`, `stepUp.emailSubtitleSent`,
    `stepUp.emailSending`, `stepUp.emailSend`, `stepUp.emailInstead`, `stepUp.passwordInstead`
    and `userProfile.passwordNotSet`.
- e12e6d6: Typed, versioned event payloads (ADR 0012): what a webhook will deliver is a contract from its
  first delivery.
  
  - `@tula-tech/contract/event-types` (new entry point, no Zod): `ACTIVITY_TYPES` and `ActivityType`
    (moved here; still exported from the index), `EVENT_SCHEMA_VERSION` (1) and
    `EVENT_TARGET_TYPES` / `EventTargetType`, which says what each event's `target.id` is the id
    of.
  - `EVENT_DATA_SCHEMAS`: the `data` of every event type. `EVENT_SCHEMAS`: the event itself,
    `{ id, type, schemaVersion, occurredAt, actor, target, data }`, with no IP address and no
    user agent. `TulaEventSchema` and the `TulaEvent` type are their union by `type` (not
    `Event`, which is the DOM's); `EventOf<T>` and
    `EventData<T>` name one type's. A payload is an allow-list: ids, values from closed sets,
    booleans; never an email address, a token or a secret.
  - `EVENT_FIXTURES`: a valid example of every event type, as plain data.
  - `MAX_CHANGED_SETTINGS` and `MAX_SETTING_NAME_LENGTH`: the bounds of the names an
    `environment.settings_updated` event lists in `changed`. The set of names is open.
  - `openapi.json` gains the schemas as components (`TulaEvent`, `<Name>Event`, `<Name>EventData`,
    `EventActor`). No route changes.
- 1df35b8: Webhook retries, the delivery log, test events and sending a delivery again.
  
  - `@tula-tech/contract`:
    - A webhook endpoint gains `disabledReason` (`failing`, `gone`, or `null`), `failingSince`
      and `lastFailedAt`.
    - A new event type, `webhook_endpoint.disabled`, with `data.reason`
      (`WEBHOOK_DISABLED_REASONS`): the server switched an endpoint off because every request to
      it failed for five days with no silence longer than the retry schedule, or because it
      answered `410 Gone`.
    - Every event envelope gains an optional `test`, which is `true` on a test event and absent
      on a real one. `EVENT_SCHEMA_VERSION` stays 1.
    - `WebhookDeliverySchema`, `WebhookDeliveryDetailSchema`, `WebhookDeliveryAttemptSchema`,
      `WebhookDeliveryListSchema`, `SendTestWebhookRequestSchema`, `WebhookSendResultSchema`,
      `WEBHOOK_DELIVERY_STATES` and `WEBHOOK_REDELIVER_REFUSALS`.
    - A new error code, `webhook.cannot_redeliver` (409), whose `params.reason` is
      `delivery_pending`, `endpoint_disabled`, `event_gone` or `attempt_limit`.
  - `@tula-tech/admin`: the admin client gains `listWebhookDeliveries`, `getWebhookDelivery`,
    `sendTestWebhook` and `redeliverWebhook`. `verifyWebhook` returns a test event with
    `event.test === true` and refuses a `test` that is anything else; its documentation now says
    that a delivery is retried, that order is not guaranteed, and to check `test` before acting.
  - `@tula-tech/core`: the generated types and the error-message table follow the contract (one new
    code).
- 7d7600d: Webhook secret rotation: an endpoint's signing secret is replaced without dropping a delivery.
  
  - `@tula-tech/contract`:
    - A webhook endpoint gains `rotationOverlapEndsAt`: when the previous secret stops signing,
      or `null` when one secret signs. Until then every delivery carries two signatures in
      `webhook-signature`, the new secret's first.
    - `RotatedWebhookSecretSchema`: the answer of a rotation, the endpoint with its new secret
      (shown once) and `rotationOverlapEndsAt`.
    - Two new event types: `webhook_endpoint.secret_rotated` (`data.rotationOverlapEndsAt`) and
      `webhook_endpoint.previous_secret_revoked` (no data). Neither carries anything of a
      secret. `EVENT_SCHEMA_VERSION` stays 1.
    - A new error code, `webhook.rotation_refused` (409), whose `params.reason` is one of
      `WEBHOOK_ROTATION_REFUSALS`: `rotation_in_progress`, `no_rotation_in_progress` or
      `secret_unreadable`.
  - `@tula-tech/admin`:
    - The admin client gains `rotateWebhookSecret` and `revokePreviousWebhookSecret`.
    - `verifyWebhook` takes one secret **or a list of at most two** (`WEBHOOK_MAX_SECRETS`,
      `WebhookSecrets`): the delivery is accepted when any signature is right for any secret
      given. Every secret listed must be a signing secret; an empty list, a third secret or a
      malformed entry is `webhook.invalid_secret`. A single secret behaves as before.
  - `@tula-tech/core`: the generated types and the error-message table follow the contract (one new
    code).
- 5e51183: Webhooks, first step: an environment's events are delivered, signed, to an endpoint an
  operator registers (`/v1/admin/webhook-endpoints`; [ADR 0034](../docs/adr/0034-webhooks.md),
  [docs/webhooks.md](../docs/webhooks.md)). One attempt per endpoint and event for now: a
  failed delivery is recorded and not repeated.
  
  **`@tula-tech/contract`**
  
  - A new Zod-free entry point, `@tula-tech/contract/webhook-signature`: the Standard Webhooks header
    names (`WEBHOOK_ID_HEADER`, `WEBHOOK_TIMESTAMP_HEADER`, `WEBHOOK_SIGNATURE_HEADER`), the
    secret prefix, the five-minute tolerance, and `signWebhook`, `webhookSecretBytes` and
    `formatWebhookSecret`.
  - The webhook endpoint schemas of the admin API (`WebhookEndpointSchema`,
    `CreatedWebhookEndpointSchema`, the create and update requests, `MAX_WEBHOOK_ENDPOINTS`).
  - Three event types, each with a `data` schema and a fixture: `webhook_endpoint.created`,
    `webhook_endpoint.updated` and `webhook_endpoint.deleted`. Their target is a new target
    type, `webhook_endpoint`. An event never carries an endpoint's address or its secret.
  - A new error code, `webhook.url_not_allowed` (422): the server may not call the address.
    `params.reason` is a fixed word, never the address.
  
  A receiver or an SDK that switches on `type` or on `target.type` sees values it did not list
  before; both lists only grow within `schemaVersion` 1, as documented.
  
  **`@tula-tech/admin`**
  
  - `verifyWebhook(body, headers, secret, options?)`: verifies a delivery (the signature, in
    constant time, accepting any one of several; the headers; a timestamp within five minutes
    either way) and returns the typed event, `TulaWebhookEvent`. It throws `TulaAdminError`
    with one of five new client codes (`webhook.invalid_secret`, `webhook.invalid_headers`,
    `webhook.timestamp_out_of_tolerance`, `webhook.invalid_signature`,
    `webhook.invalid_payload`), never with the secret, a signature or the body in it. Zod-free,
    web platform APIs only.
  - The five webhook endpoint operations (`createWebhookEndpoint`, `listWebhookEndpoints`,
    `getWebhookEndpoint`, `updateWebhookEndpoint`, `deleteWebhookEndpoint`), and the event
    types under `AdminSchemas['TulaEvent']`.
  
  **`@tula-tech/core`**: the generated `ErrorCode` type lists `webhook.url_not_allowed`. Nothing a
  client calls changed.
  
  **`@tula-tech/mcp`**: a webhook signing secret (`whsec_…`) is redacted wherever it turns up in a
  result, like the other secret shapes. There is no webhook tool.
  
  **Before you upgrade the server**: migration `0018` adds a unique key and an index to the
  outbox table (`events`), which locks it for writes while they build; and the first start of
  the new version marks every event recorded so far as settled, without sending any
  ([docs/self-host.md](../docs/self-host.md#upgrading)).

### Patch Changes

- b38efc0: Licensed under Apache-2.0. Every package has the `license` field and ships the repository's
  `LICENSE` file.
- 462aee1: Review fixes of the dashboard step (ADR 0032).
  
  - The OpenAPI snapshot: `POST /v1/instance/session` now says that a sign-in is counted in a
    bucket of its own (10 a minute per IP) and that failed sign-ins are recorded at most once a
    minute per address. The request and response shapes are unchanged.
  - Documented: an application under a Content-Security-Policy without `'unsafe-eval'` should
    set Zod's `jitless` before importing `@tula-tech/contract` (docs/releasing.md).
- 7f204ac: `tula doctor` says when a session profile requires a device key on a deployment that can
  accept none ([ADR 0043](../docs/adr/0043-device-binding.md#a-deployment-that-cannot-bind-and-a-profile-that-requires-a-key-added-2026-10-12-tula-72),
  [docs/device-binding.md](../docs/device-binding.md#a-deployment-that-cannot-bind)). The
  server's diagnostics answer one more check, `device_binding`: `ok` where a device-binding
  proof can name `PUBLIC_URL`; a warning where none can (no session is bound, and a sign-in
  that brings a key is refused); a failure, with a count of environments, where the profile a
  native app gets by default also says `deviceBinding: "required"`, because a native sign-in
  there is refused with a key and without; and a warning with a count where only a profile a
  sign-in has to ask for requires one. Nothing about a sign-in changed: the setting is still
  saved, and `required` is never skipped.
  
  **`@tula-tech/contract`**: the OpenAPI document's description of `getInstanceDiagnostics` names
  the check. No schema changed: a check's `id` was and is a string.
  
  `@tula-tech/cli` and `@tula-tech/mcp` print whatever checks the server answers and are unchanged.
- ee1e737: `tula doctor` checks an environment's native apps
  ([ADR 0040](../docs/adr/0040-native-app-identity.md#what-tula-doctor-checks-added-2026-10-09-tula-35),
  [docs/cli.md](../docs/cli.md#tula-doctor)). The server's diagnostics answer three more
  checks: `native_app_identities` (every registered app is well formed),
  `native_app_files` (the association files name exactly the registered apps, and the server's
  own `PUBLIC_URL` serves them) and `native_app_passkeys` (the passkey relying party is a
  domain an app can be associated with). With no app registered they are `skipped`. Apps
  registered where passkeys are off is `ok` and said (the files serve saved passwords too).
  
  **Breaking for a deployment, not for a package**: the server now refuses to start when
  `PUBLIC_URL` holds a user name, a password, a query or a fragment. It is the issuer of every
  access token and the address the server requests to check itself, where the credentials
  would be sent as basic authentication. Remove them from the value.
  
  **`@tula-tech/contract`**: the OpenAPI document's description of `getInstanceDiagnostics` names
  them. No schema changed: a check's `id` was and is a string.
  
  `@tula-tech/cli` and `@tula-tech/mcp` print whatever checks the server answers and are unchanged. The
  server never requests an operator's own domain: whether Apple or Android can reach the files
  there is not checked, and the checks' text says so.
- 8a4734a: The first release to npm, as alphas under the `alpha` dist-tag. Each of the nine packages
  says where it comes from (`repository`, `homepage`, `bugs`, `keywords`), and its README says
  how to install it and that the API may change between alphas. `@tula-tech/contract` has a README.
  
  `@tula-tech/expo` and `@tula-tech/expo-screens` are held back until they have been run on a device.
  `create-tula --framework expo` therefore refuses, before anything is written, to scaffold a
  project that could not be installed, unless `--tula-packages` points it at tarballs from a
  checkout of the repository.
- 633d73b: The OpenAPI document says more of what the API already does.
  
  - Every `/v1/admin/*` and `/v1/instance/*` operation documents the answers of the dashboard's
    way in: 400 (two credentials in one request), 401, 403 `request.origin_not_allowed` and 404
    (an unknown environment). The routes themselves did not change.
  - An API key's `name` refuses control characters (`^[^\u0000-\u001f\u007f]*$`).
- 9178d46: The OpenAPI document lists a `501` for `sendTestWebhook` and `redeliverWebhook`.
  
  A server can now run its webhook worker as a service of its own (`WEBHOOK_WORKER=separate`;
  docs/self-host.md, "The webhook worker as its own service"). Its API instances then make no
  request to an endpoint, so a test event and a delivery sent again are refused there:
  `not_implemented` (501) with `params.reason: "worker_separate"`. The code is an existing one
  and no schema changed; a deployment that leaves the variable alone answers as before.
