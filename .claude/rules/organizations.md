---
paths:
  - "apps/api/src/modules/organization/**"
  - "apps/api/src/modules/organization-role/**"
  - "apps/api/src/ports/organization-store.ts"
  - "apps/api/src/adapters/memory/organizations*"
  - "apps/api/src/adapters/postgres/organizations*"
  - "apps/api/src/adapters/postgres/manager-guard*"
  - "apps/api/src/adapters/organization-store.suite.ts"
  - "packages/db/src/schema/organization*"
  - "packages/db/migrations/0036_*"
  - "packages/db/migrations/0038_*"
  - "packages/db/migrations/0039_*"
  - "packages/db/migrations/0041_*"
  - "packages/db/migrations/0042_*"
  - "apps/api/src/modules/organization-domain/**"
  - "apps/api/src/ports/organization-domain-store.ts"
  - "apps/api/src/adapters/memory/organization-domains*"
  - "apps/api/src/adapters/postgres/organization-domains*"
  - "apps/api/src/adapters/organization-domain-store.suite.ts"
  - "packages/db/migrations/0040_*"
  - "packages/contract/src/organization*"
---

# Organizations

Canonical for this area ([ADR 0065](../../docs/adr/0065-organizations.md)); `AGENTS.md` lists
this file under "Area rules" and does not repeat it.

## Security rules (non-negotiable)

- **Every entry point of the service starts with `requireEnabled`.** While the environment's
  `organizations.enabled` is off, a route answers `organization.disabled` (403), a read as well
  as a write, and touches nothing. A new service function calls it first; never gate in a
  router only.
