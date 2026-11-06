# ADR 0067: Enterprise single sign-on

Status: accepted (Phase 4, [plan](../plans/phase-4.md)). This ADR covers the decisions of
TULA-135: the SAML library and the response verifier. Later tickets of the phase add their
own sections.

## Context

Phase 4 lets an organization ([ADR 0065](0065-organizations.md)) connect its identity
provider. OIDC reuses the OAuth machinery. SAML needs an XML signature check, the part of the
protocol with the longest history of bypasses (signature wrapping, comment injection in a
`NameID`, a key taken from the document itself).

## Decision

### Library: `xml-crypto` and `@xmldom/xmldom`, used directly

| Option | Verdict |
| --- | --- |
| `@node-saml/node-saml` | Maintained and complete, but it decides audience, time and `InResponseTo` itself with options that default loose, and it has had signature CVEs of its own (CVE-2025-54419, fixed in 5.1.0; quoted from memory, check before relying on it). Tula must own those decisions, so it would be wrapped and re-checked anyway. |
| `samlify` | Smaller maintenance, a signature-verification CVE in 2025 (CVE-2025-47949, from memory), and a template-based API that hides what was signed. Rejected. |
| `xml-crypto` + `@xmldom/xmldom` directly | Chosen. Both are pure JavaScript and run on Bun (tested here). The CVEs of `xml-crypto` (CVE-2024-32962, a key taken from `KeyInfo`, fixed in 6.0.0; CVE-2025-29774 and CVE-2025-29775, fixed in 6.0.1; from memory) are the very bugs the verifier's rules close, and it uses version 6.4.0. `@xmldom/xmldom` 0.9.x is past its parsing CVEs (CVE-2021-21366, CVE-2021-32796, CVE-2022-39353). |

The library does two things only: parse and check one signature. Every decision about what
was signed, for whom and for when is Tula's, in `apps/api/src/lib/saml-verifier.ts`, the one
place a SAML response is accepted.

### Verifier policy

- SP-initiated, POST binding, unencrypted assertions only. An unsolicited response (no
  request id) and IdP-initiated sign-in are refused (`unsolicited`).
- A DOCTYPE or entity is `forbidden_xml`; the response is size-capped before decoding.
- Exactly one `Assertion`, a direct child of the `Response`, carrying its own signature
  (`assertion_unsigned` when only the response is signed). The signature's reference must be
  `#<that assertion's ID>`; algorithms are an allow-list (RSA-SHA2 family, no SHA-1).
- The key is only ever one of the connection's configured certificates (any of them, so a
  rollover works); `KeyInfo` is never trusted (`certificate_not_configured`).
- The assertion is read **only from the canonical XML the signature covers**. A `NameID` is
  one plain text node in the document as sent too, because canonicalisation drops comments
  (`name_id_invalid`).
- Issuer, `Destination`, `Recipient`, audience, `InResponseTo` and status are compared by
  Tula, each with its own refusal code; times allow 2 minutes of skew
  (`SAML_CLOCK_SKEW_MS`) and read `deps.clock`.
- Replay uses the existing `ProofReplayGuard` port (memory and Redis), last, so that a forged
  response burns no assertion id; the guard fails closed.

### The mock signer

`adapters/oauth/mock-saml.ts` builds signed and deliberately wrong responses with published
throwaway test keys (`mock-saml-keys.ts`). It throws unless `OAUTH_MOCK_PROVIDER` is on
(which `env.ts` already limits to the `local` tier and a loopback `PUBLIC_URL`), and a test
fails if any file outside tests imports it.

### Replacing the library

Only `saml-verifier.ts` imports the two packages. A replacement keeps `verify`'s signature
and passes the same table of refusals.

## SAML connections (TULA-139)

- A SAML connection is a row of the same table with a `saml` JSON column (entity id, SSO URL, metadata
  URL, up to two certificates each with its own `notAfter`). Metadata is read, not trusted: a DTD or
  entity is refused, only signing keys are taken, and its own signature is **not** verified (the operator
  chose where it comes from; every response is still verified against the stored certificates). A
  metadata URL goes through `Outbound.request`.
