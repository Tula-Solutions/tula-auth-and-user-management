# ADR 0068: Role permission snapshots

Status: proposed. Extends [ADR 0065](0065-organizations.md) ("Token claims", "Custom roles").
Nothing here is built yet; the rollout table names the phase that builds each part
(TULA-206 and its sub-issues).

## Context

A role holds at most 32 permissions ([ADR 0065](0065-organizations.md)), because the token
copies them: `org_perms` is sent with every request, and `@tula-tech/nextjs` keeps the token in
cookies of 4,096 bytes each. The cap is what keeps the largest role inside the 2,560-byte budget
of the organization claims, so a role the API accepts never loses its claims.

Real applications outgrow it. The first one measured, a payments CRM, checks 179 distinct
features; a role there holds far more than 32. The answer cannot be a bigger number: the token
grows with every permission, and any number is a ceiling again.

What others do:

| Product | Where a role's permissions are | What the token carries |
| --- | --- | --- |
| Clerk | its database | the role and a compact list: the actions (`per`) and one bitmask per feature (`fpm`), still a cookie under 4 KB |
| Auth0 | its database | optionally every permission (`permissions`); its documentation says this "increases token size" |
| Better Auth | code, or an `organizationRole` table | nothing: a database-backed session, checked by `hasPermission` on the server |
| Supabase (its RBAC guide) | a `role_permissions` table | the role only (`user_role`, from an access-token hook); an `authorize()` function in a row-level security policy looks the permission up |

Copying is fast and offline but bounded; referring is unbounded but needs a lookup. Tula keeps
both: the copy where it fits, a reference that cannot be forged where it does not.

## Decision

### 1. A role's permissions are versioned, immutable snapshots

Every change of a role writes a row to a new tenant table, in the same transaction as the change
and its audit entry:

```text
organization_role_versions
  environment_id, project_id     tenantColumns(); forced row-level security
  role_key, version              primary key with environment_id; version is the role's `version`
  permissions      text[]        the canonical set (deduplicated, sorted)
  permissions_hash text          the digest of § 2, stored, never recomputed at issue time
  created_at
```

- **Append-only for the runtime role**: `INSERT` and `SELECT` only. No `UPDATE`, ever (a
  snapshot rewritten would rewrite what a role could do). `DELETE` only for the retention job
  (§ 8), held to its floor by a restrictive policy, as `audit_logs` is.
- No foreign key to `organization_roles`: a deleted role's history stays, like the delivery
  log's event id ([ADR 0034](0034-webhooks.md)).
- `If-Match` on a role's update already makes its versions one line; the primary key refuses a
  second row of a version.
- The migration backfills the current version of every role, so every token in circulation
  has a snapshot from the first day. `ensureBuiltInRoles` writes the built-in roles' snapshots
  and, like that function, records no audit entry ([ADR 0012](0012-events-and-audit-log.md)).

### 2. The permissions hash

`permissions_hash` is the string `1.` followed by the base64url (no padding) of
`SHA-256(UTF-8(JSON.stringify(set)))`, where `set` is the role's permission keys deduplicated and
sorted by code point.

- The grammar allows `[a-z0-9_:]` only, so `JSON.stringify` of the set has no escape and one
  encoding. A list fetched by a verifier (§ 4) is refused whole if one key fails the grammar.
- The full 256 bits, never truncated.
- `1.` names the scheme. A verifier refuses a token whose hash has a prefix it does not know:
  a later scheme is a new prefix and never a reinterpretation of an old one.
- `@tula-tech/contract` owns the function and a file of test vectors; every SDK, the Swift and
  Kotlin clients included, runs the same vectors. It is Web Crypto
  (`crypto.subtle.digest`), the same in Bun, Node, browsers, edge runtimes and workers: no
  dependency.

### 3. The token: two claims added, nothing removed

While an organization is active the access token carries:

| Claim | Small role (the claims fit the 2,560-byte budget) | Large role |
| --- | --- | --- |
| `org_id`, `org_role` | yes | yes |
| `org_perms` | yes, as today | **absent** |
| `org_rv` (new) | the role's version | the role's version |
| `org_ph` (new) | the permissions hash | the permissions hash |

- `org_rv` and `org_ph` are read **from one snapshot row** in the read that finds the
  membership: a token never pairs one version with another version's hash.
