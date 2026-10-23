# ADR 0065 — Organizations, roles and memberships (and the import that goes with them)

- Status: accepted
- Date: 2026-10-22
- Ticket: TULA-110 (the plan), TULA-111 (this step: tables, settings, events, admin routes)
- Amends: [ADR 0036](0036-jwt-templates.md) (three reserved claims),
  [ADR 0039](0039-email-templates.md) (one email kind),
  [ADR 0012](0012-events-and-audit-log.md) (event types, one unrecorded write),
  [ADR 0030](0030-config-and-apply.md) (`organizations` settings, role keys in the file),
  [ADR 0050](0050-native-type-generation.md) (new generated error codes and types)

## Context

A B2B product has accounts that belong to groups: a company, a team, a workspace. Clerk,
WorkOS and Auth0 all sell this as "organizations", and a developer comparing auth products
asks for it before most other things. Without it every Tula user builds a `memberships`
table of their own, loses the session's connection to it, and checks permissions in
application code that cannot see a revoked membership until the next login.

Two things are wanted and kept apart. A **user belongs to organizations with a role**, and
the session says which one is active and what that role may do, in the token, so a server
can check it offline. And a team that arrives from another provider brings its **users with
their password hashes**, so that nobody has to reset a password to sign in again.

This step builds the data, the settings and the operator's routes. A user's own routes,
tokens, invitations, domains, SDKs, the dashboard and the import follow in the tickets of
[docs/plans/phase-3.md](../plans/phase-3.md); their decisions are recorded here, once, so
that those tickets build on one document.

## Decision

### The model

- **`organizations`**: name, `slug` (unique per environment; lower-case letters and digits
  joined by single hyphens, 2 to 48 characters), `created_by` (a user's id, or null for one
  an administrator made; a plain column, not a foreign key, so that deleting a user does not
  touch the organization).
- **`organization_roles`**: `key` (unique per environment; `^[a-z][a-z0-9_]*$`), name,
  `permissions`, `built_in`. **Roles belong to the environment and are shared by all its
  organizations**, as in Clerk: a role is a policy, not a property of one customer.
- **`organization_memberships`**: organization, user, role. One per pair. Deleting the user
  or the organization removes it (cascade); a role cannot be deleted while a membership uses
  it (`no action`).
- **`organization_invitations`** (Orgs 04): organization, the invited address (normalized),
  role, token hash, status, expiry, inviter.
- **`organization_domains`** (Orgs 05): organization, domain (unique per environment among
  verified rows), mode `suggest` or `auto_join`, `verified_at`.
- **Sessions gain a nullable active organization id** (Orgs 02).

All five are tenant tables: `project_id` and `environment_id`, the composite foreign key and
fail-closed row-level security, forced (`FORCE ROW LEVEL SECURITY`). The runtime role is
granted what it needs and no more: `organizations` and memberships may be updated in the
columns that change (`name`, `slug`, `role_id`, `updated_at`), and roles may only be read
and inserted in this version (Orgs 03 adds the grants that custom roles need).

### Built-in roles exist per environment

Two roles are built in, `admin` (every system permission) and `member`
(`org:sys:memberships:read`). Their definition is a constant of `@tula-tech/contract`
(`BUILT_IN_ROLES`) and is authoritative; the rows exist so that a membership has something to
refer to. They are created two ways, both idempotent (`ON CONFLICT DO NOTHING`):

1. **Migration 0036 backfills them** for every environment that exists.
2. **`OrganizationStore.ensureBuiltInRoles`** creates them the first time an environment's
   organization routes need a role (not when an environment is created: an environment that
   never turns organizations on never holds the rows). It is a write of its own that takes no
   audit entry, because it records no decision of anyone: it makes the constant visible. It
   is added to the unrecorded writes of ADR 0012.

A built-in role cannot be edited or deleted (a database check holds `built_in` roles to the
two keys).

### Permissions

A permission key is `org:<feature>:<action>`, lower-case, for the operator's own features
(`org:billing:read`). The system's own are `org:sys:<feature>:<action>`: `organization:manage`,
`organization:delete`, `memberships:read`, `memberships:manage`, `invitations:manage` and
`domains:manage`. **`sys` is reserved**: a custom permission cannot use it. A role holds at
most 32 permissions and an environment at most 50 custom roles; both are bounds in the
contract, enforced in the schema and in the database.