- **An organization always has a member who holds `org:sys:memberships:manage`.** The store
  methods that demote or remove a member (`changeRole`, `removeMembership`) check this inside
  the same transaction that locks the organization's row (`FOR UPDATE`) and answer
  `last_manager`; the service maps it to `organization.last_manager`. Never move the check
  into the service, where two concurrent requests could both pass it. **A user deletion is
  guarded the same way** (TULA-124): `UserRepository.delete` and `deleteTestUsersBefore` call
  `findBlocked` (`adapters/postgres/manager-guard.ts`), which locks the user rows, then every
  organization they belong to in id order (`FOR NO KEY UPDATE`: a `FOR UPDATE` would deadlock
  with a membership insert's key share), then reads; the answer is `last_manager` with the
  organization ids, and the service maps it to `user.last_organization_manager` (409). The
  memory users repository asks the organization store through `onBeforeDelete`. A new path
  that deletes a user goes through `UserRepository.delete`; never delete from `users` directly.
- **Both adapters decide alike.** The memory store follows the database: an unknown user,
  organization or role is `gone`, a deleted user's memberships go with them, a deleted
  organization's memberships go with it. The shared suite (`organization-store.suite.ts`) runs
  against both; a new rule is a case there first.
- **`ensureBuiltInRoles` is the one organization write that is not recorded**, because it
  records no decision of anyone (ADR 0012). Every other write takes an `Activity` built with
  `Audit.entry` and writes it in the same transaction. A built-in role is never edited or
  deleted, and the contract's `BUILT_IN_ROLES` is authoritative over the rows.
- **Event payloads carry no names or slugs.** An organization's events hold ids, role keys,
  field names and counts. Never a name, a slug or an address; `organization.updated` says
  that `name` changed, not what it is now. A new field needs the schema, the fixture and the
  event canary's blessing (`audit-and-events.md`).
- **A user's own organization routes** (`me-router.ts`, `me-service.ts`, Orgs 02) answer
  `organization.not_a_member` for an organization that does not exist, one the user is not in
  and one of another environment alike: never a second code for "no such organization".
  Permissions are read from `OrganizationStore.findUserMembership` (`UserMembershipRecord`)
  and nowhere else; the claims are built in `claims.ts`. `sessions.active_organization_id`
  has no foreign key and is never trusted: every token re-reads the membership, and a stored
  id that no longer matches yields no claims, not an error. Over the claims cap (ADR 0065)
  the token carries none of them. Creating counts `created_by` under a lock on the user row.
- Every tenant table here has forced row-level security, and the runtime role has only the
  grants the migration gives it (column-level `UPDATE`, on roles only `name`, `permissions`,
  `version` and `updated_at`, and `DELETE`, both held to custom rows by restrictive policies).
  A new column that a statement writes needs its grant in a migration. Never loosen
  `organization_roles_custom_update_only` or `organization_roles_custom_delete_only`, and add no
  policy on the table that is not restrictive.
- `sys` is a reserved permission feature: a custom role holds only the system permissions
  Tula defines (`SYSTEM_PERMISSIONS`) and no other `org:sys:*` key. `rolePermissionRefusal`
  in `@tula-tech/contract/organization-permissions` is the one place that says so; never
  re-implement the grammar in a service or an adapter.
- **Custom roles** (`modules/organization-role`, ADR 0065, "Custom roles"). A change needs
  the version it read (`If-Match`; `Settings.expectedRevision` and `Settings.etag` parse and
  write it): 428 without, 412 when stale. Giving a role a permission is the weakening
  (`organizationRoleWeakenings`); the event says `weakened: true` and nothing else about it.
  The cap of 50 is checked under `deps.environmentLock.runExclusive(env, 'organization_roles',
  …)`, never outside it. A role update that drops `org:sys:memberships:manage` takes the
  locks of the organizations that use the role (ordered by id, as the membership routes do) and
  answers `last_manager`; it never locks the role row first (the membership foreign key's
  share lock on it would deadlock with `changeRole`). A removal is refused while a membership
  uses the role, by a count and by the foreign key. A role's events hold its key, a count and
  field names: never a name and never a permission key. Permissions are never copied into a
  membership: they are read through the role at refresh time.

- **Verified domains** (`modules/organization-domain`, ADR 0065, "Verified domains"). A pending
  claim grants nothing: every join and every suggestion reads **verified** rows only. A code
  is stored as a keyed hash (`hashCode`), never the code, and is checked after the store has
  counted the guess (`recordAttempt`, atomic) and `deps.lockout` with `CREDENTIAL_LOCKOUT`
  has counted the attempt (cleared on success); never compare first. The send limits (a
  cooldown and an hourly cap per organization, a daily cap per environment, an hourly cap per
  hashed address) are in `start` and a new send path goes through it. The grammar and the
  public list are the contract's (`@tula-tech/contract/organization-domain-rules`): the
  service, the database check and the dashboard never keep a second copy of the rule, and a
  join re-checks the public list so that a claim stored before the list grew matches
  nothing. **Joining at sign-up is `joinOnSignUp` and it never throws** (a failure is logged,
  the sign-up completes); it runs for a sign-up only, never for a sign-in; and it counts only
  `emailVerifiedAt`, only the exact domain of the address, never a banned user, and joins with
  the environment's `defaultRole`. A client suggestion's join re-decides on the server
  (`suggestion_unavailable`). The client routes check `org:sys:domains:manage` through
  `requireEnabledManager` (`findUserMembership`, read now). **No event or audit entry holds
  the address the code went to**; the domain is the one allowed string, in its own field
  (`DOMAIN_FIELDS` in the event canary).
- **A verification lapses** (ADR 0065, "Lapse"; `DOMAIN_VERIFICATION_LIFETIME_DAYS`). Whether a
  row matches is `lapsed(record, now)` (`expires_at <= now`; no date counts as lapsed) and it is
  asked in `matchOf` and nowhere else: the join, the suggestions and a suggestion's join all go
  through it, and a new reader of verified rows goes through it too, never `findVerified` alone.
  The state is derived from the date, never a stored word a job must flip. Asking for a code for
  a domain the organization has verified is a re-verification: the row keeps its mode and its
  standing (the request's `mode` is ignored) and only `verify` moves the dates. Another
  organization's lapsed row is removed (recorded) by the `verify` that wins the name, never by
  `claim`. Rows verified before migration 0042 get the later of `verified_at` plus a year and 30
  days from the migration; write no migration that shortens that.
- **The reminder job** (`reminders.ts`) takes a reminder in the store (`takeReminder`, a guarded
  update) **before** sending and gives it back only when nothing could be sent; it emails
  managers read from the role now, carries no code, link or domain name (a domain reads as a
  link: `organization_domain_expiring` names the organization and a count), is never awaited by
  a request, is bounded by the rate limiter (fails closed), and runs in API processes only. A
  new threshold is an entry of `DOMAIN_REMINDER_DAYS`.
- **The daily allowance of codes is per organization and per creator** (`start`): an
  organization with `createdBy` gets the lower cap and shares `CODES_PER_CREATOR_PER_DAY` with
  the creator's others; `domain_taken` for another organization's live verification spends the
  hourly allowance first (a probe). Keep both, and a limiter key holds ids only.

## What to test

- Disabled: every route, reads included, answers `organization.disabled` and writes nothing.
- Isolation: an organization, membership or role of another environment is not found, and a
  key of one environment cannot add its users to another's.
- Last manager: demote and remove both refuse, with a second manager they succeed, and the
  store suite proves it on the real database (`stores.integration.ts`). A role update that
  strips the permission refuses alike, and so does deleting the user (also racing a demotion
  of the other manager, and the purge of sign-in test users).
- Custom roles: a stale version, a missing `If-Match`, a taken key (also `admin` and
  `member`), a role in use, the cap, a built-in role, and an agent key on every write.
- An agent key is refused on every write and may read.
- Event payloads parse against their schemas and contain no name, slug or address.
- Own routes: a non-member, a nonexistent id and another environment's organization answer the
  same; a removed or demoted member's next refresh drops or changes the claims and the session
  lives; an over-cap role issues no organization claims; two creates at the limit make one.
- Adapter parity: a new store behaviour is a case of the shared suite, not of one adapter.
- Verified domains: grammar and public-list tables (contract), a pending claim joins nothing,
  a wrong code counts and the sixth guess is refused with the right code, an expired and a
  replaced code, two organizations racing for one name, sign-up joins and sign-in does not,
  an unverified, a banned, a subdomain and a stored-public-domain user match nothing, a
  removed domain keeps its members, `joinOnSignUp` swallows a store failure, the client
  routes' permission cases (forbidden, not a member, demoted at once), and the purge of
  expired pending claims in both adapters.
- Lapse: a lapsed claim stops auto-joining and stops suggesting (the minute either side of the
  deadline), re-verifying restores it and restarts the year, a re-verification keeps the mode and
  keeps matching meanwhile, another organization takes a lapsed name and not a live one, the
  reminder is sent once per threshold and carries no code or link, a failed send is retried, the
  creator and user-created caps, the probe limit, and the migration's backfill.

## Invitations (Orgs 04, ADR 0065 "Invitations")

- **The token is a `randomToken`, stored only as its SHA-256, single use.** It travels in a
  request body and in the URL *fragment* of the emailed link; never in a path, a query, a log,
  an event, an audit entry or a response (the list never returns it). The preview route and the
  two answers are rate-limited per IP.
- **Accepting is authorized by the session, not by the token.** The token only finds the
  invitation; the signed-in user's *verified* email must equal the invited one. A new answer
  path keeps both checks (`invitation_wrong_account`, `invitation_email_unverified`).
- **Accepting uses the invitation and creates the membership in one transaction**
  (`acceptInvitation`): the invitation row is claimed by a conditional update on `pending`,
  so two answers at once make one membership, and a duplicate member or a gone user rolls the
  claim back. A role key that no longer exists is `invitation_role_gone`; never fall back to another role. A pending invitation follows its role key's
  current permissions (the subset check runs when it is sent), and a holder of
  `invitations:manage` may revoke any pending invitation of the organization; both are
  deliberate (Ollie round 1, F1 and F2).
- **A client inviter offers only roles within their own permissions**
  (`role_not_assignable`); permissions come from `findUserMembership`, fresh, never the token.
- **No invited address, name or token in events, audit entries or logs.** The organization's
  name reaches an email only through the built-in wording (`displayName` + `escapeHtml`); the
  template has no placeholder for it.
- **The invitee's own list and answers by id** (TULA-131, `listMine`, `acceptById`,
  `declineById`). Only a **verified** address is listed (an unproven one gets an empty page).
  An entry is `id`, organization name, role key and expiry; never the token, the address, the
  inviter or the organization id. An answer by id decides **whose** the invitation is before
  **what state** it is in, and an id that is not the caller's answers
  `organization.invitation_not_found` (never `wrong_account`, `used` or `revoked`): the route
  must not reveal that someone else was invited. Token and id paths share `acceptRecord` and
  `declineRecord`; a new rule goes there.
- Test: every refusal code, the disabled state, an agent key on each write, a lapsed
  invitation replaced, two answers at once making one membership, a send that fails revoking
  the row, the purge in both adapters, and the canary on the four events.

## Prebuilt components (Orgs 07, ADR 0065 "The prebuilt components")

- **A control is drawn only where `has()` permits, and the server decides again.** A refusal
  (`organization.permission_required`, `auth.forbidden`, `organization.not_a_member`) makes the
  component re-read the user's organizations and drop the control; never keep a stale one.
- **The client member routes read the caller's membership fresh** and refuse the removal or
  demotion of the last member who can manage members (`organization.last_manager`).
- **The invitation token never leaves the fragment**: `readInvitationLink` strips it from the
  URL; a component takes it as a prop, never from `location`, and never puts it in a request
  path, a query or a log.
- **Results belong to the session they were asked for**: an answer that arrives after sign-out
  or a user change is dropped. Words come from the localization groups, never from server text.
- Test: each tab per role, every refusal above, the unknown section, the switch and create
  failures, and axe in both colour schemes (`e2e/tests/organization-components.spec.ts`).
- **Deleting an organization from the client is behind `requireRecentAuth()`** (TULA-131),
  after `sessionAuth()` and before the permission is read: a stale session answers
  `auth.step_up_required` and nothing else. `GeneralSection` runs the call through
  `useStepUp()` and says nothing when the user closes the step-up dialog. A new destructive
  organization route gets the same middleware.
- Decision (TULA-157, H-122): **recommended, not built**: `requireRecentAuth()` on
  `PATCH` and `DELETE /v1/client/me/organizations/:id/members/:userId` when the target is
  another member (leaving stays free). Today both are `sessionAuth()` plus the permission and
  `requireOutranks`, so a stolen live session of a manager can demote or remove members
  without a step-up, which org delete and setup links now need. Left alone because the
  React `MembersSection` and the Expo/native screens would each need `useStepUp()` around
  the call in the same change, and a guard without them breaks the screens; do both together.
- Decision (TULA-157, H-008): **recorded, no change**: refreshing the metadata of an active
  SAML connection needs neither a step-up nor a re-test. Only a holder of `org:sys:sso:manage`
  reaches it, the metadata URL is the one already saved (the request carries none), and the
  same person can draft, test and reactivate to the same effect, so the step-up on
  `ssoWeakenings` (H-002/H-007) is the guard that matters. Revisit if the URL becomes
  editable in the same call.
- **A page of members is looked up with `UserRepository.findByIds`**, never one `findById`
  per member.
- **A manager acts only on members within their own permissions** (`requireOutranks` in
  `member-service.ts`): changing the role of, or removing, a member who holds a permission the
  caller lacks is refused; leaving is exempt.
- **An SSO connection's domain list is only a filter** (TULA-158): finding a connection for an
  address and accepting an IdP's account for linking both need a verified, unlapsed
  `organization_domains` row of the connection's own organization (`holdsDomain` in
  `modules/sso/service.ts`). Removing a domain (a takeover of a lapsed name included) unbinds it
  from the organization's connections in the same transaction, with an audit entry.