- The ACS accepts only a response to an AuthnRequest this server made (the request id is held in the
  attempt's state); `RelayState` is the flow state. `verify` in `lib/saml-verifier.ts` is the only
  acceptor; its replay guard (`proofReplay`) is the shared port, so two instances share it.
- Every failure is one `sso.provider_error` to the browser and the fixed reason in the log.
- SP metadata is public per connection and built by `buildSpMetadata`; the SP entity id is its URL.

## Attribute mapping and groups mapped to roles (TULA-144)

- **Attributes.** A connection's `attributeMapping` names the attribute (SAML) or claim (OIDC) that
  carries the email, first name, last name and groups. Left out, the preset of its `idp` (`okta`,
  `entra`, `google_workspace`, `jumpcloud`, `onelogin`, `ping`, `generic`) applies, per protocol
  (`SSO_ATTRIBUTE_DEFAULTS` in the contract); one named field replaces that field's names only.
- **Groups to roles are held per organization**, not per connection (`organization_group_roles`), so
  that SCIM Groups (TULA-150) read the same mapping. The admin routes are
  `GET|PUT /v1/admin/sso-connections/:id/group-roles`; a save replaces the whole list, refuses a role
  that does not exist (`organization.role_unknown`) and a group named twice.
- **Precedence: the saved order.** A user in several mapped groups gets the role of the first mapped
  group, in the order the list was saved, that is among their groups. A user in none of the mapped
  groups gets the connection's `defaultRole`. An organization with no mapping at all leaves a member's
  role alone (the default role is given only when the membership is created).
- **The role is set at every sign-in**, through the organization service (`changeMemberRole`), so the
  last-manager rule holds: a demotion of the only manager is refused, the sign-in still succeeds with
  the old role, and a warning with the fixed reason (`organization.last_manager`) is logged.
- **A group name is directory data.** It lives in the attempt state until the ticket is exchanged and
  in the mapping table; it is never in an audit entry, an event payload or a log line. Saving the
  mapping is the existing `sso_connection.updated` event with `changed: ['groupRoles']`, which says
  that it changed and not what it holds. At most 200 values of 256 characters are read from a profile.
## Test sign-in and activation (TULA-145)

- A test round is a flow attempt of kind `sign_in` marked by `state.ssoTest`, with a secret nobody
  holds; it needed no new flow kind. The callback stops before `finish()`: no session, user, identity
  or membership is created, and no assertion or token is kept in the result.
- This is the one place a refusal reason is shown. Each verifier failure maps to a contract reason
  code (`SSO_TEST_REASONS`) and a sentence for the person setting the connection up; a real sign-in
  still says only `sso.provider_error`.
- The connection stores `testedFingerprint`, a SHA-256 of the settings a sign-in depends on. `tested`
  is true only while it matches, so any such change needs a new test. Activation without it is
  `sso.test_required` (409).
- A SAML SSO URL and an OIDC authorization endpoint are https, `http` only in the `local` tier
  (`sso.url_not_https` on save; `discovery_failed` when discovery names one).

## SCIM (TULA-143)

An organization's directory provisions users through `/v1/scim/v2`, behind a SCIM token
(`tula_scim_<environment>_…`, stored as a SHA-256 hash, shown once). The token is accepted by
that middleware and refused by `secretKey()` and `agentKey()`. The routes have no OpenAPI
description on purpose: no SDK or dashboard is generated from them. They answer RFC 7644 error
documents. Ownership is a column, `users.managed_by_directory_id`: only a user the directory
created, and who has no other membership, is banned or deleted by it; anyone else only loses
the membership. A reactivation lifts only the ban of the directory's own deactivation, never an
operator's. Membership changes go through the Organizations service, so the last-manager
rule of ADR 0065 holds and answers 409. The actor of an audit entry is `directory`. A create
that cannot join the organization removes the account it just made (a compensating delete, so a
crash between the two leaves it), and a name sent by the directory is kept in step with the user. So is its
address (`userName` on a PUT or PATCH), but only for a user the directory manages and only to an
address on one of the organization's verified domains (400 `invalidValue` otherwise, 409
`uniqueness` when taken; a refused request changes nothing, and a request that deactivates the user
deactivates first and drops a refused rename); the entry says `changed: ['email']`. Resources carry `meta.location`.