**An organization always has someone who can manage its members.** The last member who holds
`org:sys:memberships:manage` cannot be demoted to a role without it or removed
(`organization.last_manager`, 409). The check and the write are one transaction that locks
the organization's row, so two concurrent demotions cannot both succeed. Known gap, deferred to
[TULA-124](https://linear.app/tula/issue/TULA-124): deleting a *user* cascades their
memberships and can leave an organization with none (the deletion bypasses the rule), and a
user deletion takes no organization lock, so it can also race a guarded demotion of the
*other* manager (both pass, and nobody is left). TULA-124 decides whether deleting such a
user must be refused or must promote someone, under the same lock.

### Settings

An `organizations` section of the environment's settings: `enabled` (default off),
`allowUserCreated` (off), `maxCreatedPerUser` (5, or `null` for no limit; 1 to 1000),
`creatorRole` (`admin`), `defaultRole` (`member`) and `personalAccount` (on: a user
needs no organization). While `enabled` is off, **every organization route answers
`organization.disabled` (403) and touches nothing**, reads included. A weakening
([ADR 0012](0012-events-and-audit-log.md)) is: turning `enabled` off, turning
`allowUserCreated` on, and raising or removing `maxCreatedPerUser`. Changing a role key or
`personalAccount` is not. The existence of the roles `creatorRole` and `defaultRole` name is
checked by the grammar only here; Orgs 02, which reads them, checks that they exist.

### Token claims

*(Built in Orgs 02; recorded here.)* The access token gains three reserved top-level claims,
`org_id`, `org_role` (the role's key) and `org_perms` (its permission keys), **present only
while an organization is active**. They are reserved names, so a claims hook or a JWT template
cannot set them ([ADR 0036](0036-jwt-templates.md) lists them with the other reserved ones);
they are not part of `ext`. They have a byte cap of their own, defined in the contract and
tested by signing a token with the maximal role (32 permissions of the longest key) in the
longest allowed organization. The token's version stays 1: a verifier that does not know the
claims ignores them. A refresh re-reads the membership only when the session has an active
organization; a session whose membership is gone leaves the organization (the claims are
dropped, the session stays). **A removal or a demotion therefore takes effect at the next
refresh, within the access token's life, and does not revoke the session**: the user is still
who they were.

#### As built in Orgs 02 (TULA-112)

- **The cap.** `MAX_ORGANIZATION_CLAIMS_BYTES` is 2,560; the true maximum is 2,541 bytes (the
  organization's UUID, a 32-character role key and 32 permission keys of 73 characters,
  `MAX_ORGANIZATION_PERMISSIONS_CLAIM`). It is a cap of its own and is never added to
  `MAX_CUSTOM_CLAIMS_BYTES`. Over the cap at issue the token is issued **with no organization
  claims at all** (fail closed: an application reading "no `org_id`" treats the user as acting
  in no organization) and an error line names the environment, the organization and the
  count, never a value. A reader (`readOrganizationClaims`) treats any partial or malformed
  combination of the three as absent, whole.
- **A maximal role does not fit a browser cookie.** `@tula-tech/nextjs` keeps the access token
  in `tula_at`; with the maximal organization claims (about 3.4 KB once base64url-encoded)
  that cookie can pass a browser's per-cookie budget. Nobody has such a role yet (the
  built-in ones are small); the SDK's cookie handling for it is Orgs 06 (TULA-117).
- **The session records its active organization** in `sessions.active_organization_id`
  (migration 0038), deliberately **without a foreign key**: deleting an organization or a
  membership must not touch a session row, and the id is trusted for nothing, since every
  token re-reads the membership. A removed member, a demoted one, a deleted organization and an
  environment that switched organizations off all lose the claims at the next refresh; the
  session lives and the stored id is not cleared, so re-adding the member restores the
  claims. Choosing among memberships already held is an unrecorded write
  ([ADR 0012](0012-events-and-audit-log.md)).
- **Routes** (`modules/organization/me-router.ts`, publishable key and session, `no-store`, a
  per-IP limit each): `GET /v1/client/me/organizations`, `POST` the same path (201) and
  `PUT /v1/client/me/organizations/active` with `{ organizationId: uuid | null }`. A `hybrid`
  session gets a new access token and keeps its refresh token; a `stateful` session gets no
  token and its next request carries the claims. Every permission is read through one function,
  `OrganizationStore.findUserMembership`, which is where custom roles (Orgs 03) plug in.
- **Codes.** `organization.not_a_member` (403) is the answer for an organization that does
  not exist, one the user is not in and one of another environment alike, so the route
  enumerates nothing; `organization.creation_disabled` (403), `organization.limit_reached`
  (403, counted by `created_by` under a lock on the user row) and
  `organization.personal_account_disabled` (409, for `null` while `personalAccount` is off).
- **`@tula-tech/core`.** `client.organizations.{list, create, setActive}`; the signed-in state
  gains `organizationId`, read from the access token's `org_id` (for display, never for
  authorizing) and, for a `stateful` session with no token, from the last list or choice. A
  choice answered for an older session generation is never installed: one refresh, made after
  the choice was accepted, carries it. `list` returns the first page only.