- **An SSO sign-in re-syncs a member's role from their groups, and it does downgrade** (H-021;
  `ensureMember` in `modules/sso/service.ts`, ADR 0067). Where the organization maps groups, every
  sign-in sets the role to the first mapped group the user is in, or to the connection's
  `defaultRole` when they are in none: leaving a group in the IdP removes its privileges. Two cases
  keep the old role: an organization with **no mapping** (the role is given only when the
  membership is created), and a change that `changeMemberRole` refuses, the last manager above
  all (the sign-in succeeds, a warning with the fixed reason is logged). Never make the re-sync
  skip the organization service, or the last-manager rule goes with it.

## Decisions awaiting review (TULA-157)

- **Decision (TULA-157, H-218): the shared per-environment invitation cap
  (`INVITATIONS_PER_ENVIRONMENT_PER_DAY`, 1000) stays.** It bounds what a compromised member's key
  can mail. Recommendation: make it a setting only when an operator asks; no code change.
- **Decision (TULA-157, H-221): no per-recipient cap across organizations yet.** Each organization
  already limits invitations per address; a cross-organization cap needs a keyed-hash counter on
  the address in the limiter. Recommendation: add it if abuse is seen; recorded, code unchanged.

- Decision (TULA-157, H-072): the organization claims (`claimsOf`, `fromMembership`) do not
  check `bannedAt`; recommended and left as is. They are built only for a live session or a
  token being issued, and a ban ends every session and refuses a refresh, a create and a
  second step (`sessions.md`, "The ban window"), so a banned user reaches the claims at most
  inside the access-token TTL, on a token that already holds them. A check there would add a
  user read to every token build for no window the denylist does not already close.