**Groups (TULA-150).** `/Groups` and `/Groups/:id` (list with `displayName eq`, create, read,
replace, patch, delete) keep a group and its members per organization (`scim_groups`,
`scim_group_members`). Patch takes `op` in any case, a `members` value array (Entra) and
`members[value eq "id"]` paths (Okta); `excludedAttributes=members` leaves the members out. A
group's role comes from the same mapping and the same function an SSO sign-in uses
(`roleForGroups`), so the two cannot disagree; the SCIM default, when the organization maps no
group a user is in, is the organization's connection's `defaultRole` (the active one, else the
most recently tested, else `member`), the same role an SSO sign-in gives. Role changes go
through `Organizations.changeMemberRole`: taking the only manager out of the mapped group is a 409
and nothing changes. The role changes and the group write are applied and rolled back by hand,
not one database transaction: they are separate stores (organizations, SCIM), and a failure
between them undoes the role changes in reverse. A user create is the same: a compensating
delete, and when even that fails the retry adopts the half-made account (a managed user with no
SCIM record) instead of answering 409, so the directory converges. Group names never reach an audit entry or an event, only ids.
A setup-portal link creates the organization's SCIM token (`POST /v1/setup/scim-tokens`, shown
once, no list or read). Bulk is not supported. Usage is in [docs/scim.md](../scim.md).

**Decisions of the Phase 4 review.** A setup link cannot map a group to a role that holds a
system permission (`sso.role_not_allowed`, 403): "privileged" means an `org:sys:*` key other than a
`:read` one, so the built-in `member` stays mappable; an existing privileged mapping is kept and
shown `locked`. The SCIM token request of the portal takes the organization from the link and
never from the body. `audit.exported` is written twice: `phase: 'started'` before the first byte
(the filters, no rows) and `phase: 'finished'` with the count; a response cannot carry a trailer
and the log is append-only, so the second is a new entry, and the export leaves its own started
entry out of the stream.

## Amendments

- [ADR 0065](0065-organizations.md): an organization may own SSO connections (the tickets
  after this one add the tables).
- [ADR 0012](0012-events-and-audit-log.md): SSO activity types are added with their contract
  schemas, as any new type.
- [ADR 0019](0019-flow-engine-v2.md): an external sign-in completes through the flow engine's
  shared completion path (TULA-136).
- [ADR 0050](0050-native-type-generation.md): native types will be generated for the SSO
  operations once their routes exist.

## Review amendments (Phase 4)

- **The portal cannot map a privileged role.** Through a setup link a group may be mapped only to a
  role holding no `org:sys:*` permission; anything else is refused `sso.role_not_allowed` (403), and an
  existing privileged mapping is shown read-only (`locked`). The operator and an organization admin with
  `org:sys:sso:manage` can map any role. A leaked link must not let its holder make their own provider
  group organization admins.
  The lock also holds where a role is applied: a SCIM token the portal minted (`scim_tokens.via_setup_link`)
  is refused a push (400 `invalidValue`) that would give a member a privileged role, and nothing changes;
  a token an operator minted applies the mapping.
- **One default role.** A SCIM-provisioned member in no mapped group gets the role a sign-in would give:
  the default role of the organization's active connection (else the most recently tested, else `member`).
- **Managed users are locked from the client.** While a user is managed by a connection or by a directory,
  client routes that change the email address or the password are refused with a contract code. Admin
  routes still can. The guard sits in the one function that stores a user's own password, so a reset
  finish and an expired-password replacement are refused too (`user.managed`, the reset code unspent);
  a reset start for a managed user gets the decoy attempt of an unknown address, notice included, except
  for a break-glass member, who keeps the reset.