- Both join `RESERVED_CLAIM_NAMES` ([ADR 0036](0036-jwt-templates.md)): no template or hook sets
  them.
- Whether a role is inline is decided by its size against the existing budget, so it is a fact
  of the role's version, not of the request. Every role that exists today is inline. The two
  claims add about 65 bytes; the largest custom role under the current rules goes from 2,413 to
  about 2,480 bytes of claims, inside the budget, and still fits Next.js's two cookies.
- A verifier that holds `org_perms` and `org_ph` checks that they agree and denies if not. It
  costs one digest and catches an issuer bug.
- **An old verifier fails closed.** `readOrganizationClaims` treats `org_id` without `org_perms`
  as no organization, whole. A large-role token read by an SDK from before this ADR grants
  nothing; it can never grant too much.

### 4. The lookup: one route, no parameters

```text
GET /v1/client/me/organizations/active/permissions      operationId getActiveOrganizationPermissions
Authorization: Bearer <the user's access token>
x-tula-publishable-key: tula_pk_...

200 { "role": "iso_manager", "version": 7, "permissions": [ ... ], "hash": "1.Kq3…" }
Cache-Control: private, max-age=31536000, immutable
ETag: "1.Kq3…"
```

- **The verified token is the only input.** The route reads `org_role`, `org_rv` and `org_ph`
  from the session the token proves and returns that snapshot. There is no path parameter,
  query or body: no id to swap, no other organization's role to ask for.
- It answers only when the stored hash equals the token's `org_ph`. A snapshot that is missing,
  of another environment, or of another hash gets one answer
  (`organization.permissions_unavailable`, 404), never a second code that tells which.
- It does what `sessionAuth` does for every signed-in route: the signature, the revoked-session
  list, and **the device proof where the session is device-bound**
  ([ADR 0043](0043-device-binding.md)). A stolen bound token cannot be used to read it.
- A per-IP and a per-session limit (`route-guards.test.ts` requires a limit of its own on every
  client route). The answer is one indexed read, kept in the API's own cache for good: a hash
  never changes its list.
- The answer is immutable, so it says so: `If-None-Match` gets 304.
- The rows are not secret (a member reads their own permissions from an inline token today),
  but the route returns only the caller's own.

Why not the admin API: a resource server would need a secret key to resolve a permission, and a
secret key can delete users. A server that verifies tokens holds no Tula secret, before this
ADR and after it.

### 5. The verifier: one call, cached by the hash

```ts
import { createAccessChecker } from '@tula-tech/core/access'

const access = createAccessChecker({ apiUrl: 'https://auth.example.com', environmentId, publishableKey })

// Verifies the token (EdDSA, issuer, audience), resolves a large role once, then checks.
const decision = await access.check(accessToken, 'org:leads:view')
// { allowed: true, orgId, role: 'iso_manager', version: 7 }
// { allowed: false, reason: 'no_organization' | 'not_granted' | 'invalid_token' }
```

- A small role is checked offline, with no I/O, exactly as today.
- A large role: the checker looks `org_ph` up in its cache; on a miss it calls § 4 once
  (concurrent misses for one hash share one request), checks that the list hashes to `org_ph`,
  checks every key against the grammar, stores a `Set` and answers. Every later request on any
  user of that role version is one set lookup.
- The cache is keyed by the issuer and the hash, bounded in bytes (8 MB by default, least
  recently used out), never by time: an entry cannot go stale, because a role change is a new
  hash.
- **Any failure denies**: a timeout, a 5xx, a mismatch, a malformed list. `check` throws
  `AccessUnavailableError` (map it to 503); nothing failed is cached.
- It calls only the `apiUrl` it was given. A token's `iss` is compared with it, never fetched.
- The synchronous `hasOrganizationAccess` keeps its signature and answers `false` for a token
  that needs a lookup. Only the asynchronous checker resolves one. A caller cannot get a large
  role's grant by accident from a function that cannot wait.
- `@tula-tech/nextjs`'s server `has()`, the React provider's server path and the Expo client go
  through it; their public calls do not change. Framework glue is a few lines, documented, not a
  package:

