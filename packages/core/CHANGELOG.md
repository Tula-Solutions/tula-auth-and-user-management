# @tula-tech/core

## 0.3.0

### Minor Changes

- 110ae64: Deleting an organization from the client needs a recent sign-in, and a user can list and answer their own invitations (TULA-131). `DELETE /v1/client/me/organizations/{organizationId}` now answers `auth.step_up_required` (403) for a session that has not proven itself lately; `<OrganizationProfile>` runs the step-up dialog and repeats the delete, and shows no error when the user closes it. New routes `GET /v1/client/me/organization-invitations` (the pending invitations sent to the user's own verified address: an id, the organization's name, the role and the expiry, never the token; paged) and `POST …/{invitationId}/accept` and `…/decline` (the session authorizes it; an id that is not the caller's is `organization.invitation_not_found`). `@tula-tech/contract` gains `MyOrganizationInvitationSchema`, `MyOrganizationInvitationListSchema` and `MyOrganizationInvitationQuerySchema`. `@tula-tech/core` gains `organizations.invitations.mine()`, `.acceptMine(id)` and `.declineMine(id)`. `<OrganizationSwitcher>` lists those invitations when the panel opens, with Accept and Decline; its words are `organizationSwitcher.pendingInvitationsTitle`, `pendingInvitationText`, `pendingInvitationAcceptLabel` and `pendingInvitationDeclineLabel`. `@tula-tech/nextjs` re-exports the components. The member list now looks its users up in one call.
- 568bcec: The organization components (Orgs 07). `@tula-tech/react` and `@tula-tech/nextjs` get `<OrganizationSwitcher>` (the active organization, the user's others, the personal account, suggestions from their email domain, an invitation they opened, and the way to create or manage an organization), `<CreateOrganization>` and `<OrganizationProfile>` (General: rename, leave, delete; Members: roles, removal; Invitations: invite, revoke; Domains: claim, verify with the emailed code, what a verified domain does), each drawn only where the user's role permits, themed, localized (the `organizationSwitcher`, `createOrganization` and `organizationProfile` groups) and accessible. They read the new `organizations` member of the public configuration (whether organizations are on, whether users may create them, whether there is a personal account); a configuration without it means organizations are off. `<TulaProvider>` takes `organizationProfileUrl`, `createOrganizationUrl` and `invitationUrl`, and both packages re-export `readInvitationLink`. `@tula-tech/core` gets the calls the screens make: `organizations.update`, `.remove`, `.leave`, `.roles`, `.members.list`, `.members.changeRole`, `.members.remove` and `.domains.list`, `.start`, `.verify`, `.update`, `.remove`. The API gets the client routes behind them under `/v1/client/me/organizations` (rename, delete, the member list, a member's role and removal, the assignable roles); a change of role or a removal that would leave an organization without a member who can manage members is refused with `organization.last_manager`. `@tula-tech/contract` gets `OrganizationMember`, `AssignableRole`, the `organizations` member of `ClientConfig`, and the Zod-free `@tula-tech/contract/organization-permissions` gains `ORGANIZATION_MANAGE_PERMISSION`, `ORGANIZATION_DELETE_PERMISSION` and `MEMBERSHIPS_READ_PERMISSION`, the keys the screens check.
- e15bd1c: Verified domains for organizations (Orgs 05). An organization claims a domain by entering a 6-digit code emailed to an address on it, and a user whose verified email address is exactly on a verified domain is offered the organization (`suggest`) or joined to it at sign-up (`auto_join`). `@tula-tech/core` gets `client.organizations.suggestions()` and `.join(organizationId)`; `@tula-tech/admin` gets `/v1/admin/organizations/{id}/domains` (list, claim, verify, change the mode, remove). The contract gains the schemas, the Zod-free entry point `@tula-tech/contract/organization-domain-rules` (the domain grammar, `domainRefusal`, `isPublicEmailDomain`, `domainOfAddress` and the documented list of public mail domains), the permission `org:sys:domains:manage`, the email kind `organization_domain_verification`, the activity types `organization_domain.claimed`, `.verified`, `.updated` and `.removed`, an optional `via` on `organization_membership.added`, and the error codes `organization.domain_public`, `organization.domain_taken`, `organization.domain_address_mismatch`, `organization.domain_limit` and `organization.suggestion_unavailable`.
- 2ee73d3: A signed-in user's own organizations and the active organization. `@tula-tech/core` gets `client.organizations.list()`, `.create(input)` and `.setActive(id | null)`, and the signed-in state gains `organizationId`, read from the access token's `org_id`. The access token carries `org_id`, `org_role` and `org_perms` while an organization is active (reserved claim names, a cap of their own, none of them when over it); a refresh re-reads the membership, so a removal or a demotion takes effect at the next refresh and the session stays. The contract gains the schemas for `GET`/`POST /v1/client/me/organizations` and `PUT /v1/client/me/organizations/active`, `readOrganizationClaims` and the error codes `organization.not_a_member`, `organization.creation_disabled`, `organization.limit_reached` and `organization.personal_account_disabled`. `@tula-tech/react` and `@tula-tech/nextjs` only follow the new field of the auth state.
- 24288d6: Invitations to an organization by email (ADR 0065, Orgs 04). `@tula-tech/core` gets `client.organizations.invitations` (`invite`, `list`, `revoke`, `preview`, `accept`, `decline`) and `readInvitationLink(url)`, which reads the token from the `#tula_invitation=…` fragment of the emailed link and returns the URL without it. Only the account the invitation was sent to, with that address verified, can accept or decline it; the token is single use, valid for 7 days, stored only as a hash and never in a response. `@tula-tech/admin` gains the admin routes (`GET`/`POST /v1/admin/organizations/{id}/invitations`, `DELETE …/{invitationId}`). The contract gains the invitation schemas, the email kind `organization_invitation` (with the template placeholder `expiresInDays`; there is none for the organization's name or the address), the permission constant `INVITATIONS_MANAGE_PERMISSION`, four activity types (`organization_invitation.created`, `.accepted`, `.declined`, `.revoked`) and ten error codes (`organization.permission_required`, `.role_not_assignable`, `.invitation_exists`, `.invitation_not_found`, `.invitation_expired`, `.invitation_revoked`, `.invitation_used`, `.invitation_wrong_account`, `.invitation_email_unverified`, `.invitation_role_gone`). `@tula-tech/react`, `@tula-tech/nextjs` and `@tula-tech/expo` only carry the new types and error codes.
- 9c2bafb: Paging and search over organizations. `client.organizations.list({ page, size })` in `@tula-tech/core` reads any page of the signed-in user's organizations (the generated client types now carry the documented `page` and `size` query of `GET /v1/client/me/organizations`, and `meta` says how many pages there are); a call with no argument reads the first page as before. `GET /v1/admin/organizations` takes `q`, a name or slug prefix of up to 100 characters matched ignoring case (`%` and `_` match themselves), counted and paged as a match; `@tula-tech/admin`'s `listOrganizations` types it. The contract gains `OrganizationSearchQuerySchema`.
- ece0a87: Bulk user import. `POST /v1/admin/users/import` (`importUsers` in `@tula-tech/admin`) takes up to 500 users per call, each with an email, `emailVerified`, an optional name, metadata and external id, and an optional password hash in the tagged form `{ algorithm, hash, params? }` (`bcrypt`, `argon2id`, `argon2i`). The answer reports every row as `created`, `skipped` (the address exists, or repeats in the call) or `refused` with a contract error code. The contract gains `ImportUsersRequestSchema`, `ImportUsersResultSchema` and the row schemas, `MAX_IMPORT_ROWS`, the error codes `import.unsupported_algorithm`, `import.hash_malformed`, `import.hash_parameters_too_weak`, `import.hash_parameters_too_costly`, and the activity type `user.imported` (its data holds booleans and the closed `passwordAlgorithm` only), so an import does not fire `user.created`. `@tula-tech/core` gets the new error codes and event type in its generated types.

### Patch Changes

- d57ea22: `GET /v1/admin/users/{userId}/organizations` lists the organizations a user belongs to with their role in each (`listUserOrganizations` in `@tula-tech/admin`, `UserMembershipListSchema` in `@tula-tech/contract`). The dashboard's user page, Organizations, Roles and Organization settings screens use it.
- 595f5d9: Custom organization roles (ADR 0065). An environment defines roles of its own beside `admin` and `member`: `/v1/admin/organization-roles` (list, define, read, change, remove; `listOrganizationRoles`, `createOrganizationRole`, `getOrganizationRole`, `updateOrganizationRole`, `deleteOrganizationRole` in `@tula-tech/admin`). A role is its key, a name and up to 32 permissions of the form `org:<feature>:<action>` (a custom role may hold the system permissions Tula defines, such as `org:sys:memberships:manage`, and no other `org:sys:*` key); an environment has up to 50. A change is made over the role's version (`ETag` / `If-Match`), and giving a role a permission is recorded as a weakening. The contract gains the role schemas, `@tula-tech/contract/organization-permissions` (the grammar, the limits and `organizationRoleWeakenings`, Zod-free), the error codes `organization.role_exists`, `organization.role_in_use`, `organization.role_built_in` and `organization.role_limit`, and the activity types `organization_role.created`, `.updated` and `.deleted` (their data holds the role's key, a count and the names of the fields, never a name or a permission). `@tula-tech/config` accepts an `organizationRoles` list per environment (left out, roles are not managed; the fingerprint of an existing file is unchanged), and `tula diff` / `tula apply` plan and write them: a role is its key, the permissions are a set, `--prune` removes an unlisted role, a role that gains a permission needs `--allow-weaker` under `--yes`, and every write carries the version the plan read. `@tula-tech/core` gets the new error codes in its generated types.
- 2d098d6: A verification of an organization's domain now lasts a year (ADR 0065, "Lapse"). Past it, the domain matches nobody: no auto-join at sign-up and no suggestion, until a manager claims the domain again and enters the new emailed code. The contract gains `DOMAIN_VERIFICATION_LIFETIME_DAYS` (365), `DOMAIN_REMINDER_DAYS` (30 and 7), `DOMAIN_REVERIFICATION_GRACE_DAYS` (30, for domains verified before this change) and `ORGANIZATION_DOMAIN_STATUSES`; an `OrganizationDomain` gains `status` (`pending`, `verified` or `needs_reverification`) and `expiresAt`, and `codeExpiresAt` is also set while a verified domain is being proven again. The event `organization_domain.verified` gains an optional `reverified: true`. The email kind `organization_domain_expiring` (a notice with the placeholders `appName` and `expiresInDays`) is the reminder sent to an organization's managers 30 and 7 days ahead; it names the organization and a count, never a domain. `@tula-tech/core` and `@tula-tech/admin` only carry the new fields. Sending codes is also fairer: an organization a user created sends 10 a day (30 for one an administrator made), all of one user's organizations share 20 a day, and being told that a name is claimed elsewhere (`organization.domain_taken`) spends one of the organization's ten sends an hour.
- ef6030d: Organizations, first step (ADR 0065): the `organizations` environment settings (off by default), the schemas, role keys and permission grammar of organizations and memberships, six new activity types, and five `organization.*` error codes. `@tula-tech/admin` gains the typed admin routes for organizations and their memberships. `@tula-tech/config` leaves the section out of an environment's fingerprint while it is the default. `@tula-tech/core` carries the new error codes in its generated types.
- ad8b8e2: `tula import` reports the users of a retried batch correctly. When a batch got no answer and was sent again, the users the first attempt had made were counted as skipped and a Clerk member was found by address. `POST /v1/admin/users/import` now answers a skipped `email_exists` row with the existing user's `id` and `sameExternalId` (whether their stored external id is the row's); `tula import` counts such a row in a retried batch as created and pairs Clerk members by the recorded id. The answer is additive.
- 048f982: Deleting a user who is the only member holding `org:sys:memberships:manage` of an organization is refused with the new `user.last_organization_manager` error code (409, `params.organizationIds` and `params.count`), as removing or demoting that member already was. Add another manager or delete the organization first. `@tula-tech/admin` and `@tula-tech/core` carry the new error code in their generated types.
- Updated dependencies [d57ea22]
- Updated dependencies [110ae64]
- Updated dependencies [568bcec]
- Updated dependencies [595f5d9]
- Updated dependencies [2d098d6]
- Updated dependencies [e15bd1c]
- Updated dependencies [ef6030d]
- Updated dependencies [2ee73d3]
- Updated dependencies [24288d6]
- Updated dependencies [358f646]
- Updated dependencies [9c2bafb]
- Updated dependencies [ad8b8e2]
- Updated dependencies [048f982]
- Updated dependencies [721ed9e]
- Updated dependencies [ece0a87]
  - @tula-tech/contract@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [f56f6b5]
  - @tula-tech/contract@0.2.0

## 0.1.1

### Patch Changes

- @tula-tech/contract@0.1.1

## 0.1.0

### Minor Changes

- ac15d68: Two-step verification and step-up in the headless client.
  
  - `tula.mfa`: `get()`, `startTotp()`, `confirmTotp({ code })`, `disableTotp()` and
    `regenerateBackupCodes()` for the signed-in user. `confirmTotp` refreshes the session
    afterwards, so its next access token says the second factor was proven; the backup codes are
    returned whether or not that refresh could be made.
  - `tula.session.stepUp(proof)`: proves a password, an authenticator code or a backup code again
    and installs the fresh access token for the same session (the refresh token is untouched).
    New helpers `isStepUpRequired(error)` and `stepUpMethods(error)` read an
    `auth.step_up_required` error; the client never prompts or retries by itself.
  - Flows: `submitSecondFactor({ method, code })` on sign-in and password-reset flows, and
    `startTotpEnrolment()` / `confirmTotpEnrolment({ code })` on all three for the new
    `needs_factor_enrolment` step. They resolve with `{ step, backupCodesRemaining? }` and
    `{ step, backupCodes, failure? }`.
  - The TOTP secret, its URI and backup codes are handed to the caller once and stored nowhere
    in the client. Every new 200 is checked before anything is built from it (`response.invalid`).
  - A session token another tab announces late no longer replaces a newer one for the same
    session.
  - New types: `Factors`, `TotpEnrolment`, `BackupCodes`, `SecondFactorProof`, `StepUpProof`,
    `StepUpMethod`, `MfaPolicy`, `FactorEnrolmentMethod`, `SecondFactorResult`,
    `FactorEnrolmentResult`. `ClientConfig` gains the optional `mfa.policy`.
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
- 9d2a864: `client.user.email.request({ email })` and `client.user.email.verify({ code })`: a signed-in
  user whose account has no email address (one made with X or Facebook) asks for a code at an
  address and proves it (ADR 0059). Both need a recent sign-in; an account with nothing to
  step up with is answered `auth.step_up_required` with no method and signs in again. An
  address another account holds is answered like a free one and no code confirms it. The
  message table gains `email.already_set`.
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
- bb0da88: Passkeys and sign-in with a provider in an Expo app ([docs/expo.md](../docs/expo.md),
  ADR 0048). **Neither has been run on a device, a simulator or in Expo Go**: both are tested
  with stand-ins for the passkey sheet and the system browser
  (`docs/plans/phase-2-unverified.md`).
  
  `@tula-tech/core`:
  
  - `Environment.passkeyProvider` (`PasskeyProvider`: `create` and `get`, WebAuthn's JSON
    forms in and out): where a client's environment has one, a passkey is asked of it
    instead of `navigator.credentials`. A browser's client is unchanged.
  - `createTulaClientWithEnvironment(options, environment)` and `runtimeEnvironment()`, for
    a package that builds a client for a runtime without a browser's globals, and the
    environment's types.
  
  `@tula-tech/expo`:
  
  - `createTulaExpoClient({ passkeys, browser })`: a passkey sheet (`PasskeySheet`) and a
    system browser session (`BrowserSession`), both optional. `@tula-tech/expo/passkeys`
    (`passkeySheet`, over `react-native-passkey` 3.6 or later; a development build) and
    `@tula-tech/expo/browser` (`systemBrowser`, over `expo-web-browser`) are adapters, each an
    entry point with an optional peer, so an app installs only what it offers.
  - `useSignIn().withPasskey()`, `submitSecondFactorWithPasskey()` (also on
    `useResetPassword`), and `usePasskeys()`: `supported`, `add()` and `stepUp()`. One
    passkey request at a time; a dismissed sheet sets `dismissed` and never `error`.
  - `useSignIn().withProvider({ provider, redirectUrl })` and `retryProvider()`, and outside
    a component `signInWithProvider`, `linkProvider` and `retryProviderSignIn`. The
    provider's page opens in the system browser and returns to the app's custom scheme or
    `https` app link; the ticket is exchanged with a binding kept in memory only. A returned
    URL that is not the redirect URL asked for, one with no answer, and a ticket this client
    did not start are refused without a request. The server's
    `request.redirect_not_allowed` is passed on with its `params.reason`.
  - `flowScreen(step, ways)`: a passkey and a provider count as ways only for a client that
    can do them.
  - An emailed link is still not offered: asking for one fails with `storage.failed` before
    any request, and the code in the same email is the way.
- f686a47: First prerelease of the contract and the headless client.
  
  - `@tula-tech/contract`: the API's schemas, flow protocol, error codes, token claims and password
    policy, with Zod-free entry points (`/error-codes`, `/headers`, `/password-rules`) for clients.
  - `@tula-tech/core`: `createTulaClient` with server-driven sign-up, sign-in and password-reset flows,
    session management with single-flight token refresh (its own 8-second timeout and one immediate
    retry when no answer comes, both inside the server's reuse grace period), validated responses, and typed errors.
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
- 9c6253e: An OAuth sign-in is no longer lost when the ticket exchange gets no answer.
  
  - `@tula-tech/core`: when `signIn.handleOAuthCallback()` fails with `network.failed`,
    `network.timeout` or `rate_limited`, the round trip is kept (the binding in `sessionStorage`,
    the ticket in memory only, for 60 seconds) and calling it again retries the exchange. Any
    answer from the API, success or refusal, ends the round trip as before. New:
    `signIn.discardOAuthCallback()` to give up on a held round trip (sign-out and a new round trip
    do the same), and `isRetryableOAuthError(error)`.
  - `@tula-tech/react`: `useOAuthCallback()` returns `canRetry` and `retry()`, and `<OAuthCallback>`
    shows a "Try again" button after such a failure. New localization string `oauth.tryAgain`.
  - `@tula-tech/react`: the step-up dialog no longer says a code was emailed when its first send was
    refused (`rate_limited`): it shows the error with the wait counted down and "Send code", and
    the code field only after a send succeeded. Going to the password form and back keeps the
    code already sent instead of asking for another. The localization string
    `stepUp.emailSubtitleSent` is gone.
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

### Patch Changes

- b38efc0: Licensed under Apache-2.0. Every package has the `license` field and ships the repository's
  `LICENSE` file.
- 8a4734a: The first release to npm, as alphas under the `alpha` dist-tag. Each of the nine packages
  says where it comes from (`repository`, `homepage`, `bugs`, `keywords`), and its README says
  how to install it and that the API may change between alphas. `@tula-tech/contract` has a README.
  
  `@tula-tech/expo` and `@tula-tech/expo-screens` are held back until they have been run on a device.
  `create-tula --framework expo` therefore refuses, before anything is written, to scaffold a
  project that could not be installed, unless `--tula-packages` points it at tarballs from a
  checkout of the repository.
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
- 633d73b: Fixes from the whole-phase review of the client SDKs and the CLI.
  
  - `@tula-tech/nextjs`: `safeRedirectPath` checks the path it returns, not only the value it was
    given. `/.//host`, `/..//host`, `/a/..//host` and `/%2e//host` were normalised by the URL
    parser to `//host` and returned, which a router reads as another origin (an open redirect
    through `redirect_url`). A path that starts with an encoded slash or backslash (`/%2f`,
    `/%5c`) is refused too.
  - `@tula-tech/react`: `safeUrl` and `go()` refuse a destination with no scheme that names a host
    (`//host`, `/\host`, a path that normalises to one). A relative destination means this
    origin; another site is written with its scheme.
  - `@tula-tech/react`: a failed sign-out is no longer shown as a sign-out. `<UserButton>` and
    `<UserProfile>` swallowed the error `@tula-tech/core` throws when the server could not be told
    and went to `afterSignOutUrl`; behind `@tula-tech/nextjs` the cookies were still there and the
    next request was signed in again. They now navigate only after a sign-out that went
    through; otherwise the provider shows a dialog (an alert) saying the session may still be
    active on this device, with "Try again". New strings: `signOutFailed.title`, `.message`,
    `.retry`, `.close`. `useTulaContext()` gains `signOut(redirectUrl?)`.
  - `@tula-tech/nextjs`: the server-side session refresh waits at most 8 seconds (it used the
    general 15-second timeout, longer than the 10-second floor of the refresh reuse grace
    window) and, like the browser's client, repeats once, at once, a refresh that got no answer;
    an HTTP answer is never repeated. `timeoutSeconds` smaller than 8 still applies.
  - `@tula-tech/nextjs`: `auth()` and `currentUser()` read the `__Host-` cookie names when the
    request carries one of them and neither `TULA_APP_URL` nor `X-Forwarded-Proto` says the
    scheme. Before, an app served over https without either was signed in for the middleware
    and signed out in every Server Component. Setting `TULA_APP_URL` remains the recommended way.
  - `@tula-tech/core`: `discard()` ends an attempt, and every flow has it (sign-up and password reset
    gain it). The attempt's secret is forgotten, later actions throw `flow.invalid_step`, and
    the answer to an action still in flight is dropped: it can no longer sign the client in
    through an attempt the user left. **Changed:** a `SignInFlow` could be waited on again
    after `discard()`; it now refuses with `flow.invalid_step`. To stop waiting and go on with
    the same attempt, abort the wait's `signal` instead.
  - `@tula-tech/core`: on a client that holds its own refresh token (every kind but `web`), a
    `signOut()` that could not reach the server can be repeated. The token had already been
    dropped, so a second call sent nothing and resolved while the session lived on. It is now
    kept in memory only (never storage) until a sign-out is delivered, the API says the session
    is over, or a new session is adopted. The client is signed out throughout.
  - `@tula-tech/react`: when a provider dialog closes and the control that opened it is gone (the
    "Sign out" item after a failed sign-out, a sign-in form after an enrolment), focus moves to
    the page's first focusable control instead of being left on the document. The
    failed-sign-out dialog also closes when the provider is given another `client`.
  - `@tula-tech/cli`: `tula dev` refuses anything at `.env.local` that is not a regular file (a
    named pipe there made it wait for ever).
  - `@tula-tech/cli`: `tula dev` writes `.env.local` through a temporary file created exclusively
    under a random name (it was the guessable `.env.local.<pid>.tmp`, written through a
    symbolic link if one was planted there), and refuses a symbolic link at `.env.local`
    instead of writing or changing a mode through it.
  - `@tula-tech/cli`: `tula doctor` also removes bidi overrides, zero-width characters, private-use
    and unassigned code points from text the server sent before printing it.
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
- Updated dependencies [a036657]
- Updated dependencies [a34eb0e]
- Updated dependencies [b38efc0]
- Updated dependencies [1c76ead]
- Updated dependencies [55115bc]
- Updated dependencies [0a5e496]
- Updated dependencies [9166270]
- Updated dependencies [462aee1]
- Updated dependencies [d013691]
- Updated dependencies [f3216d0]
- Updated dependencies [75b1b36]
- Updated dependencies [7f204ac]
- Updated dependencies [ee1e737]
- Updated dependencies [9d2a864]
- Updated dependencies [4e15bd1]
- Updated dependencies [bce497c]
- Updated dependencies [ac05f56]
- Updated dependencies [8a4734a]
- Updated dependencies [f686a47]
- Updated dependencies [48d9bea]
- Updated dependencies [2dce8af]
- Updated dependencies [c760b08]
- Updated dependencies [0de4f8d]
- Updated dependencies [ea7f074]
- Updated dependencies [784639a]
- Updated dependencies [095a866]
- Updated dependencies [1f189d8]
- Updated dependencies [1b61d3e]
- Updated dependencies [c04622e]
- Updated dependencies [d72fb3d]
- Updated dependencies [07eff2f]
- Updated dependencies [82d87eb]
- Updated dependencies [fc7d990]
- Updated dependencies [596b4cd]
- Updated dependencies [894b927]
- Updated dependencies [751eae5]
- Updated dependencies [633d73b]
- Updated dependencies [59c2709]
- Updated dependencies [99593eb]
- Updated dependencies [c97d084]
- Updated dependencies [79bc411]
- Updated dependencies [190bb99]
- Updated dependencies [259f896]
- Updated dependencies [61af5e2]
- Updated dependencies [a0377de]
- Updated dependencies [73cadb2]
- Updated dependencies [9c90e25]
- Updated dependencies [0435d00]
- Updated dependencies [d615c72]
- Updated dependencies [e12e6d6]
- Updated dependencies [1df35b8]
- Updated dependencies [7d7600d]
- Updated dependencies [9178d46]
- Updated dependencies [5e51183]
  - @tula-tech/contract@0.1.0

## 0.1.0-alpha.1

### Patch Changes

- @tula-tech/contract@0.1.0-alpha.1

## 0.1.0-alpha.0

### Minor Changes

- ac15d68: Two-step verification and step-up in the headless client.
  
  - `tula.mfa`: `get()`, `startTotp()`, `confirmTotp({ code })`, `disableTotp()` and
    `regenerateBackupCodes()` for the signed-in user. `confirmTotp` refreshes the session
    afterwards, so its next access token says the second factor was proven; the backup codes are
    returned whether or not that refresh could be made.
  - `tula.session.stepUp(proof)`: proves a password, an authenticator code or a backup code again
    and installs the fresh access token for the same session (the refresh token is untouched).
    New helpers `isStepUpRequired(error)` and `stepUpMethods(error)` read an
    `auth.step_up_required` error; the client never prompts or retries by itself.
  - Flows: `submitSecondFactor({ method, code })` on sign-in and password-reset flows, and
    `startTotpEnrolment()` / `confirmTotpEnrolment({ code })` on all three for the new
    `needs_factor_enrolment` step. They resolve with `{ step, backupCodesRemaining? }` and
    `{ step, backupCodes, failure? }`.
  - The TOTP secret, its URI and backup codes are handed to the caller once and stored nowhere
    in the client. Every new 200 is checked before anything is built from it (`response.invalid`).
  - A session token another tab announces late no longer replaces a newer one for the same
    session.
  - New types: `Factors`, `TotpEnrolment`, `BackupCodes`, `SecondFactorProof`, `StepUpProof`,
    `StepUpMethod`, `MfaPolicy`, `FactorEnrolmentMethod`, `SecondFactorResult`,
    `FactorEnrolmentResult`. `ClientConfig` gains the optional `mfa.policy`.
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
- 9d2a864: `client.user.email.request({ email })` and `client.user.email.verify({ code })`: a signed-in
  user whose account has no email address (one made with X or Facebook) asks for a code at an
  address and proves it (ADR 0059). Both need a recent sign-in; an account with nothing to
  step up with is answered `auth.step_up_required` with no method and signs in again. An
  address another account holds is answered like a free one and no code confirms it. The
  message table gains `email.already_set`.
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
- bb0da88: Passkeys and sign-in with a provider in an Expo app ([docs/expo.md](../docs/expo.md),
  ADR 0048). **Neither has been run on a device, a simulator or in Expo Go**: both are tested
  with stand-ins for the passkey sheet and the system browser
  (`docs/plans/phase-2-unverified.md`).
  
  `@tula-tech/core`:
  
  - `Environment.passkeyProvider` (`PasskeyProvider`: `create` and `get`, WebAuthn's JSON
    forms in and out): where a client's environment has one, a passkey is asked of it
    instead of `navigator.credentials`. A browser's client is unchanged.
  - `createTulaClientWithEnvironment(options, environment)` and `runtimeEnvironment()`, for
    a package that builds a client for a runtime without a browser's globals, and the
    environment's types.
  
  `@tula-tech/expo`:
  
  - `createTulaExpoClient({ passkeys, browser })`: a passkey sheet (`PasskeySheet`) and a
    system browser session (`BrowserSession`), both optional. `@tula-tech/expo/passkeys`
    (`passkeySheet`, over `react-native-passkey` 3.6 or later; a development build) and
    `@tula-tech/expo/browser` (`systemBrowser`, over `expo-web-browser`) are adapters, each an
    entry point with an optional peer, so an app installs only what it offers.
  - `useSignIn().withPasskey()`, `submitSecondFactorWithPasskey()` (also on
    `useResetPassword`), and `usePasskeys()`: `supported`, `add()` and `stepUp()`. One
    passkey request at a time; a dismissed sheet sets `dismissed` and never `error`.
  - `useSignIn().withProvider({ provider, redirectUrl })` and `retryProvider()`, and outside
    a component `signInWithProvider`, `linkProvider` and `retryProviderSignIn`. The
    provider's page opens in the system browser and returns to the app's custom scheme or
    `https` app link; the ticket is exchanged with a binding kept in memory only. A returned
    URL that is not the redirect URL asked for, one with no answer, and a ticket this client
    did not start are refused without a request. The server's
    `request.redirect_not_allowed` is passed on with its `params.reason`.
  - `flowScreen(step, ways)`: a passkey and a provider count as ways only for a client that
    can do them.
  - An emailed link is still not offered: asking for one fails with `storage.failed` before
    any request, and the code in the same email is the way.
- f686a47: First prerelease of the contract and the headless client.
  
  - `@tula-tech/contract`: the API's schemas, flow protocol, error codes, token claims and password
    policy, with Zod-free entry points (`/error-codes`, `/headers`, `/password-rules`) for clients.
  - `@tula-tech/core`: `createTulaClient` with server-driven sign-up, sign-in and password-reset flows,
    session management with single-flight token refresh (its own 8-second timeout and one immediate
    retry when no answer comes, both inside the server's reuse grace period), validated responses, and typed errors.
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
- 9c6253e: An OAuth sign-in is no longer lost when the ticket exchange gets no answer.
  
  - `@tula-tech/core`: when `signIn.handleOAuthCallback()` fails with `network.failed`,
    `network.timeout` or `rate_limited`, the round trip is kept (the binding in `sessionStorage`,
    the ticket in memory only, for 60 seconds) and calling it again retries the exchange. Any
    answer from the API, success or refusal, ends the round trip as before. New:
    `signIn.discardOAuthCallback()` to give up on a held round trip (sign-out and a new round trip
    do the same), and `isRetryableOAuthError(error)`.
  - `@tula-tech/react`: `useOAuthCallback()` returns `canRetry` and `retry()`, and `<OAuthCallback>`
    shows a "Try again" button after such a failure. New localization string `oauth.tryAgain`.
  - `@tula-tech/react`: the step-up dialog no longer says a code was emailed when its first send was
    refused (`rate_limited`): it shows the error with the wait counted down and "Send code", and
    the code field only after a send succeeded. Going to the password form and back keeps the
    code already sent instead of asking for another. The localization string
    `stepUp.emailSubtitleSent` is gone.
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

### Patch Changes

- b38efc0: Licensed under Apache-2.0. Every package has the `license` field and ships the repository's
  `LICENSE` file.
- 8a4734a: The first release to npm, as alphas under the `alpha` dist-tag. Each of the nine packages
  says where it comes from (`repository`, `homepage`, `bugs`, `keywords`), and its README says
  how to install it and that the API may change between alphas. `@tula-tech/contract` has a README.
  
  `@tula-tech/expo` and `@tula-tech/expo-screens` are held back until they have been run on a device.
  `create-tula --framework expo` therefore refuses, before anything is written, to scaffold a
  project that could not be installed, unless `--tula-packages` points it at tarballs from a
  checkout of the repository.
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
- 633d73b: Fixes from the whole-phase review of the client SDKs and the CLI.
  
  - `@tula-tech/nextjs`: `safeRedirectPath` checks the path it returns, not only the value it was
    given. `/.//host`, `/..//host`, `/a/..//host` and `/%2e//host` were normalised by the URL
    parser to `//host` and returned, which a router reads as another origin (an open redirect
    through `redirect_url`). A path that starts with an encoded slash or backslash (`/%2f`,
    `/%5c`) is refused too.
  - `@tula-tech/react`: `safeUrl` and `go()` refuse a destination with no scheme that names a host
    (`//host`, `/\host`, a path that normalises to one). A relative destination means this
    origin; another site is written with its scheme.
  - `@tula-tech/react`: a failed sign-out is no longer shown as a sign-out. `<UserButton>` and
    `<UserProfile>` swallowed the error `@tula-tech/core` throws when the server could not be told
    and went to `afterSignOutUrl`; behind `@tula-tech/nextjs` the cookies were still there and the
    next request was signed in again. They now navigate only after a sign-out that went
    through; otherwise the provider shows a dialog (an alert) saying the session may still be
    active on this device, with "Try again". New strings: `signOutFailed.title`, `.message`,
    `.retry`, `.close`. `useTulaContext()` gains `signOut(redirectUrl?)`.
  - `@tula-tech/nextjs`: the server-side session refresh waits at most 8 seconds (it used the
    general 15-second timeout, longer than the 10-second floor of the refresh reuse grace
    window) and, like the browser's client, repeats once, at once, a refresh that got no answer;
    an HTTP answer is never repeated. `timeoutSeconds` smaller than 8 still applies.
  - `@tula-tech/nextjs`: `auth()` and `currentUser()` read the `__Host-` cookie names when the
    request carries one of them and neither `TULA_APP_URL` nor `X-Forwarded-Proto` says the
    scheme. Before, an app served over https without either was signed in for the middleware
    and signed out in every Server Component. Setting `TULA_APP_URL` remains the recommended way.
  - `@tula-tech/core`: `discard()` ends an attempt, and every flow has it (sign-up and password reset
    gain it). The attempt's secret is forgotten, later actions throw `flow.invalid_step`, and
    the answer to an action still in flight is dropped: it can no longer sign the client in
    through an attempt the user left. **Changed:** a `SignInFlow` could be waited on again
    after `discard()`; it now refuses with `flow.invalid_step`. To stop waiting and go on with
    the same attempt, abort the wait's `signal` instead.
  - `@tula-tech/core`: on a client that holds its own refresh token (every kind but `web`), a
    `signOut()` that could not reach the server can be repeated. The token had already been
    dropped, so a second call sent nothing and resolved while the session lived on. It is now
    kept in memory only (never storage) until a sign-out is delivered, the API says the session
    is over, or a new session is adopted. The client is signed out throughout.
  - `@tula-tech/react`: when a provider dialog closes and the control that opened it is gone (the
    "Sign out" item after a failed sign-out, a sign-in form after an enrolment), focus moves to
    the page's first focusable control instead of being left on the document. The
    failed-sign-out dialog also closes when the provider is given another `client`.
  - `@tula-tech/cli`: `tula dev` refuses anything at `.env.local` that is not a regular file (a
    named pipe there made it wait for ever).
  - `@tula-tech/cli`: `tula dev` writes `.env.local` through a temporary file created exclusively
    under a random name (it was the guessable `.env.local.<pid>.tmp`, written through a
    symbolic link if one was planted there), and refuses a symbolic link at `.env.local`
    instead of writing or changing a mode through it.
  - `@tula-tech/cli`: `tula doctor` also removes bidi overrides, zero-width characters, private-use
    and unassigned code points from text the server sent before printing it.
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
- Updated dependencies [a036657]
- Updated dependencies [a34eb0e]
- Updated dependencies [b38efc0]
- Updated dependencies [1c76ead]
- Updated dependencies [55115bc]
- Updated dependencies [0a5e496]
- Updated dependencies [9166270]
- Updated dependencies [462aee1]
- Updated dependencies [d013691]
- Updated dependencies [f3216d0]
- Updated dependencies [75b1b36]
- Updated dependencies [7f204ac]
- Updated dependencies [ee1e737]
- Updated dependencies [9d2a864]
- Updated dependencies [4e15bd1]
- Updated dependencies [bce497c]
- Updated dependencies [ac05f56]
- Updated dependencies [8a4734a]
- Updated dependencies [f686a47]
- Updated dependencies [48d9bea]
- Updated dependencies [2dce8af]
- Updated dependencies [c760b08]
- Updated dependencies [0de4f8d]
- Updated dependencies [ea7f074]
- Updated dependencies [784639a]
- Updated dependencies [095a866]
- Updated dependencies [1f189d8]
- Updated dependencies [1b61d3e]
- Updated dependencies [c04622e]
- Updated dependencies [d72fb3d]
- Updated dependencies [07eff2f]
- Updated dependencies [82d87eb]
- Updated dependencies [fc7d990]
- Updated dependencies [596b4cd]
- Updated dependencies [894b927]
- Updated dependencies [751eae5]
- Updated dependencies [633d73b]
- Updated dependencies [59c2709]
- Updated dependencies [99593eb]
- Updated dependencies [c97d084]
- Updated dependencies [79bc411]
- Updated dependencies [190bb99]
- Updated dependencies [259f896]
- Updated dependencies [61af5e2]
- Updated dependencies [a0377de]
- Updated dependencies [73cadb2]
- Updated dependencies [9c90e25]
- Updated dependencies [0435d00]
- Updated dependencies [d615c72]
- Updated dependencies [e12e6d6]
- Updated dependencies [1df35b8]
- Updated dependencies [7d7600d]
- Updated dependencies [9178d46]
- Updated dependencies [5e51183]
  - @tula-tech/contract@0.1.0-alpha.0
