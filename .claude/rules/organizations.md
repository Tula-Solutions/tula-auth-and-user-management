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
- **A manager acts only on members within their own permissions** (`requireOutranks` in
  `member-service.ts`): changing the role of, or removing, a member who holds a permission the
  caller lacks is refused; leaving is exempt.