- Decision (TULA-157, H-066): deleting a custom role is refused only while a membership holds it
  (`organization.role_in_use`); a pending invitation, an SSO connection's `default_role` /
  `break_glass_role` and an `organization_group_roles` row refer to the role by **key**, on
  purpose, and stay deletable. Recommended and left as is: an invitation to a deleted role is
  refused at acceptance (`organization.invitation_role_gone`), a group mapping to one is skipped
  at sign-in, and blocking the delete on them would let any pending invitation pin a role for
  its 7 days. Recorded; code unchanged. A follow-up could list those references in the 409's
  `params` so the operator sees them.
- Decision (TULA-157, H-069): the per-organization invitation counter is charged before the
  environment's daily cap, and stays so. Charging the day cap first would let one organization
  spend the environment's shared budget with sends that its own limit then refuses. The fixed
  window has no undo, so a refused send still costs its organization one hit. Recorded; code
  unchanged.
- Decision (TULA-157, H-070): `claim` accepting `mode: 'auto_join'` on a pending domain stays.
  It is inert (matching needs a verified, unlapsed domain: `matchOf`) and the weakening is
  audited when the domain verifies. Rejecting it in `setMode` alone would be inconsistent with
  `claim` and needs a new contract error code. Recorded; code unchanged.
- Decision (TULA-157, H-071): the fixed-window boundary burst on invitation send limits (up to
  twice the nominal count across a boundary) is accepted. The daily environment cap and the
  per-address limit bound it; a sliding window needs a new limiter primitive for no change in
  the worst case per day. Recorded; code unchanged.