- **Enforcement covers sign-up, verification and password reset.** On an enforced domain sign-up is
  refused (`auth.method_disabled`); a reset email goes only to a break-glass member, and the answers do
  not reveal which address exists.
- **A connection can be deleted after use** when it is a draft or disabled; its identities and domain
  bindings go with it and its users keep their accounts.
- **SCIM may change the email of a user its directory manages**, only to an address on the organization's
  verified domains and unique in the environment (409 otherwise), audited without the address.
- **No audit-export trailer.** Trailers cannot be read from browser `fetch` or most HTTP clients, so the
  resume cursor is derived from the last row (`auditExportCursor`; `tula audit export` prints it). The
  export records `audit.exported` up front and again, finished, with the count.
- **One weakening rule.** `ssoWeakenings` in `@tula-tech/contract` is the rule; the server's audit
  `weakened` flag and the dashboard's confirmation both use it.

## Enforced connections, the break-glass role and MFA trust (TULA-140)

- **Enforcement is by domain.** An active connection with `enforced: true` removes every
  other first factor for the addresses of its verified domains: the start offers only `sso`
  (the attempt's state keeps the full list so that a disabled strategy is still
  `flow.invalid_step`), and each other first factor's own route (password, emailed code and
  link, passkey, provider callback, texted code) refuses through `Sso.requireNotEnforced` with
  `auth.method_disabled`. An unknown address on an enforced domain gets the same answer as
  a known one. A texted code is judged by the holder's address, not by the phone number.
- **Break-glass.** `breakGlassRole` names an organization role. A member of the connection's
  organization holding that role may sign in with a **password**, and with nothing else.
  **The rule: an answer that depends on who the address belongs to must not differ between
  members and non-members.** So the password step never says `auth.method_disabled`: for an
  enforced domain it runs the same (dummy or real) verify and answers `auth.invalid_credentials`
  (`Sso.refuses`) for an unknown address, a non-member and a member with a wrong password
  alike; only a member with the right password signs in. Every other first factor refuses
  `auth.method_disabled` whoever asks, because break-glass does not cover it, so that answer
  is a fact about the domain. The check is at the route, not at the start, so the start never
  reveals membership either.
- **MFA trust.** With `trustIdpMfa: true` an SSO sign-in records `amr` `sso` and `mfa` and
  requires no further factor, also under `mfa.policy: required`. Off, it stops at
  `needs_second_factor` or `needs_factor_enrolment` like any first factor.
- **Weakenings.** Switching enforcement off, turning on `trustIdpMfa` and setting a
  break-glass role are weakenings (`weakens` in `modules/sso-connection/service.ts`): the
  connection-update audit entry says `weakened: true`. Connections are not in `tula apply`
  (only `settings.sso.enabled` is), so the classification lives on that entry; the
  dashboard screen arrives with TULA-146.

## Setup links and the self-serve setup portal (TULA-149)

An operator (`/v1/admin/setup-links`) or an organization administrator holding
`org:sys:sso:manage` (`/v1/client/me/organizations/:id/setup-links`) makes a setup link for one
organization: 1 to 30 days (default 7), revocable. It opens `/dashboard/setup`, a public page of
the dashboard build, so that the organization's IT administrator sets up SSO with no account.

- **Own credential.** The token is `tula_setup_<environment>_<random>`, shown once, stored as its
  SHA-256 hash, and every failure is `auth.invalid_key`. The setup routes accept it only, in the
  `x-tula-setup-token` header; `secretKey()`, `agentKey()`, `scimToken()` and the dashboard
  session never accept it and the setup routes never accept them.
- **The token travels in the URL fragment**, which no server or referrer sees. The portal reads
  it once, removes it with `history.replaceState`, holds it in memory only (never storage) and
  sends it as the header, with `credentials: 'omit'`, `referrerPolicy: 'no-referrer'` and
  `cache: 'no-store'`. The server builds the full link from `PUBLIC_URL` and returns it in the
  create response only; the dashboard never builds it from `window.location`.