```ts
// Hono
const requirePermission = (permission: string) =>
  createMiddleware(async (c, next) => {
    const token = c.req.header('authorization')?.replace(/^Bearer /, '') ?? ''
    const decision = await access.check(token, permission)
    if (!decision.allowed) {
      return c.json({ code: 'forbidden' }, decision.reason === 'invalid_token' ? 401 : 403)
    }
    c.set('access', decision)
    await next()
  })
```

### 6. Larger roles, switched on by the operator

- The bound becomes **1,000 permissions per role** in the contract schema and the database
  check (`cardinality(permissions) <= 1000`; the grammar check is unchanged). Unbounded is not
  safer: one role of a million keys is a storage and memory attack. At 69 characters a key, the
  largest role is about 70 KB.
- **A role past the inline budget can only be saved where the environment allows it**:
  `organizations.largeRoles` (default `false`; in `tula.config.ts`, the dashboard and the admin
  API; recorded like every setting). Off, a role that does not fit inline is refused
  (`organization.role_too_large`, 422), which is today's behaviour. The docs say to turn it on
  once every service that verifies tokens runs an SDK with § 5. One that does not denies, it
  does not over-grant.
- Turning it off again while a large role exists is refused (`organization.large_roles_in_use`,
  409): shrink the roles first.

### 7. AI-native

An agent works on roles the way a person does, with the same limits ([ADR 0053](0053-proposals.md),
[ADR 0033](0033-mcp-server.md)):

- **Read, explain, compare.** Three admin routes, open to a secret key and to an agent key (which may
  `GET` any admin route), and an MCP tool each:

  | Route | MCP tool | Answers |
  | --- | --- | --- |
  | `GET /v1/admin/organization-roles/{key}/versions` | `list_role_versions` | every version: number, time, count, hash |
  | `GET /v1/admin/organization-roles/{key}/versions/{version}` | `get_role_version` | one version's permissions, and what changed from the one before |
  | `GET /v1/admin/organizations/{id}/members/{userId}/access?permission=` | `explain_access` | the decision and its trace: member? which role, which version, granted or not, and why |

  The trace is one JSON shape, shown by the dashboard as "Why?" beside a member and read by an
  agent as is: the same answer for both.
- **Propose, never apply.** A new proposal operation, `update_organization_role` (add or remove
  permissions), and its MCP tool `propose_update_organization_role`. An agent key asks; a
  person approves in the dashboard or with `tula approve`. A proposal that **adds** a
  permission is marked as a weakening in the approval screen, as a direct change is. Approving
  writes the role, its snapshot and the audit entry in one transaction, with the agent and the
  approver both named.
- **Typed permission keys** (phase 5). `tula types` writes the environment's permission keys as
  a TypeScript union, so `access.check(token, 'org:leads:veiw')` fails to compile: the coding
  agent and the person get the same autocomplete and the same error.
- The pages of this feature are Markdown twins the docs site serves to agents, like every page.

### 8. Retention

- A role's current version is never deleted.
- A superseded version is deleted by the retention job only once it is older than the
  environment's `audit.retentionDays` (never, where that is `null`), so the answer to "what
  could this role do on that day" lasts as long as the audit entries that ask it.
- A restrictive policy, `organization_role_versions_retention_floor`, holds a delete to
  superseded versions more than one day old, whatever a statement asks. No token lives past
  15 minutes, so no token in circulation can point to a deleted snapshot.

### 9. Revocation (phase 5)

The window stays one access token's life, as today: 60 seconds by default, 30 seconds at least,
15 minutes at most; none for a `stateful` session ([ADR 0028](0028-session-profiles.md)). Phase 5
lets a verifier close it sooner with the webhooks it already receives:

- `organization_role.updated`, `organization_membership.role_changed`,
  `organization_membership.removed` and `session.revoked` exist. The checker takes a verified
  event (`access.apply(event)`).
- **Effective permissions = the token's ∩ the latest version the verifier knows.** An
  intersection only removes. A lost or late webhook falls back to the token's life; a forged
  one, if a signature check were skipped, could only deny.
- Removed members and revoked sessions are kept in a deny list for one token life, by id only.
- Reading the latest version needs no new credential: the checker asks
  `GET /v1/client/me/organizations/active/permissions/latest` with the user's own token (see
  "Decided" below).

## Security

### Who and what

Assets: a role's permission set, access tokens, signing keys, the snapshots, each verifier's
cache, the lookup route. Attackers: anyone on the internet; a member of the organization; a
member of another organization or environment; someone between a verifier and Tula; someone
holding a stolen token; a Tula administrator; someone in Tula's database; a compromised
resource server.