- Decision (TULA-157, H-073): no database constraint for the last-manager invariant yet. It is
  checked in the application, inside the write, in `organization-role/service.ts` and the
  member service; a constraint over "some member holds a role with `organization.members.manage`"
  is a deferred constraint trigger across three tables, which the schema conventions avoid.
  Recommendation: add it only if a second writer path appears. Recorded; code unchanged.
- Decision (TULA-157, H-074): the coarse per-IP limit on the client domain routes stays. Behind a
  shared NAT it can refuse honest users, but verification is also backed by the lockout and the
  per-code guess counter, so the IP limit is not what protects the secret. Recorded; code
  unchanged.
- Decision (TULA-157, H-017): **changed**. The SAML replay key is
  `saml:sha256(environmentId:connectionId \0 idpEntityId \0 assertionId)` (`replayScope` in
  `SamlExpectations`), so one IdP serving two connections, or two environments, cannot burn
  the other's assertion id.
- Decision (TULA-157, H-024): **changed**. An assertion whose `NotOnOrAfter` is more than
  `SAML_MAX_ASSERTION_LIFETIME_MS` (one hour) away is refused, so a far-future date cannot
  pin a replay key for ever.
- Decision (TULA-157, H-027): `SAML_RESPONSE_MAX_LENGTH` is 64 KiB, the global body limit
  (`MAX_BODY_BYTES`), so it is no longer a dead, larger number.