### Routes

- **Admin** (this step): `/v1/admin/organizations` (list, create), `/:id` (read, rename,
  delete) and `/:id/memberships` (list, add), `/:id/memberships/:userId` (change role,
  remove). They are behind `secretKey()` and so take the dashboard's session too; an agent
  key reads and nothing else (it is refused on a write with `auth.invalid_key`, as everywhere
  on `/v1/admin/*`). Orgs 03 adds `/v1/admin/organization-roles`. Every write is one audit
  entry in the same transaction.
- **Client** (Orgs 02, 04, 05): `/v1/client/me/organizations…` for the signed-in user: list
  mine, create (where `allowUserCreated` and the limit allow), set the active one, and the
  members, invitations and domains of an organization, **each checked against the caller's
  role's permissions on the server**. Accepting or declining an invitation. Every write has a
  per-IP rate limit.

### Invitations

*(Orgs 04.)* A new email kind, `organization_invitation` (a link category: the link is the
server's own, [ADR 0024](0024-email-sign-in.md)). The organization's name reaches the email
through `displayName` and `escapeHtml` and **no text the inviter typed does**. The token is
high-entropy, stored as a SHA-256 hash, single use, valid for 7 days. Accepting needs a
signed-in session **whose verified email equals the invited address** (a link forwarded to
someone else joins nothing). Invitations are limited per organization per hour and per
environment per day; the retention job purges the expired ones.

### Verified domains

*(Orgs 05.)* A domain is verified by **an emailed code sent to an address at the domain**,
not by DNS (DNS verification is out of scope). A deny list of public mail domains lives in
the contract and is refused. At the end of a sign-up (the flow engine's `finish`), a verified
domain in `auto_join` mode creates a membership with the default role; in `suggest` mode the
organization is listed among the user's suggestions and nothing is joined.

### Events and the audit log

Six activity types: `organization.created`, `.updated` and `.deleted` (target `organization`),
and `organization_membership.added`, `.role_changed` and `.removed` (target
`organization_membership`, the membership's id). Their `data` is **ids, role keys, enums and
counts, never a name, a slug or an address**: `updated` names the fields that changed
(`name`, `slug`), `deleted` carries the number of memberships that went with it (read just
before the delete, so approximate under concurrency), and the membership events carry the
organization id, the user id and the role key (`role_changed` also the previous). The event
canary treats the two built-in role keys as contract words; a custom role's key is the
operator's own identifier and is allowed by the schema's pattern only.

### SDKs

`@tula-tech/core` gets `client.organizations` (Orgs 02); `@tula-tech/react` the components,
hooks and `has()` (Orgs 06, 07); `@tula-tech/nextjs`'s `auth()` gains `orgId`, `orgRole`,
`orgPermissions` and `has()`, and the middleware gets permission matchers (Orgs 06);
`@tula-tech/admin` is generated; `@tula-tech/config` gains `organizationRoles` (Orgs 03); Tula
UI gets registry items ([ADR 0064](0064-tula-ui.md)); Swift and Kotlin get list, switch and
accept, and Expo gets them through core (Orgs 09). The generated Swift and Kotlin error codes
and types follow the contract ([ADR 0050](0050-native-type-generation.md)).

### Importing users (Import 01 to 03)

`POST /v1/admin/users/import` takes up to 500 rows (email, `emailVerified`, name, metadata, an
external id and, optionally, a **tagged password hash** `{ algorithm, hash, params }`). It
answers a result per row: created, skipped as a duplicate, or refused with a code, and is
idempotent by normalized email. A sign-in with an imported hash is verified by the algorithm
the tag names, and **the password is rehashed to argon2id on the first success**. Supported:
bcrypt, argon2id and argon2i, Firebase's scrypt (the signer key and salt separator are given
once per import and sealed), and PBKDF2-SHA256, each with parameter floors. The audit log gets
one entry per user with source `import`; webhooks send `user.imported`, **not**
`user.created`, so that a bulk load does not fire a welcome email in every consumer.
`tula import --from clerk|auth0|firebase|supabase|better-auth <file>` has a dry run, a report
and resume.

### Out of scope

SAML and SCIM, billing, per-organization branding and settings overrides, nested
organizations, DNS verification of a domain, MCP `plan_migration` and `import_users`, and
native organization screens.

## Consequences

- An environment that never turns organizations on pays for three empty tables and two
  role rows.
- Roles shared by all organizations mean one customer cannot have a role of its own. That is
  a deliberate limit; per-organization roles can be added later as a column without moving
  the existing rows.
- A removal does not end the session, so a removed member's token carries the old claims for
  up to its life (about a minute). Anything that must be immediate checks the membership.
- The last-manager rule has the gap described above until TULA-124.