### Threats and answers

| Threat | Answer | What is left |
| --- | --- | --- |
| A member edits `org_ph` to a larger set | Signed (EdDSA); an edit fails verification | none |
| `alg: none`, HS256 with the public key | `algorithms: ['EdDSA']`, `iss` and `aud` checked; the header's algorithm is never trusted | none |
| A larger list put in a verifier's cache | Stored only when it hashes to a signed `org_ph`: a second preimage of SHA-256 | an encoding bug: § 2 has one encoding and shared vectors |
| An old SDK misreads a large-role token | Partial claims are no organization | it under-grants until upgraded |
| A token whose version and hash disagree | One row, one read (§ 3) | a bug only: tested |
| Another tenant's role through the lookup | No input; forced row-level security; one answer for every refusal | none |
| A stolen token reads permissions | The lookup needs what the session needs, device proof included | an unbound token works until it expires, as today |
| A fake Tula | The verifier calls only its configured `apiUrl`; the hash check would refuse a forged list anyway | none |
| Cache thrashing | Only an administrator makes a new hash; an unverified token never reaches the cache; the cache is bounded in bytes | none from outside |
| A huge role | 1,000 keys in schema and database | none |
| Flooding the lookup | Per-IP and per-session limits; one indexed read, then the API's own cache | ordinary exposure |
| Tula down with a cold cache | Fails closed: 503 for large roles only; inline roles and cached hashes go on | warm the cache at boot from `list_role_versions` and keep it with webhooks |
| A snapshot deleted under a live token | The retention floor (§ 8) | fails closed if the floor were wrong |
| An administrator grants themselves a permission | A weakening: recorded in the same transaction with the actor, `--allow-weaker`, an event, an immutable snapshot | an administrator can grant: it is detectable and attributable |
| History rewritten from the runtime role | `INSERT` and `SELECT` only on snapshots | the database owner can: export the audit log to write-once storage ([audit export](../audit-export.md)) |
| A forged webhook (phase 5) | Signatures checked, and an intersection only removes | at worst a denial |

Out of scope, as before this ADR: a stolen signing key, the database owner, a compromised
resource server, and a resource server that never checks.

### Invariants (each one a test)

1. A permission grants only when it is in a signed token, or in a list whose hash equals a
   signed `org_ph`.
2. Every failure of the lookup denies; nothing failed is cached.
3. One encoding of a set (§ 2), owned by the contract, with vectors run by every SDK.
4. `org_rv` and `org_ph` come from one snapshot row.
5. Snapshots are append-only for the runtime role; only retention deletes, above its floor.
6. The lookup takes no input but the token, and refuses with one answer.
7. The lookup requires what the session requires, the device proof included.
8. A verifier calls only its configured `apiUrl`.
9. An inline `org_perms` is checked against `org_ph` where both are present.
10. The synchronous check never resolves a reference: it answers `false`.

### SOC 2

| Criterion | How |
| --- | --- |
| CC6.1 logical access, least privilege | exact keys, deny by default, fail closed; a verifier holds no Tula secret; the lookup has no input |
| CC6.2, CC6.3 granting and removing access | every change recorded with its actor in the same transaction; removal within a token's life, or a webhook's delivery in phase 5 |
| CC6.6, CC6.7 transmission | TLS, and the list bound to the signed token by its hash |
| CC7.2 monitoring | the existing role and membership events; lookup failures and hash mismatches counted and logged (a mismatch is an alert) |
| CC8.1 change management | roles as code (`tula diff`, `tula apply`); a grant is a weakening; an agent's change is a proposal a person approves |
| Access reviews, evidence | snapshots and membership audit entries say who could do what on any day; `explain_access` answers one case |
| A1 availability | inline roles never call Tula; a large role calls it once per version |

## Performance