- Decision (TULA-157, H-028): **changed, narrower than the ticket**. The SP metadata route
  is 404 for a `disabled` connection only. A `draft` is still served: the admin registers
  the SP metadata with the IdP before activating.
- Decision (TULA-157, H-006) / H-246: nothing to build. `env.ts` already requires
  `REDIS_URL` outside the `local` tier, and the replay guard is run against FakeRedis and
  real Redis by `adapters/proof-replay.suite.ts`.
- Decision (TULA-157, H-209): **not pinned**. Discovery's `token_endpoint` and `jwks_uri` are
  not required to share the issuer's origin: Google Workspace serves them on `googleapis.com`
  under the issuer `accounts.google.com`, and a strict rule would refuse it. The endpoints are
  set by an administrator and fetched only through `Outbound`. If a pin is ever needed, add
  a per-connection allow-list of origins, not a same-origin rule.
- Decision (TULA-157, H-034): **changed**. An ID token with several audiences needs an
  `azp` equal to the client id (OIDC Core 3.1.3.7).
- Decision (TULA-157, H-035): **changed**. An unknown `kid` refetches the key set only if
  the cached set is at least 30 s old (`JWKS_REFETCH_COOLDOWN_MS`), so forged kids cannot
  drive a fetch per attempt; a real rotation is picked up on the next try after that.
- Decision (TULA-157, H-009): **recorded, no change**: the managed lock (`user/managed.ts`)
  holds while the connection row exists or an unrevoked SCIM token does; after a hard delete
  or a revocation the users become password-settable. Recommended as intended: a lock with
  nothing behind it would leave people unable to recover an account, and delete already
  refuses an active connection. Changing it needs the managed flag cleared or kept in a
  migration, so it is left to the owner.
- Decision (TULA-157, H-010): **recommended, not built**: disabling a connection stops new
  sign-ins (`Sso.requireActive`) and leaves issued sessions alive until they end. Recommended
  to keep that, and to offer revoking the connection's users' sessions as an explicit option of
  the disable call, through the session service so the ids are denylisted: revoking by default
  would sign out a whole organization on a mis-click. Not built: it changes what an existing
  call does to live sessions.
- Decision (TULA-157, H-011): **changed**: `fingerprint()` in `modules/sso-connection/service.ts`
  now also hashes `enforced`, `trustIdpMfa` and `breakGlassRole`, so a passing test attests to
  them; no schema change. Draft connections tested before this release need one new test; an
  active connection is not affected. Group-role mappings belong to the organization, not the
  connection, and are not in it. Test: `sso-connection/fingerprint.test.ts`.
