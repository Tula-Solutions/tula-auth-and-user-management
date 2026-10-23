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
columns that change (`name`, `slug`, `role_id`, `updated_at`). Roles were read and inserted
only in Orgs 01; Orgs 03 (below) grants the update and delete that custom roles need, to
custom rows only.

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
`domains:manage`. **`sys` is reserved**: a custom permission cannot invent a `sys` key. A
custom role may hold any of those six (that is how an operator makes a second manager role),
and no other `org:sys:*` key (Orgs 03, below). A role holds at most 32 permissions and an environment at most 50 custom roles; both are bounds in the
contract, enforced in the schema and in the database.

**An organization always has someone who can manage its members.** The last member who holds
`org:sys:memberships:manage` cannot be demoted to a role without it or removed
(`organization.last_manager`, 409). The check and the write are one transaction that locks
the organization's row, so two concurrent demotions cannot both succeed.

**Deleting a user is refused while they are the last manager of an organization**
([TULA-124](https://linear.app/tula/issue/TULA-124)). The cascade that deletes a user's
memberships used to bypass the rule above, and took no organization lock, so it could also race
a guarded demotion of the *other* manager (both pass, and nobody is left). The decision is to
refuse, as removal and demotion do, and not to promote or flag anyone: promoting a member picks
a person with powers over other people on nobody's say-so, and a flag is a state that every
reader of an organization would then have to handle. The operator has two plain ways out:
add another manager, or delete the organization. The refusal is
`user.last_organization_manager` (409) with `params.organizationIds`, a comma-separated list of
the ids (at most 20, ascending) and `params.count`; it is a code of the *user* area and not
`organization.last_manager` because the request is about a user and the client must not have
to tell which of two meanings of one code it got. It covers every path that deletes a user
(`UserRepository.delete`): `DELETE /v1/admin/users/{id}`, the only route that does today (there
is no deletion of one's own account), and the retention job's purge of sign-in test users
(`deleteTestUsersBefore`), which leaves a test user who is the only manager for a later round
and counts only the users it deleted. The service looks first (`soleManagerOf`, unlocked) so
that a refused deletion does not end the user's sessions, and the store decides: in one
transaction it locks the user's row, then the rows of every organization they belong to in id
order, `FOR NO KEY UPDATE`, and only then reads who manages, so a deletion and a demotion of the
other manager take turns and exactly one is made. The lock order is the same as everywhere
else (users, then organizations by id; never the role row first); `NO KEY UPDATE` conflicts
with the `FOR UPDATE` of a removal, a demotion and a role update but not with the `KEY SHARE`
of a membership insert, which would otherwise deadlock with the user lock. A set of users
deleted together is judged as a whole: two managers purged together are both left.

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

- **The cap.** `MAX_ORGANIZATION_CLAIMS_BYTES` is 2,560; the true maximum the grammar allows is
  2,541 bytes (the organization's UUID, a 32-character role key and 32 permission keys of 73
  characters, `MAX_ORGANIZATION_PERMISSIONS_CLAIM`). Custom roles (Orgs 03, below) were
  checked against it: a permission key may be 100 characters in the schema
  (`MAX_PERMISSION_KEY_LENGTH`), but the pattern ends a key at `org:` + 32 + `:` + 32 = 69
  characters, and an `org:sys:` key (73 at most) is refused as reserved unless it is one of
  Tula's six short ones. The largest custom role, 32 keys of 69 characters under a 32-character
  role key, is 2,413 bytes of claims, so **the cap is kept and a role the roles API accepts
  never loses its claims**. The drop-all branch below stays as the fail-closed answer for a
  role written past the bounds by hand (a test does that). It is a cap of its own and is never added to
  `MAX_CUSTOM_CLAIMS_BYTES`. Over the cap at issue the token is issued **with no organization
  claims at all** (fail closed: an application reading "no `org_id`" treats the user as acting
  in no organization) and an error line names the environment, the organization and the
  count, never a value. A reader (`readOrganizationClaims`) treats any partial or malformed
  combination of the three as absent, whole.
- **A maximal role does not fit a browser cookie.** `@tula-tech/nextjs` kept the access token
  in `tula_at`; with the maximal organization claims (about 3.4 KB once base64url-encoded)
  that cookie can pass a browser's per-cookie budget. Orgs 06 (TULA-117) measured it and
  decided: the token is stored in up to two cookies. The measurement, the limits and the
  decision are in [ADR 0029](0029-nextjs-sdk.md), "Amendment: the organization claims and the
  access token's cookies".
- **The session records its active organization** in `sessions.active_organization_id`
  (migration 0039), deliberately **without a foreign key**: deleting an organization or a
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

#### As built in Orgs 04 (TULA-115)

- **Routes.** Admin, behind `secretKey()` (an agent key reads, nothing else):
  `GET|POST /v1/admin/organizations/:id/invitations` and
  `DELETE …/invitations/:invitationId`. Signed-in members, under `/v1/client`: the same three
  at `/me/organizations/:organizationId/invitations`, `POST /me/organization-invitations/accept`
  and `…/decline`, and the one route with no session, `POST /organization-invitations/preview`
  (the token in the body, the answer the organization's name, the role key, the invited address
  and the expiry, so that a sign-up can be prefilled). A token is always sent in a body, never
  in a path or a query.
- **The link** is `<redirectUrl>#tula_invitation=<token>` (`ORGANIZATION_INVITATION_TOKEN_PARAM`).
  The fragment is never sent to a server, so the token reaches neither a proxy's log nor a
  `Referer`. `redirectUrl` must be one of the environment's allowed redirect URLs, matched
  exactly, and a custom scheme is refused (the link is opened from an email in a browser).
- **States.** `pending`, `accepted`, `declined`, `revoked`, and `expired`, which is not stored:
  a pending invitation past its expiry (7 days, `INVITATION_EXPIRY_DAYS`). One pending
  invitation per organization and normalized address (a partial unique index); inviting
  an address whose pending invitation has lapsed replaces it in the same transaction.
- **Who may invite.** A signed-in member needs `org:sys:invitations:manage`, read from a fresh
  membership on every call (`organization.not_a_member`, `organization.permission_required`).
  They may offer only a role whose permissions are a subset of their own
  (`organization.role_not_assignable`), so that an inviter cannot grant what they lack. The
  admin API has no such limit.
- **Who may answer.** Accepting and declining need a session whose email, normalized, equals the
  invited address (`organization.invitation_wrong_account`) **and is verified**
  (`organization.invitation_email_unverified`). Token states answer
  `organization.invitation_not_found` (404) and, for a token that can no longer be used,
  `organization.invitation_expired`, `…_revoked` and `…_used` (410). Accepting uses the
  invitation and creates the membership in one transaction, with the audit entries; a user who
  is a member already answers `organization.member_exists` and the invitation stays pending.
- **A role deleted after the invitation was sent.** The invitation stores the role's key, not a
  foreign key, so deleting a role is never blocked by a pending invitation. On accepting, a key
  that no longer exists answers `organization.invitation_role_gone` (409) and the invitation
  stays pending: it is **never** given the default role instead, because that would grant
  access the inviter did not choose. The inviter withdraws it and invites again.
- **Limits.** Per IP: 60 reads and 20 writes a minute per route. Per organization: 50
  invitations an hour (`INVITATIONS_PER_ORGANIZATION_PER_HOUR`); per environment: 1000 a day
  (`INVITATIONS_PER_ENVIRONMENT_PER_DAY`), counted for the admin API as well. The keys hold ids
  only.
- **The email** is sent through `Email.send` from `modules/organization/mailer.ts`. If the send
  fails the invitation is revoked (best effort) and the error is raised; nothing is logged with
  the link. An operator's template for it has the placeholders `link` (required), `appName` and
  `expiresInDays`; there is none for the organization or the address.
- **Events and audit.** `organization_invitation.created`, `.accepted`, `.declined` and
  `.revoked`, target `organization_invitation` (the invitation's id). Their data holds the
  organization id and the role key (and the user's id for accepted and declined), never the
  address. Accepting also writes the membership's `organization_membership.added`.
- **Retention.** The retention job deletes an invitation 7 days after its expiry whatever
  became of it (`EXPIRED_INVITATION_RETENTION`), in batches through
  `deleteExpiredInvitations`. The row holds an address; the audit log keeps the ids.
- **SDKs.** `@tula-tech/core` gets `client.organizations.invitations` (invite, list, revoke,
  accept, decline, preview). The Swift and Kotlin clients have the same calls on their
  `organizations` (TULA-121) and a journey for each of the three organization scenarios.

### Verified domains

*(Orgs 05, TULA-116; migration `0041`, scenario `122`.)* An organization **claims** a domain, and a
user whose **verified** email address is on it is either offered the organization or joined to
it, by the domain's `mode`.

- **Verification is an emailed code, not DNS** (DNS is out of scope). `POST …/domains` takes
  `{ domain, email, mode }`: the address must be **exactly on that domain** (a subdomain or a
  parent is `organization.domain_address_mismatch`, 422) and receives a 6-digit code by the new
  email kind `organization_domain_verification` (a code category). Until the code is entered the claim is **pending** and grants nothing.
  `POST …/domains/:domainId/verify` takes `{ code }`.
- **Where a pending claim lives.** In the table `organization_domains`, with its own code
  columns (`code_hash`, `code_expires_at`, `code_attempts`) and not in the verification-token
  store: that store is keyed by a user, and an administrator calling the admin API has none.
  The code's keyed hash is `HMAC('organization-domain-codes', "<row id>:<domain>:<code>")`
  (`~/lib/keyed-hash`), so a code is bound to the row and the name it was sent for. A pending
  row always has a code (a check constraint; a verified row holds one only while a manager proves it
  again, see "Lapse"); verifying sets `verified_at` and `expires_at` and clears the code in one
  statement.
- **Guessing.** A code allows 5 guesses (`MAX_ATTEMPTS`), counted by the store **before** the code
  is compared and atomically; `deps.lockout` with `CREDENTIAL_LOCKOUT` under the key
  `organization_domain_code:<environment>:<row id>` counts the attempt first and clears it on
  success, so a sixth guess meets the back-off (429) even with the right code. A code lives
  10 minutes; a new send replaces it and resets the counter. The client route for the check
  has a per-IP limit of its own on top (10 a minute).
- **Sending is limited**, because the address is free text an administrator typed: one send a
  minute and 10 an hour per organization (`CODES_PER_ORGANIZATION_PER_HOUR`), a day's allowance
  per organization (30 for one an administrator made, **10 for one a user created**) and 20 a
  day for **all the organizations one user created together** (see "Fairness of the daily
  allowance" below), 200 a day per environment, and 5 an hour per hashed address (so the code
  cannot be used to flood one inbox). An organization has at most 10 domains
  (`organization.domain_limit`, 409).
- **A domain is verified for one organization per environment**, until its verification lapses
  (`organization.domain_taken`, 409; see "Lapse" below): a partial unique index over the verified rows. Any number of organizations may have a
  pending claim on a name, and of two verifications at once the database lets one succeed;
  the other is told `domain_taken`. A claim of an organization of another environment is a 404.
- **Grammar and the public list** (`@tula-tech/contract/organization-domain-rules`, Zod-free):
  lower-case ASCII labels joined by single full stops, the last label letters or punycode
  (`xn--…`); upper case, **Unicode (refused, not converted)**, IP literals, a trailing full
  stop, underscores, wildcards and a single label are refused (422), as are a label over 63
  characters and a name over 253. The database holds the same shape in a check. A **public
  mail domain** (`PUBLIC_EMAIL_DOMAINS`, an explicit list of the large mailbox providers, the
  internet providers that hand out addresses the common national ones, forwarding aliases and relays (`duck.com`, Apple's private relay)
  and disposable inboxes, and
  `PUBLIC_EMAIL_BRANDS`, whose every country domain counts: `yahoo.co.uk`, `hotmail.fr`) is
  refused with `organization.domain_public` (422). The list is documented in the contract and
  nowhere else, and **a join never matches a public domain, even for a claim stored before the
  list grew**.
- **Who joins when.** `auto_join` makes a member **at sign-up only**: the flow engine's
  `finish` calls `OrganizationDomains.joinOnSignUp` for an attempt of kind `sign_up` (or one
  that created the account), after the session exists, and the call **never throws**: a
  failure is logged and the sign-up completes. A sign-in does not join. The reason is that a
  member an administrator removed would otherwise rejoin at their next sign-in, so
  "removing a member" would mean nothing; and an existing account got its address long before
  the domain was verified. Those users (existing accounts, removed members, and everyone in
  `suggest` mode) are **offered the organization instead** and may join it themselves, on
  purpose: that is what `suggest` means, and for `auto_join` it is the path for accounts that
  existed before the domain. Both modes feed the suggestions. Only `user.emailVerifiedAt`
  counts, the match is on exactly the address's domain (`domainOfAddress`; `a@mail.acme.com`
  never matches `acme.com`), a banned user matches nothing, and the role is the environment's
  `organizations.defaultRole`. While `organizations.enabled` is off nobody is joined or offered.
- **Suggestions** (`GET /v1/client/me/organizations/suggestions`, `POST …/suggestions/:organizationId/join`):
  the organization's id, name and slug and nothing of its members. The join **decides again on
  the server** (the domain still verified, the address still on it, the user not banned): a
  stale or invented suggestion is `organization.suggestion_unavailable` (403), the same code
  for an organization that does not exist, is of another environment, or has no such domain; a
  user who is already a member gets `organization.member_exists` (409).
- **Managing domains** is the admin API (`/v1/admin/organizations/:id/domains…`, behind
  `secretKey()`; an agent key reads) and, for an organization's own administrators, the client
  routes `/v1/client/me/organizations/:id/domains…`, which need the permission
  `org:sys:domains:manage` **read from the role now** (`findUserMembership`, never the token):
  a member without it is `auth.forbidden`, and a non-member or an unknown organization alike
  `organization.not_a_member`. Removing a domain stops later joins and offers and **keeps the
  members it brought**. Deleting the organization removes its domains by cascade.
- **Retention.** A pending claim is deleted an hour after its code expired
  (`EXPIRED_DOMAIN_CLAIM_RETENTION`, a batched `purgeExpiredPending` in both adapters and the
  shared suite); a verified domain is never purged.
- **Events and audit** (target `organization_domain`): `organization_domain.claimed`,
  `.verified`, `.updated` and `.removed` hold the organization id, **the domain** (public, and
  allowed in its own field by the event canary), the mode and, where `auto_join` is chosen,
  `weakened: true` (a domain that joins people without a human is a weakening, like a looser
  setting); `.verified` also says `reverified: true` for a domain that was verified already. **Never the address the code was sent to.** `organization_membership.added` gains an
  optional `via` (`domain_auto_join` or `domain_suggestion`); the auto-join entry's actor is the
  system, the suggestion's the user.
- **Numbering.** The migration is `0041` and the scenario `122` (the lifetime is `0042`,
  TULA-128, below).

- **Accepted limit (Ollie round 2).** A well-formed domain's being claimed elsewhere is still
  learnable, now at a price: see "Probing" below. The other two limits of that round are
  decided below (TULA-128).

#### Lapse: a verification is believed for a year (TULA-128, migration `0042`)

A verified domain used to stay verified until someone removed it. If the domain lapsed and
someone else registered it, their users with verified addresses on it still matched the
organization, and with `auto_join` became members at sign-up. **A verification now has a
lifetime**, and past it the claim matches nobody.

- **Lifetime.** `DOMAIN_VERIFICATION_LIFETIME_DAYS = 365` in the contract
  (`organization-domain-rules`), counted from the day the code was entered. **Stored, not
  derived from `verified_at`**: the row has `expires_at` (set exactly when `verified_at` is, by a
  check), written when the code is entered. A stored deadline lets rows from before the
  change have a deadline of their own (below) and lets the lifetime change later without
  moving rows that were already verified. The state is **derived from the date and the clock**,
  not stored as a word that something must flip: `lapsed(record, now)` is `expires_at <= now`
  (a verified row with no date counts as lapsed), so a stopped job, a skewed timer or a missed
  run cannot leave a lapsed domain matching. The wire says `status`: `pending`, `verified` or
  `needs_reverification`, and `expiresAt`.
- **Where it applies.** One place: `matchOf` (the sign-up join, the suggestions and the join
  of a suggestion all go through it). A lapsed claim matches nobody; its row, its mode and the
  members it brought are kept. It does not release the name by itself (a unique index cannot
  hold a date), see below.
- **Re-verifying** goes through the existing claim-code path. `POST …/domains` for a domain the
  organization **has verified** (current or lapsed) emails a code and stores it beside the
  verified dates; **the domain keeps matching, with its mode, until the new code is entered or
  it lapses**, and the request's `mode` is ignored (a mode change is `PATCH`, and a weakening
  there). Entering the code (`verify`) moves `verified_at` and `expires_at`, clears the code and
  the reminder mark and records `organization_domain.verified` with `reverified: true`. The
  code, guess counter, lockout and send limits are the first claim's. A lapsed domain with no
  code waiting is `verification.expired` on `verify`: ask for a code first. The state check of
  the table now says: a pending row has a code, `expires_at` goes with `verified_at`, and the
  code columns are all set or all null.
- **A lapsed claim does not keep the name.** The new owner of a lost domain must be able to
  claim it: `claim` ignores another organization's lapsed verification, and `verify`
  removes that row first (`organization_domain.removed`, the verifying actor), then the unique
  index lets the new holder in. A verification that has not lapsed is `organization.domain_taken`
  as before. The earlier holder's members stay members.
- **Reminders.** A daily job (`modules/organization-domain/reminders.ts`, job `domain_reminders`,
  lock id 3 in `JOB_LOCK_IDS`, in `ProcessPlan.jobs` of every **API** process and never a
  worker: it sends mail through the API's own mailer and calls no operator's address) emails
  the managers (members whose role holds `org:sys:domains:manage` **as stored now**, at most
  10, with a verified address, not banned) **30 and 7 days** before the lapse
  (`DOMAIN_REMINDER_DAYS`). Each reminder is **taken** by a guarded update of
  `reminded_days` before anything is sent, so it is sent once per verification however often
  or on however many instances the job runs; a send that fails for every manager is given
  back and retried at the next run; verifying again clears the mark. One email covers all the
  organization's domains at a threshold. The email kind is `organization_domain_expiring`
  (category `notice`: no code, no link, a subject that never leads with a digit). **It names the
  organization and how many domains, never a domain**: a domain name reads as a link, and no
  email carries one (the link rule). It is **never awaited on a request path** (a timer
  runs it) and is bounded: 200 reminders per environment a day through the rate limiter (which
  fails closed), 200 domains read per environment per run, nothing at all while
  `organizations.enabled` is off. No audit entry (it changes nobody's access) and no event;
  the run logs counts only.
- **Rows from before the change.** The migration gives a verified row `expires_at =
  greatest(verified_at + 365 days, now() + 30 days)`: **the clock starts at `verified_at`, as for
  any row, but with at least 30 days of grace**, so nobody is cut off the day this ships and
  every manager is reminded (the 30-day threshold has been reached) before a long-verified
  domain stops matching. The numbers are written into the migration, not read from the
  contract (`DOMAIN_REVERIFICATION_GRACE_DAYS` documents them); `migration-organization-domain-lifetime.test.ts`
  holds the backfill.
- **Not built.** A lapsed claim is not deleted by retention (a manager restores it with a code),
  and a warning on the dashboard is the Domains section's to draw from `status`
  (the dashboard has none yet).

#### Fairness of the daily allowance (TULA-128)

At 30 a day each, about seven user-created organizations could spend the environment's 200 and
delay every other claim to the next day. **Decision: a lower cap for an organization a user
created, and a per-creator cap across their organizations.** An organization with no creator
(an administrator made it) keeps 30 a day; one with `created_by` gets
`CODES_PER_USER_ORGANIZATION_PER_DAY = 10`, and all the organizations one user created share
`CODES_PER_CREATOR_PER_DAY = 20` (a limiter key of the creator's id, per environment). Creating
organizations is already bounded per user (`maxCreatedPerUser`), and the creator's cap makes
the number of organizations stop mattering: it takes ten creators, not seven organizations, to
spend 200. Chosen over a smaller environment cap (which makes real use fail sooner) and over
splitting the environment's allowance by organization (state for nothing). An administrator
who needs more raises it by making the organization themselves.

#### Probing for claimed domains (TULA-128)

`organization.domain_taken` for a name another organization has verified is a yes/no answer
about other organizations. **Decision: it spends a slot of the asking organization's hourly
allowance of sends** (`CODES_PER_ORGANIZATION_PER_HOUR`, 10), so a manager learns the answer for
ten names an hour and is then rate-limited (429), and nothing is sent. A separate probe limit
was not worth a second counter; sharing the hour's allowance also keeps a manager who really
sends from probing on top of it. A name that is free, one the organization has verified itself,
and one whose verification has lapsed are not probes.

### Events and the audit log

Six activity types: `organization.created`, `.updated` and `.deleted` (target `organization`),
and `organization_membership.added`, `.role_changed` and `.removed` (target
`organization_membership`, the membership's id); Orgs 05 adds `organization_domain.claimed`,
`.verified`, `.updated` and `.removed` (target `organization_domain`, "Verified domains"). Their `data` is **ids, role keys, enums and
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

### Custom roles (Orgs 03)

An environment defines roles of its own beside the two built-in ones.

- **Grammar.** A role key is `^[a-z][a-z0-9_]{0,31}$`; `admin` and `member` are taken (a
  database check holds a custom row off both keys). A permission key is the grammar above, at
  most 100 characters, none twice. A custom role may hold the six system permissions; any
  other `org:sys:*` key is refused with `validation.failed`, so that a typo of
  `org:sys:memberships:manage` can never be a permission nobody checks. Permissions are a set:
  stored and returned sorted.
- **Routes.** `/v1/admin/organization-roles` (list, define) and `/:key` (read, change,
  remove), addressed by key. Behind `secretKey()`, so the dashboard's session works too; an
  agent key reads and nothing else. While organizations are off every route answers
  `organization.disabled`. Listing creates the built-in roles if they are missing.
- **Versions.** A role has a `version` (from 1, plus one for each change); it is the `ETag`.
  A change needs `If-Match` (`precondition.required` 428 without it, `precondition.failed` 412
  with `params.version` when stale); a removal may send it. This is what lets `tula apply`
  write over exactly the role it planned from, as it does for settings.
- **Rules.** The built-in roles cannot be changed or removed (`organization.role_built_in`);
  a key that is taken (also `admin` and `member`) is `organization.role_exists`; a role a
  member holds cannot be removed (`organization.role_in_use`, and the foreign key is the last
  word); more than 50 custom roles is `organization.role_limit`, counted under the
  environment lock `organization_roles` so that two definitions cannot both pass. **A change
  that takes `org:sys:memberships:manage` away from a role leaves no organization without a
  manager**: it is `organization.last_manager` when some organization's only manager would be
  demoted by it, checked in the same transaction under the lock of the organizations that use
  the role (the order is by id, as the membership routes lock, so the two cannot deadlock).
  The check does not lock the role row first: the membership foreign key's share lock on it
  would then deadlock with a role change.
- **Weakening.** Giving a role a permission it did not have is a weakening (members who hold
  it gain access): the event carries `weakened: true`, `tula apply --yes` needs
  `--allow-weaker`, and the dashboard asks first (`organizationRoleWeakenings` in the
  contract, one function for all three). Defining a role (nobody holds it), taking a
  permission away and removing an unused role are not weakenings.
- **Effect.** A membership holds a role id and the permissions are read through the role at
  refresh time, so a change reaches a signed-in member's token at their next refresh, within
  the access token's life, as a demotion does. No permission is copied into a membership. The claims of
  Orgs 02 are built from the same join (`findUserMembership` reads the role's permissions with
  the membership), so a custom role's key and its permissions as they are now are in every
  token issued after a change, never cached in the session (a test changes a role and refreshes).
- **Events.** `organization_role.created`, `.updated` and `.deleted`, target type
  `organization_role`. The data holds the role's key (an operator identifier of the grammar
  above, which the event canary allows in this field and no other), the number of
  permissions and, for an update, the names of the fields that changed (`name`,
  `permissions`); never a name and never a permission key.
- **Database (migration 0038).** `organization_roles.version` with a check that it is at
  least 1; a check that a custom row does not take a built-in key; the runtime role is
  granted `UPDATE ("name", "permissions", "version", "updated_at")` and `DELETE`, and two
  restrictive policies hold both to rows that are not built in, whatever a statement asks.
- **Config.** `organizationRoles` in `tula.config.ts`: a list keyed by role key, which
  `tula diff` and `tula apply` plan like native apps (`docs/config.md`). Left out, roles are
  not managed.

### The prebuilt components (Orgs 07)

- **Client routes.** The signed-in user's organization routes under `/v1/client/me/organizations`
  gain rename and delete (`PATCH`/`DELETE` on one organization), the member list, a member's role
  and removal, and the roles the caller may assign. Each checks the caller's permission from a
  fresh membership read (never the token), and a role change or removal that would leave no
  member holding `memberships:manage` is refused with `organization.last_manager`.
- **`ClientConfig.organizations`** (`enabled`, `allowUserCreated`, `personalAccount`) is how a
  component learns what the environment allows. A configuration without it means organizations
  are off, so an older server draws nothing.
- **Invitations reach the switcher by token.** The emailed link carries the token in the URL
  fragment; `readInvitationLink` (re-exported by React and Next.js) reads it once and removes it
  from the address bar, and the page hands it to `<OrganizationSwitcher invitationToken>`.
  Accepting stays authorized by the session ([Invitations](#invitations)).
- **Accepted limit.** The server has no route that lists a user's own pending invitations, so
  the switcher shows only an invitation whose token the app hands it. A listing is deferred.
- **A manager acts only on members within their own permissions.** Giving a role is limited to
  the caller's permissions (`role_not_assignable`), and so is changing the role of, or removing,
  another member: a target holding a permission the caller lacks is refused with
  `organization.permission_required`. Leaving is exempt.
- **Accepted limits.** Deleting an organization from the client needs the `organization:delete`
  permission and a valid session, with no fresh-authentication step (the admin route behind a
  secret key has none either); a step-up for it is a later change. The member list reads one
  user per record of a page, bounded by the page size; a batch lookup is deferred.
  TULA-131 tracks the three deferred items: a step-up for deletion, a route listing a user's own
  pending invitations, and the batch lookup.
- **Destinations are props.** `organizationProfileUrl`, `createOrganizationUrl` and
  `invitationUrl` (on the provider or the component) are the only places the components
  navigate to; without them the switcher opens the form or the profile in a dialog.

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
- The last-manager rule covers deleting a user too (TULA-124), at the price that a user who
  alone manages an organization cannot be deleted until someone else does or the organization
  is deleted.
- A custom role is shared by all organizations of the environment, like the built-in ones.
  Changing one changes what every member who holds it may do, at their next refresh.