| Path | Cost per request |
| --- | --- |
| Inline role | a signature check and a set lookup (today's path, plus one digest of the inline list) |
| Large role, cached | a signature check and a set lookup |
| Large role, first request of a version in a process | one HTTPS call to an immutable answer, shared by concurrent requests |
| The lookup route | one indexed read, then the API's in-process cache |

No new dependency anywhere: `jose`, Web Crypto and `fetch`.

## Rollout, and why nothing breaks

| Phase | Scope | What a customer sees |
| --- | --- | --- |
| 1 (TULA-207) | the contract (§ 2, § 3, the reader that tells "needs a lookup" from "no organization"), the snapshot table and backfill, `org_rv` and `org_ph` in tokens | tokens about 65 bytes larger; nothing else |
| 2 (TULA-208) | the lookup route (§ 4), the checker (§ 5) in `@tula-tech/core` and the SDKs, conformance scenarios, the generated Swift and Kotlin types | new SDK versions; every role still inline |
| 3 (TULA-209) | `organizations.largeRoles` and the 1,000 bound (§ 6); docs | an operator may now save a large role |
| 4 (TULA-210) | the version and explain routes, the MCP tools, the proposal operation (§ 7) | agents and the dashboard can read, explain and propose |
| 5 (TULA-211) | webhook narrowing (§ 9), `tula types`, an optional permission catalog | faster removal, typed keys |
| Before general availability (TULA-212) | a threat-model review of the built code and an external penetration test of the lookup and the checker | the report is the SOC 2 evidence |

At every step an old SDK, an old token and an old role keep working as they did, and the one
new state a pre-ADR verifier can meet (a large-role token) is read as no organization.

## Alternatives rejected

| Option | Why not |
| --- | --- |
| Raise the cap | still a ceiling, and the cookie budget is already half spent at 32 |
| A bitmap against a published list of the environment's keys (Clerk's `fpm` is a variant) | tiny tokens, but the list's order and version must be agreed by every verifier, it still grows with the catalog, and an auditor cannot read it; it can come later as an optimisation of medium roles |
| Ask Tula on every request | Tula becomes every API's single point of failure and adds a round trip to each call |
| Database sessions only (Better Auth's model) | gives up offline verification, a property Tula is built on |
| Resolve through the admin API with a secret key | puts a key that can delete users on every resource server |

## Open questions

- **Decided: the phase 5 read credential.** There is none. Narrowing reads the newest version
  of the caller's own role with the user's own token, input-free:
  `GET /v1/client/me/organizations/active/permissions/latest` (`getLatestActiveOrganizationPermissions`).
  It has the same auth, device proof, limits and uniform 404 `organization.permissions_unavailable`
  as the lookup by hash, answers `{role, version, permissions, hash}`, requires the membership to
  still exist and sends `Cache-Control: no-store`. `organization_role.updated` carries the role key,
  the new version and the new hash, never a permission key. `access.apply(event)` takes an event
  that is already verified: the caller checks the signature first.
- **Built-in role versions.** `admin` and `member` are versioned by `ensureBuiltInRoles` only;
  confirm their snapshots never need an audit entry beyond ADR 0012's exception.
- **The cache's default bound.** 8 MB is a guess sized for 100 large roles; measure it.

## Consequences

- A role's size stops being a product limit; the token's size stays bounded.
- One more tenant table, one more client route, two more reserved claims, one more setting.
- Every SDK learns the asynchronous check; the synchronous one stays and fails closed.
- Audits gain an exact history of every role.

## What to test

- Encoding: the shared vectors in TypeScript, Swift and Kotlin; shuffled and duplicated input
  gives one hash; an unknown prefix denies; a key outside the grammar refuses the whole list.
- Issue: a small role is inline with a hash that matches; a large role is a reference; version
  and hash come from one row (a concurrent role update cannot split them); the budget edge on
  both sides.
- Lookup: no input accepted; another environment, another hash and a missing snapshot answer
  alike; a device-bound session without a proof is refused; the rate limits; 304 on
  `If-None-Match`.
- Checker: a mismatch, a timeout, a 5xx and a malformed body deny and are not cached; concurrent
  misses make one request; the byte bound evicts; `iss` is never fetched; the synchronous check
  answers `false` for a reference.
- Database (integration): the runtime role cannot update or delete a snapshot; the retention
  floor holds; two role updates make two versions in order; the backfill covers every role.
- Settings: a large role is refused while `largeRoles` is off; switching it off with a large
  role in use is refused; both are recorded.
- Agents: an agent key reads versions and explanations and cannot write a role; a proposal that
  adds a permission is a weakening; approval writes the role, the snapshot and the entry
  together.
- Old clients: a pre-ADR reader given a large-role token returns no organization.