- Decision (TULA-157, H-012): **recorded, no change**: editing an active connection weakens
  nothing a `org:sys:sso:manage` holder could not do by drafting, testing and reactivating,
  and the weakening is audited and step-up guarded (H-002/H-007). Re-gating an active
  connection on an edit would take sign-in down for a typo's duration; revisit if a way
  appears to test a change without leaving `active`.
- Decision (TULA-157, H-013): **recommended, not built**: `trustIdpMfa` records `mfa` without
  reading `amr`/`acr` or SAML `AuthnContext`. It is an explicit opt-in that says the IdP is
  trusted for MFA, and IdPs differ in what they send. Recommended: when a claim is present and
  names no second factor, fall back to local MFA; absent claim keeps today's trust. Not built:
  it changes who is asked for a second factor in `modules/flow` (security-sensitive) and needs
  per-IdP claim handling, so it wants the owner.
- Decision (TULA-157, H-014): **recorded, no change**: `resolveAccount` does not require
  `email_verified` on an OIDC profile before linking; the connection's verified, unlapsed
  domain (TULA-158, `holdsDomain`) vouches for the address, as its row 2 documents. The claim
  cannot be enforced "when present": `profileOf` reads an absent claim as `false`, and
  common IdPs (Entra ID) omit it, so enforcing it would refuse their whole organization.
- Decision (TULA-157, H-015): **recorded, no change**: a setup-link portal holder edits an
  active connection through the same update path. The holder is the operator's own
  customer's IT administrator, which is the portal's purpose, and the dangerous edits are
  already guarded by `ssoWeakenings`. Restricting them to non-active connections changes what
  a portal can do; the owner decides.
- Decision (TULA-157, H-016): **recorded, no change**: a setup link outlives its creator's
  demotion or removal until it expires (30 days at most) or is revoked (ADR 0067 accepts this
  as bearer-credential risk). Recommended: revoke an organization's links minted by a member
  when that member is removed or loses `org:sys:sso:manage`, from the member service, and show
  the creator in the link list. Not built: it changes the portal's access and spans
  `modules/setup-link`, which another ticket (TULA-171) is working in.
- Decision (TULA-157, H-047): **changed**: `Portal.createConnection` refuses a 51st connection
  for the organization with a 409 (`MAX_PORTAL_CONNECTIONS`), so a link holder cannot build more
  than the portal shows. The admin path keeps no cap.
- Decision (TULA-157, H-049): **recorded, no change**: SCIM `POST /Users` answers 409 for an
  address held anywhere in the environment because RFC 7644 asks for uniqueness, and the caller
  already holds an organization's SCIM token. Recommended, if the probe matters: refuse a
  `userName` outside the organization's verified domains with a uniform 400. Not built: it
  changes what directories may send.
- Decision (TULA-157, H-050): **recorded, no change**: SCIM tokens minted through a setup link
  outlive the link. They are capped (`MAX_LIVE_TOKENS`) and an organization admin lists and
  revokes them; a directory must keep syncing after the 30-day link ends. Recommended: show
  "created through a setup link" in the token list.
- Decision (TULA-157, H-051): **recorded, no change**: SCIM group role changes are put back by a
  compensating second round of writes, not atomically. A crash mid-commit can leave partial
  role changes. Recommended: a batch role change on the organization store, when one exists.
- Decision (TULA-157, H-058): **recorded, no change**: revoking a link leaves the tokens,
  connections and sealed secrets made through it, as the route description says. Recommended:
  an opt-in `cascade` on revoke, a contract change.
- Decision (TULA-157, H-059): **recorded, no change**: the portal has no connection delete, so
  drafts stay until an operator removes them. They are bounded by the 50-connection cap (H-047).
  Recommended: a portal delete for connections that are not enforced; a new route, so a contract
  change.
- Decision (TULA-157, H-060): **recorded, no change**: the portal lists mappings to privileged
  roles as locked, which shows the group names. Moot once a setup-link token cannot apply a
  privileged role (TULA-156); until then the names are the holder's own directory's groups.
