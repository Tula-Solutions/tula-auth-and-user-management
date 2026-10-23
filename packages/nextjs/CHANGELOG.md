# @tula-tech/nextjs

## 0.3.0

### Minor Changes

- 568bcec: The organization components (Orgs 07). `@tula-tech/react` and `@tula-tech/nextjs` get `<OrganizationSwitcher>` (the active organization, the user's others, the personal account, suggestions from their email domain, an invitation they opened, and the way to create or manage an organization), `<CreateOrganization>` and `<OrganizationProfile>` (General: rename, leave, delete; Members: roles, removal; Invitations: invite, revoke; Domains: claim, verify with the emailed code, what a verified domain does), each drawn only where the user's role permits, themed, localized (the `organizationSwitcher`, `createOrganization` and `organizationProfile` groups) and accessible. They read the new `organizations` member of the public configuration (whether organizations are on, whether users may create them, whether there is a personal account); a configuration without it means organizations are off. `<TulaProvider>` takes `organizationProfileUrl`, `createOrganizationUrl` and `invitationUrl`, and both packages re-export `readInvitationLink`. `@tula-tech/core` gets the calls the screens make: `organizations.update`, `.remove`, `.leave`, `.roles`, `.members.list`, `.members.changeRole`, `.members.remove` and `.domains.list`, `.start`, `.verify`, `.update`, `.remove`. The API gets the client routes behind them under `/v1/client/me/organizations` (rename, delete, the member list, a member's role and removal, the assignable roles); a change of role or a removal that would leave an organization without a member who can manage members is refused with `organization.last_manager`. `@tula-tech/contract` gets `OrganizationMember`, `AssignableRole`, the `organizations` member of `ClientConfig`, and the Zod-free `@tula-tech/contract/organization-permissions` gains `ORGANIZATION_MANAGE_PERMISSION`, `ORGANIZATION_DELETE_PERMISSION` and `MEMBERSHIPS_READ_PERMISSION`, the keys the screens check.
- 358f646: The active organization and `has()` in Next.js and React. `@tula-tech/nextjs`: `auth()` returns `orgId`, `orgRole`, `orgPermissions` and `has({ permission } | { role })` (exact match, no wildcard, `false` with no active organization); `tulaMiddleware` takes `access` rules (a route matcher and the permission or role it needs) and `forbiddenUrl`, so a route group can be refused before it renders, with a 403 for an API route; the three organization claims reach `auth()` only as a set that passed the contract's checks, from a verified token, the stateful session's answer and the sealed `x-tula-auth` header alike. A token that carries a maximal role (up to 32 permissions of 100 characters) outgrows one browser cookie (measured: 5.3 kB against a 4,096-byte limit), so the access token is now stored in up to two cookies, `tula_at` and `tula_at_1`, read back in order and verified as one token; a token too large for two is not stored and the session lives on its refresh cookie. `@tula-tech/react`, and `@tula-tech/nextjs` which re-exports them: `useOrganization()` (the active organization, the role and permissions of the session, and `has()`) and `useOrganizationList()` (the user's organizations, `setActive()` and `create()`), keyed to the session so that a result for an earlier session is never shown. `@tula-tech/contract`: `readOrganizationClaims` now checks the organization id, the role key and every permission against the permission grammar, and `hasOrganizationAccess` and the `OrganizationCheck` type are the one `has()` rule every package shares.

### Patch Changes

- 110ae64: Deleting an organization from the client needs a recent sign-in, and a user can list and answer their own invitations (TULA-131). `DELETE /v1/client/me/organizations/{organizationId}` now answers `auth.step_up_required` (403) for a session that has not proven itself lately; `<OrganizationProfile>` runs the step-up dialog and repeats the delete, and shows no error when the user closes it. New routes `GET /v1/client/me/organization-invitations` (the pending invitations sent to the user's own verified address: an id, the organization's name, the role and the expiry, never the token; paged) and `POST …/{invitationId}/accept` and `…/decline` (the session authorizes it; an id that is not the caller's is `organization.invitation_not_found`). `@tula-tech/contract` gains `MyOrganizationInvitationSchema`, `MyOrganizationInvitationListSchema` and `MyOrganizationInvitationQuerySchema`. `@tula-tech/core` gains `organizations.invitations.mine()`, `.acceptMine(id)` and `.declineMine(id)`. `<OrganizationSwitcher>` lists those invitations when the panel opens, with Accept and Decline; its words are `organizationSwitcher.pendingInvitationsTitle`, `pendingInvitationText`, `pendingInvitationAcceptLabel` and `pendingInvitationDeclineLabel`. `@tula-tech/nextjs` re-exports the components. The member list now looks its users up in one call.
- 2ee73d3: A signed-in user's own organizations and the active organization. `@tula-tech/core` gets `client.organizations.list()`, `.create(input)` and `.setActive(id | null)`, and the signed-in state gains `organizationId`, read from the access token's `org_id`. The access token carries `org_id`, `org_role` and `org_perms` while an organization is active (reserved claim names, a cap of their own, none of them when over it); a refresh re-reads the membership, so a removal or a demotion takes effect at the next refresh and the session stays. The contract gains the schemas for `GET`/`POST /v1/client/me/organizations` and `PUT /v1/client/me/organizations/active`, `readOrganizationClaims` and the error codes `organization.not_a_member`, `organization.creation_disabled`, `organization.limit_reached` and `organization.personal_account_disabled`. `@tula-tech/react` and `@tula-tech/nextjs` only follow the new field of the auth state.
- 24288d6: Invitations to an organization by email (ADR 0065, Orgs 04). `@tula-tech/core` gets `client.organizations.invitations` (`invite`, `list`, `revoke`, `preview`, `accept`, `decline`) and `readInvitationLink(url)`, which reads the token from the `#tula_invitation=…` fragment of the emailed link and returns the URL without it. Only the account the invitation was sent to, with that address verified, can accept or decline it; the token is single use, valid for 7 days, stored only as a hash and never in a response. `@tula-tech/admin` gains the admin routes (`GET`/`POST /v1/admin/organizations/{id}/invitations`, `DELETE …/{invitationId}`). The contract gains the invitation schemas, the email kind `organization_invitation` (with the template placeholder `expiresInDays`; there is none for the organization's name or the address), the permission constant `INVITATIONS_MANAGE_PERMISSION`, four activity types (`organization_invitation.created`, `.accepted`, `.declined`, `.revoked`) and ten error codes (`organization.permission_required`, `.role_not_assignable`, `.invitation_exists`, `.invitation_not_found`, `.invitation_expired`, `.invitation_revoked`, `.invitation_used`, `.invitation_wrong_account`, `.invitation_email_unverified`, `.invitation_role_gone`). `@tula-tech/react`, `@tula-tech/nextjs` and `@tula-tech/expo` only carry the new types and error codes.
- Updated dependencies [d57ea22]
- Updated dependencies [110ae64]
- Updated dependencies [568bcec]
- Updated dependencies [595f5d9]
- Updated dependencies [2d098d6]
- Updated dependencies [e15bd1c]
- Updated dependencies [ef6030d]
- Updated dependencies [2ee73d3]
- Updated dependencies [ef92c8b]
- Updated dependencies [24288d6]
- Updated dependencies [358f646]
- Updated dependencies [9c2bafb]
- Updated dependencies [ad8b8e2]
- Updated dependencies [048f982]
- Updated dependencies [721ed9e]
- Updated dependencies [ece0a87]
  - @tula-tech/contract@0.3.0
  - @tula-tech/core@0.3.0
  - @tula-tech/react@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [b69f95e]
- Updated dependencies [a07a717]
- Updated dependencies [f56f6b5]
  - @tula-tech/react@0.2.0
  - @tula-tech/contract@0.2.0
  - @tula-tech/core@0.2.0

## 0.1.1

### Patch Changes

- @tula-tech/contract@0.1.1
  - @tula-tech/core@0.1.1
  - @tula-tech/react@0.1.1

## 0.1.0

### Minor Changes

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
- e778397: The interceptor refreshes sessions on Next.js 15.
  
  Next.js 15 runs `middleware.ts` in its Edge runtime, whose `Request`, built from another
  `Request`, keeps only the URL. The server-side refresh and the check of a `stateful` session
  were sent through such a copy, so they reached the API as a bare `GET` (answered 404): an
  expired access token was never replaced by the interceptor, a request with only the refresh
  cookie was signed out for server components and route handlers, and a `stateful` session was
  never signed in on the server. Every call to the API is now built once, from its URL and parts.
  Next.js 16 (`proxy.ts`, Node.js runtime) was not affected.
- a070549: `auth()` no longer disagrees with the interceptor behind a proxy that ends TLS and sends no
  `X-Forwarded-Proto`.
  
  Next.js writes `x-forwarded-proto` itself (`http`, from its own socket) when no proxy sent it,
  so the rule "read the `__Host-` cookie names when a `__Host-` cookie is present and nothing
  says the scheme" never applied under a real Next.js server. With `appUrl` passed to the
  interceptor and the handler as an option and no `TULA_APP_URL`, a signed-in visitor was sent
  back and forth between a protected page and the sign-in page without end.
  
  - With no app URL configured, a request that carries one of the SDK's `__Host-` cookies is
    read under the `__Host-` names even if `X-Forwarded-Proto` says `http`. The interceptor, the
    route handler and `auth()` / `currentUser()` now choose the names by the same rule. A
    configured app URL still wins over everything, and a forwarded `https` still means https.
  - With neither an app URL nor a forwarded `https`, the handler still refuses every write from
    an https page (`request.origin_not_allowed`); it now reports the likely cause once
    (`onWarning`, or `console.warn`): set `TULA_APP_URL`, or have the proxy send
    `X-Forwarded-Proto: https`.
  
  - Where the `__Host-` names are in use only because such a cookie arrived, an answer that
    sets or clears one of the app's cookies (a sign-in, a refresh, a sign-out, a refused
    refresh) now also expires `tula_at`, `tula_rt` and `tula_session`. On `localhost`, where
    cookies are shared across ports, an earlier sign-in over http could otherwise come back
    after a sign-out. With an app URL or a forwarded `https` nothing changes.
  
  Setting `TULA_APP_URL` remains the recommended way.
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
- Updated dependencies [a036657]
- Updated dependencies [a34eb0e]
- Updated dependencies [b38efc0]
- Updated dependencies [1c76ead]
- Updated dependencies [55115bc]
- Updated dependencies [0a5e496]
- Updated dependencies [9166270]
- Updated dependencies [ac15d68]
- Updated dependencies [462aee1]
- Updated dependencies [d013691]
- Updated dependencies [f3216d0]
- Updated dependencies [75b1b36]
- Updated dependencies [7f204ac]
- Updated dependencies [ee1e737]
- Updated dependencies [9d2a864]
- Updated dependencies [9d2a864]
- Updated dependencies [191d835]
- Updated dependencies [4e15bd1]
- Updated dependencies [bce497c]
- Updated dependencies [ac05f56]
- Updated dependencies [bb0da88]
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
- Updated dependencies [9c6253e]
- Updated dependencies [82d87eb]
- Updated dependencies [fc7d990]
- Updated dependencies [4edac20]
- Updated dependencies [596b4cd]
- Updated dependencies [894b927]
- Updated dependencies [751eae5]
- Updated dependencies [633d73b]
- Updated dependencies [633d73b]
- Updated dependencies [59c2709]
- Updated dependencies [99593eb]
- Updated dependencies [f226695]
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
  - @tula-tech/core@0.1.0
  - @tula-tech/react@0.1.0

## 0.1.0-alpha.1

### Patch Changes

- @tula-tech/contract@0.1.0-alpha.1
  - @tula-tech/core@0.1.0-alpha.1
  - @tula-tech/react@0.1.0-alpha.1

## 0.1.0-alpha.0

### Minor Changes

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
- e778397: The interceptor refreshes sessions on Next.js 15.
  
  Next.js 15 runs `middleware.ts` in its Edge runtime, whose `Request`, built from another
  `Request`, keeps only the URL. The server-side refresh and the check of a `stateful` session
  were sent through such a copy, so they reached the API as a bare `GET` (answered 404): an
  expired access token was never replaced by the interceptor, a request with only the refresh
  cookie was signed out for server components and route handlers, and a `stateful` session was
  never signed in on the server. Every call to the API is now built once, from its URL and parts.
  Next.js 16 (`proxy.ts`, Node.js runtime) was not affected.
- a070549: `auth()` no longer disagrees with the interceptor behind a proxy that ends TLS and sends no
  `X-Forwarded-Proto`.
  
  Next.js writes `x-forwarded-proto` itself (`http`, from its own socket) when no proxy sent it,
  so the rule "read the `__Host-` cookie names when a `__Host-` cookie is present and nothing
  says the scheme" never applied under a real Next.js server. With `appUrl` passed to the
  interceptor and the handler as an option and no `TULA_APP_URL`, a signed-in visitor was sent
  back and forth between a protected page and the sign-in page without end.
  
  - With no app URL configured, a request that carries one of the SDK's `__Host-` cookies is
    read under the `__Host-` names even if `X-Forwarded-Proto` says `http`. The interceptor, the
    route handler and `auth()` / `currentUser()` now choose the names by the same rule. A
    configured app URL still wins over everything, and a forwarded `https` still means https.
  - With neither an app URL nor a forwarded `https`, the handler still refuses every write from
    an https page (`request.origin_not_allowed`); it now reports the likely cause once
    (`onWarning`, or `console.warn`): set `TULA_APP_URL`, or have the proxy send
    `X-Forwarded-Proto: https`.
  
  - Where the `__Host-` names are in use only because such a cookie arrived, an answer that
    sets or clears one of the app's cookies (a sign-in, a refresh, a sign-out, a refused
    refresh) now also expires `tula_at`, `tula_rt` and `tula_session`. On `localhost`, where
    cookies are shared across ports, an earlier sign-in over http could otherwise come back
    after a sign-out. With an app URL or a forwarded `https` nothing changes.
  
  Setting `TULA_APP_URL` remains the recommended way.
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
- Updated dependencies [a036657]
- Updated dependencies [a34eb0e]
- Updated dependencies [b38efc0]
- Updated dependencies [1c76ead]
- Updated dependencies [55115bc]
- Updated dependencies [0a5e496]
- Updated dependencies [9166270]
- Updated dependencies [ac15d68]
- Updated dependencies [462aee1]
- Updated dependencies [d013691]
- Updated dependencies [f3216d0]
- Updated dependencies [75b1b36]
- Updated dependencies [7f204ac]
- Updated dependencies [ee1e737]
- Updated dependencies [9d2a864]
- Updated dependencies [9d2a864]
- Updated dependencies [191d835]
- Updated dependencies [4e15bd1]
- Updated dependencies [bce497c]
- Updated dependencies [ac05f56]
- Updated dependencies [bb0da88]
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
- Updated dependencies [9c6253e]
- Updated dependencies [82d87eb]
- Updated dependencies [fc7d990]
- Updated dependencies [4edac20]
- Updated dependencies [596b4cd]
- Updated dependencies [894b927]
- Updated dependencies [751eae5]
- Updated dependencies [633d73b]
- Updated dependencies [633d73b]
- Updated dependencies [59c2709]
- Updated dependencies [99593eb]
- Updated dependencies [f226695]
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
  - @tula-tech/core@0.1.0-alpha.0
  - @tula-tech/react@0.1.0-alpha.0
