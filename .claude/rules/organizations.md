---
paths:
  - "apps/api/src/modules/organization/**"
  - "apps/api/src/ports/organization-store.ts"
  - "apps/api/src/adapters/memory/organizations*"
  - "apps/api/src/adapters/postgres/organizations*"
  - "apps/api/src/adapters/organization-store.suite.ts"
  - "packages/db/src/schema/organization*"
  - "packages/db/migrations/0036_*"
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
  into the service, where two concurrent requests could both pass it. A user deletion does not
  take that lock (TULA-124).
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
  grants the migration gives it (column-level `UPDATE`; no `UPDATE` on roles). A new column
  that a statement writes needs its grant in a migration.
- `sys` is a reserved permission feature: a custom permission never uses it.

## What to test

- Disabled: every route, reads included, answers `organization.disabled` and writes nothing.
- Isolation: an organization, membership or role of another environment is not found, and a
  key of one environment cannot add its users to another's.
- Last manager: demote and remove both refuse, with a second manager they succeed, and the
  store suite proves it on the real database (`stores.integration.ts`).
- An agent key is refused on every write and may read.
- Event payloads parse against their schemas and contain no name, slug or address.
- Own routes: a non-member, a nonexistent id and another environment's organization answer the
  same; a removed or demoted member's next refresh drops or changes the claims and the session
  lives; an over-cap role issues no organization claims; two creates at the limit make one.
- Adapter parity: a new store behaviour is a case of the shared suite, not of one adapter.