- **Scope.** `/v1/setup/*` calls the same sso-connection functions with actor `setup_link`, for
  the link's organization only: another organization's connection answers 404. The portal can
  create, edit, refresh metadata, map attributes and groups, run the test sign-in and activate.
  It **cannot change enforcement, MFA trust (`trustIdpMfa`), the break-glass role or the default
  role**, and cannot delete a connection: those weaken the organization's posture and stay with
  an operator or an administrator signed in. Activation needs a passing test, as everywhere.
- **Accepted residual.** Whoever holds the link controls the identity provider they configure, so
  they decide which groups it reports; mapped roles are bounded by the group-role mapping rules
  and the roles the organization already has. A link is therefore as sensitive as an invitation
  to administer sign-in: it is shown once, expires and is revoked in one click.
- **The test sign-in** opens in a popup. The IdP returns it to `PUBLIC_URL/dashboard/setup#tula_test=<id>`
  (the redirect is built by the server, `serverBuilt`, never taken from the request); that window
  holds no token, posts the id on a `BroadcastChannel` and closes, and the opener polls the test.
  The test creates nothing, as in TULA-145.
- **Limits and audit.** Per-link and per-IP rate limits (`route-guards.test.ts`); every portal
  change is an audit entry with actor `setup_link`; used links record `lastUsedAt`; expired links
  are purged by the retention job.

## Organization admins manage their own SSO (TULA-148)

- **Routes.** `/v1/client/me/organizations/:organizationId/sso-connections` (list, read,
  create, change, delete, refresh metadata, group roles) and `…/:id/tests` (start) and
  `…/:id/tests/:testId` (result), behind `publishableKey()` and `sessionAuth()`, each with a
  per-IP limit; a test start also has a per-environment limit. They are another way in to
  the same service functions (`SsoConnections`, `SsoTests`) as the admin routes, never a
  second implementation of a rule: the activation gate (`sso.test_required`), the domain
  rule and the weakenings apply to an organization admin exactly as to an operator.
- **The permission is `org:sys:sso:manage`**, read from the caller's membership on every
  call (`findUserMembership`), never taken from a token or the SDK. A member without it,
  a user who is not a member and a connection that belongs to another organization are
  refused the way the sibling organization routes refuse them (`organization.permission_required`,
  `organization.not_a_member`, `sso.connection_not_found`). Every route has a test for that.
- **Weakenings need a recent authentication.** Turning a connection on, switching
  enforcement off, turning `trustIdpMfa` on and setting a break-glass role are weakenings
  (`weakened: true` in the audit entry) and answer `auth.step_up_required` until the session
  has authenticated recently (`Mfa.requireRecentAuthentication`).
- **The client secret is write-only**: accepted on create and change, answered only as
  `clientSecretSet`.
- **Break-glass covers the password only** (it is the password step that lets the role
  through); the dashboard copy of TULA-146 says "keeps password sign-in".
- `@tula-tech/core` exposes `organizations.sso`, `@tula-tech/react` an SSO tab in
  `<OrganizationProfile>` for OIDC connections (list, add, turn on and off, require, delete).
  SAML, group roles and the test sign-in are not drawn there yet; the test is available to
  any client through `startTest` and `testResult`.

## Addendum: the domain list is a filter (TULA-158)

A connection's stored domains are never the proof. Finding a connection for an address and
accepting an IdP's account both re-check a verified, unlapsed domain row of the connection's
organization, so a lapse (which is time-based) or a lost name stops SSO at once. Removing a domain
also deletes its binding to the organization's connections in the same transaction, audited as
`sso_connection.updated` with `changed: ['domains']`.
A lapse is never written (the reminders job only emails), so the sign-in check is the defence for
it; an organization taking over a name ends the old claim through the same removal.

**Group-role mappings outlive their connection (H-232).** `organization_group_roles` is keyed
by organization, so deleting an SSO connection leaves its mappings. They are inert without a
connection, an organization can change its identity provider and keep its mappings, and
nothing reads them until a connection signs a user in. Kept deliberately.
