---
paths:
  - "apps/api/src/modules/organization/**"
  - "apps/api/src/modules/organization-role/**"
  - "apps/api/src/ports/organization-store.ts"
  - "apps/api/src/adapters/memory/organizations*"
  - "apps/api/src/adapters/postgres/organizations*"
  - "apps/api/src/adapters/organization-store.suite.ts"
  - "packages/db/src/schema/organization*"
  - "packages/db/migrations/0036_*"
  - "packages/db/migrations/0038_*"
  - "packages/db/migrations/0039_*"
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

## What to test

- Disabled: every route, reads included, answers `organization.disabled` and writes nothing.
- Isolation: an organization, membership or role of another environment is not found, and a
  key of one environment cannot add its users to another's.
- Last manager: demote and remove both refuse, with a second manager they succeed, and the
  store suite proves it on the real database (`stores.integration.ts`). A role update that
  strips the permission refuses alike.
- Custom roles: a stale version, a missing `If-Match`, a taken key (also `admin` and
  `member`), a role in use, the cap, a built-in role, and an agent key on every write.
- An agent key is refused on every write and may read.
- Event payloads parse against their schemas and contain no name, slug or address.
- Own routes: a non-member, a nonexistent id and another environment's organization answer the
  same; a removed or demoted member's next refresh drops or changes the claims and the session
  lives; an over-cap role issues no organization claims; two creates at the limit make one.
- Adapter parity: a new store behaviour is a case of the shared suite, not of one adapter.

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
  claim back. A role key that no longer exists is `invitation_role_gone`; never fall back to another role.
- **A client inviter offers only roles within their own permissions**
  (`role_not_assignable`); permissions come from `findUserMembership`, fresh, never the token.
- **No invited address, name or token in events, audit entries or logs.** The organization's
  name reaches an email only through the built-in wording (`displayName` + `escapeHtml`); the
  template has no placeholder for it.
- Test: every refusal code, the disabled state, an agent key on each write, a lapsed
  invitation replaced, two answers at once making one membership, a send that fails revoking
  the row, the purge in both adapters, and the canary on the four events.
