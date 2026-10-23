# ADR 0066: Importing users with their password hashes

- **Status:** accepted
- **Date:** 2026-10-22
- **Ticket:** TULA-114 (phase 3, import, part of TULA-110)

## Context

An operator moving from another provider has users with passwords. Creating them one at a
time from a plaintext password (`POST /v1/admin/users`) is impossible: nobody holds the
plaintext. Making every user reset is the cost that keeps operators where they are.

So the server has to take another system's **hash**, verify it with that hash's own
algorithm, and replace it with Tula's argon2id the first time the right password is typed.
This ADR is the bcrypt and argon2 part. Firebase's scrypt variant and PBKDF2 (TULA-118) and
the `tula import` command are later tickets; the request's shape is chosen so they are
additions.

(The numbering may need a swap at merge: an ADR for organizations was written in parallel
and also wants the next number.)

## Decision

### The route

`POST /v1/admin/users/import`, behind `secretKey()` (so an agent key is refused: it is a
write), up to **500 rows** per call. A row is `{ email, emailVerified, name?, metadata?,
externalId?, password? }`, and `password` is a tagged form `{ algorithm, hash, params? }`.

- `algorithm` is a **plain string** on the wire, not an enum. A name the server does not know
  is refused for that row (`import.unsupported_algorithm`), and a later algorithm is a new
  accepted value and nothing else. `params` is for algorithms whose hash does not carry its
  own parameters (TULA-118's PBKDF2 and scrypt); for bcrypt and argon2 the parameters are
  in the hash and `params` is ignored.
- The call is **not all-or-nothing, and each row is atomic**. The answer has one entry per
  row, in order, with its `index`: `created` (with the user's id), `skipped` (`email_exists`:
  the normalized address is taken; `repeated_in_batch`: an earlier row of the call has it) or
  `refused` (a contract error code and its message). A request that is not the right shape
  at all (more than 500 rows, a row with no `email`) is refused whole with 422, because
  there is nothing to report row by row.
- **Idempotent by normalized email.** Running the same file again creates nobody twice, which
  is what makes a resumed import safe. A row that fails for a reason of its own (a refused
  hash) does not mark its address as seen, so a later corrected row for the same address in
  the same call is not called a repeat.
- A failure of the store (not a refused row) answers 5xx for the call; the rows before it are
  created and the retry reports them as skipped (with their ids: see "A retried batch").
- **Name, metadata and external id.** A row's `name` is split at the first whitespace into
  `firstName` and `lastName` (each cut to the 100 characters the columns allow); users have
  no single name field. `metadata` (an object, at most 4 KiB as stored, which is the compact JSON plus about one byte per `:` and `,`, and at most 32 levels deep, judged iteratively before any stringify; `validation.failed`
  beyond it) and `externalId` are stored on two new columns of `users` (migration `0037`):
  `metadata` with a database check on its size, `externalId` indexed by nothing and unique
  for nobody (two sources may reuse an id; matching rows to a source is the operator's job
  with the id). **They are stored and not yet returned**: `User` does not carry them, and
  making them readable is a contract change of its own that this ticket does not take.

### Parameter floors, and ceilings

A hash is parsed before it is stored, and what does not parse, or has parameters outside
these limits, is refused.

| | Floor | Ceiling | Why |
| --- | --- | --- | --- |
| bcrypt cost | 10 | 14 | 10 is OWASP's minimum work factor. 14 is about a second of CPU per verification: every sign-in of that account pays it, and a hash made by someone else is not a cost the operator chose here. Accepted prefixes `$2a$`, `$2b$`, `$2y$`; `$2x$` (the buggy one) and `$2$` are malformed. |
| argon2 memory | 19,456 KiB (19 MiB) | 262,144 KiB (256 MiB) | OWASP's lowest-cost argon2id configuration is 19 MiB, 2 passes, 1 lane. The ceiling is 4 times what this server itself uses (64 MiB); a hash asking for gigabytes would make one sign-in a memory exhaustion. |
| argon2 time | 2 | 10 | The same OWASP minimum; 10 passes bounds the CPU. |
| argon2 parallelism | 1 | 8 | A lane count under 1 is not a hash; above 8 is more threads than a sign-in should take. |

Also required: argon2 version `0x13` (19; the old 16 is refused as malformed), a salt of at
least 8 bytes and a digest of at least 16 bytes (the RFC 9106 minimums), and the **declared
algorithm equal to the hash's own prefix** (a hash declared as `argon2id` that is argon2i, or a
bcrypt hash declared as argon2, is `import.hash_malformed`; believing the declaration would
verify under the wrong rules). Weak and malformed are distinct codes
(`import.hash_parameters_too_weak`, `import.hash_malformed`), as is too costly
(`import.hash_parameters_too_costly`).

Not applied to an imported password: the environment's password policy and the
breached-password check. Only the user knows the plaintext. A weak password stays weak until
they sign in or reset it; an operator who wants more sets `password.expiryDays` after the
import.

### Verification

`Passwords.verify` calls `Bun.password.verify`, which reads the algorithm from the stored
hash: argon2id, argon2i and bcrypt in all three prefixes. There is no second code path to
keep equal. Three decisions around it:

- **A hash that cannot be read matches nothing** and does not throw (it used to throw
  `InvalidEncoding`, which would have been a 500 at sign-in). A row can come from before this
  rule or from a restore.
- **The unknown-user dummy verify is unchanged**: an unknown address still runs one argon2id
  verification with the current parameters, and every kind of account makes the same single
  call (a test counts them). **That is the same *work in kind*, not the same *time*, and the
  difference is an accepted, bounded exposure.** Until its first sign-in an imported account
  is verified with its own hash, which takes a different time from the dummy: a bcrypt
  cost-10 verification is faster than argon2id at 64 MiB, a bcrypt cost-14 one slower, an
  argon2 hash at the floor (19 MiB) faster, one at the ceiling (256 MiB) slower. Someone who
  can time the sign-in endpoint precisely, across many samples, can tell "imported and not
  signed in yet" from "no such account". What limits it: the accepted band is narrow (the
  floors and ceilings above keep a verification within a small factor of the current one,
  not orders of magnitude), network jitter and the per-IP and per-account limits bound the
  samples an attacker gets, and it ends at that user's first successful sign-in, when the
  hash becomes the current argon2id one. It reveals a fact about the migration, never a
  password. Padding every verify to the slowest accepted hash was rejected: it would charge
  every sign-in of every user for a cost only imported users carry. No timing test pins it:
  such tests are flaky on CI.
- **The password as typed is tried as well as its NFC form** when they differ, for every
  kind of account (the dummy included, so the count of verifications is the same). The
  other system did not normalize what it hashed, and a user whose password has a decomposed
  accent would otherwise be locked out by the move. Bun's bcrypt first hashes a password over
  72 bytes with SHA-512 where other libraries truncate; a user with such a password whose
  hash was made by a truncating library will not match and resets. This is a known limit,
  not tested for a vector. The pair does not cover an origin that hashed the **NFD** form
  while the user types NFC (or any other form): the typed password and its NFC form are both
  NFC, neither is the NFD the hash was made from, and that user resets.

### The first sign-in replaces the hash

`Passwords.needsRehash` is true for any hash that is not argon2id with the current
parameters, so the existing path (`Flows.submitPassword` → `users.upgradePasswordHash`)
replaces a foreign hash with an argon2id one of the password (NFC-normalized, as every
stored password is) right after the verification that proved it. Nothing was added to the
flow engine. An imported argon2id hash with exactly the current parameters is already
current and is kept.

### Where an imported password's age and history stand

- **Age** ([ADR 0041](0041-password-expiry.md)): `secret_changed_at` is the **time of the
  import**. The source's date is not known to us and, if it were, a migration into an
  environment with `expiryDays` would send every user to a new-password screen at their
  first sign-in. Counted from the import, the clock starts on the day the operator chose to
  trust these passwords. The first-sign-in rehash does not move it (ADR 0041).
- **History** ([ADR 0038](0038-password-history.md)): none. The imported hash is the
  user's current password, which counts as one of the last N, and there is nothing before it
  to compare with.

### Audit, events and webhooks

- One entry per user, **written with the user in the same transaction** (the store's
  `create`, as for every other user), by the actor the router built from the admin's key
  (`adminActor`).
- A **new activity type, `user.imported`**, not `user.created`: an import of a hundred
  thousand users must not be a hundred thousand `user.created` deliveries to endpoints that
  subscribed to sign-ups, and an endpoint that wants imports subscribes to this type
  deliberately. Its target is the user; its data is `emailVerified` (boolean),
  `passwordless` (boolean, when no hash came) and `passwordAlgorithm` (a closed set:
  `bcrypt`, `argon2id`, `argon2i`). No address, name, hash, metadata or external id (the
  event rules of ADR 0012). The entry's "source" is the type itself.
- The event canary holds: its scenario run now includes an import.

### Limits

- A **per-environment rate limit** of 20 calls a minute (`user_import`, at most 10,000
  users a minute), mounted after `secretKey()` so it counts only authorized calls, and
  failing closed when the limiter is down. The route also has the admin per-IP limit.
- The request body is capped at **4 MiB** for this route only (`MAX_IMPORT_BODY_BYTES`),
  against 64 KiB for every other route: 500 rows with a bcrypt hash and a name are about
  100 KB. The socket cap of the server is raised to the same figure and the application
  enforces 64 KiB elsewhere. The route is authenticated before the body is parsed, but the
  body limit is enforced earlier, so an unauthenticated caller can make the server read up
  to 4 MiB to this one path; that is bounded and not parsed.
- The import is an expensive write (up to 500 transactions), which is why it has a limit of
  its own. Its rows are written one after another and never side by side: a parallel import
  would hold many pool connections for one administrator's convenience.

## Consequences

- Operators can migrate bcrypt and argon2 users without a reset.
- A hash that is imported is stored as given until the first sign-in. It is a credential
  like any other: never returned by any route, never logged, never in an event (the audit
  entry names the algorithm and nothing of the hash).
- Two new columns on `users` hold data nothing reads yet.
- TULA-118 adds `firebase_scrypt` and `pbkdf2_sha256` as new values of `algorithm` with
  `params`, and a verifier in front of `Bun.password.verify` for formats it does not read
  (amendment below). The row's wire format does not change.

## Not done

- ~~`tula import` and each provider's export format.~~ Done in TULA-122 (amendment below).
- Importing organizations and memberships.
- Returning `externalId` and `metadata` on `User`.
- A way to mark an import's rows as webhook-visible (`user.created` too). The ticket
  asks for deliberate subscription; a flag on the call is a later decision.

## Amendment: Firebase scrypt and PBKDF2-SHA256 (TULA-118)

Two more values of `algorithm`. Neither is read by `Bun.password.verify`; both are verified in
`modules/password/foreign-hash.ts`, which `Passwords.verify` asks first (`null` means "another
format", and the call goes on to Bun). The first sign-in replaces the hash exactly as for bcrypt
(`needsRehash` is true for anything that is not argon2id with the current parameters).

### PBKDF2-HMAC-SHA256 (`pbkdf2_sha256`)

Accepted as Django's `pbkdf2_sha256$iterations$salt$hash` (the salt is the text itself), PHC
`$pbkdf2-sha256$i=N[,l=L]$salt$hash`, passlib's `$pbkdf2-sha256$N$salt$hash` (its `.`-for-`+`
base64), or a base64 derived key with `params` `{ iterations, salt }` (salt base64). Whatever the
form, it is **stored in one**: `$pbkdf2-sha256$i=N$<salt>$<hash>` (PHC, unpadded base64), so
verification reads one format. Base64 is read strictly: only the canonical encoding of its bytes.

| | Floor | Ceiling | Why |
| --- | --- | --- | --- |
| iterations | 100,000 | 2,000,000 | OWASP asks 600,000 today, but Django before 4.2 shipped 260,000 and older exports are lower still; refusing all of them would defeat the import, and the first sign-in replaces the hash. 100,000 is where storing a hash becomes the mistake. 2,000,000 is about 135 ms (measured on a developer laptop) paid on every sign-in of that account until it is replaced. |
| salt | 8 bytes | 64 bytes | |
| derived key | 16 bytes | 64 bytes | |

A count that is not a whole number, a salt or digest outside those sizes and base64 that is not
base64 are `import.hash_malformed`. The derivation runs on the thread pool (`crypto.pbkdf2`), not
on the event loop, and the stored count is judged again at verification (a row edited behind the
server's back matches nothing).

### Firebase's modified scrypt (`firebase_scrypt`)

Firebase hashes with scrypt (`N = 2^mem_cost`, `r = rounds`, `p = 1`) of the password with the
user's `salt` followed by the project's `salt_separator`, takes the 32-byte key, and uses it as an
AES-256-CTR key (zero IV) to encrypt the project's `signer_key`; the result is `passwordHash`. It is
checked against the vector in the `firebase/scrypt` README (`user1password`).

**Where the project's parameters live.** The project's four values are given **once per call**
(`firebaseScrypt` beside `users`; the row has `hash` = `passwordHash` and `params: { salt }`), and
are sealed **per user, inside the user's stored hash**:
`$tula-firebase-scrypt$v1$<sealed>$<salt>$<hash>`. `<sealed>` is `SecretBox.seal` of the four values,
purpose `import-hash-parameters`, bound (AAD) to `import-hash:<environmentId>:<userId>`, so a block
copied into another user's row, another environment or a restore under another master key does not
open. Alternatives considered:

- *A per-environment record referenced by id.* It needs a table, RLS, an admin route or an import
  step that creates it, a lifecycle (when is it deleted? when the last user has signed in?) and a
  retention rule, and `Passwords.verify` would need a database read on every sign-in. Rejected: the
  value of a shared record is one copy of a key that is worth the same sealed 100,000 times.
- *Per user, inline* (chosen). No migration, no new table, no new read on the sign-in path (the
  hash is already loaded), and the key leaves the database as users sign in: the replacement hash
  has no trace of it. The cost is about 250 bytes more per Firebase user and one AES-GCM per row.

Because nothing but `Passwords.verify`'s `Foreign.Opener` (the secret box, the environment and the
user) can open the block, `Passwords.verify`, `assertNotReused` and the three callers pass it; a
Firebase hash verified without one matches nothing.

| | Floor | Ceiling | Why |
| --- | --- | --- | --- |
| `mem_cost` (log2 N) | 12 | 16 | Firebase's own is 14 (with `rounds` 8: 16 MiB). 12 is 4 MiB at 8 rounds, below which a hash is not a scrypt anyone chose. |
| `rounds` (r) | 4 | 16 | Firebase's own is 8. |
| memory, 128 x N x r | | 64 MiB | The product, not just the two ceilings: 16 and 16 would be 128 MiB in one sign-in. 64 MiB is the memory this server itself uses for an argon2id hash. `p` is always 1, as Firebase has it. |
| signer key | 1 byte | 128 bytes | Firebase's is 64 bytes; the row's hash must be as long as the key (CTR keeps the length), else it can never match and is malformed. |
| salt separator | 0 bytes | 64 bytes | |
| row salt | 8 bytes | 64 bytes | |

The parameters are secrets of the source project. They are in the request body (a body is never
logged) and in nothing else: not in an answer, a log line, an audit entry or an event (`user.imported`
names `firebase_scrypt` and nothing more; the closed `passwordAlgorithm` set grew by the two names).
A `firebase_scrypt` row in a call without `firebaseScrypt`, or with parameters outside the limits,
is refused on its own: `import.hash_malformed`, `import.hash_parameters_too_weak` or
`import.hash_parameters_too_costly`. No new error code was needed. The limits are judged again after
the block is opened at verification, so a block sealed with out-of-range values (a row written by
hand under the real key) matches nothing instead of starting an unbounded derivation.

### Timing

The unknown-user dummy verify is unchanged. As the verification section says, an imported account
takes a different time from the dummy until its first sign-in: (measured on a developer laptop) a PBKDF2 hash at its floor is about
7 ms and one at its ceiling about 135 ms, against about 65 ms for argon2id at 64 MiB; Firebase
scrypt at its own parameters is about 18 ms and at its ceiling about 135 ms. Both are comparisons with `~/lib/crypto.timingSafeEqual`
of equal-length buffers, and the same candidate pair (as typed and NFC) is tried as for the others.

## Amendment: `tula import` (TULA-122)

`tula import --from clerk|auth0|firebase|supabase|better-auth <export>` is the client of this route
(`packages/cli/src/import/`, [docs/cli.md](../cli.md#tula-import)). No route and no contract field
was added: the command parses a provider's export into `ImportUsersRequest` rows on the operator's
machine and calls `importUsers` and, for Clerk's organizations, `createOrganization`,
`addOrganizationMember` and the two list routes (users by address, organizations by slug).

- **One parser per provider**, pure and tested with a fixture of that export's format. A hash is
  mapped to the algorithms of this ADR only. **better-auth's default scrypt (`salt:key`, hex) is not
  one of them**, and this ticket added no server algorithm: such a row is refused with
  `import.unsupported_algorithm` and a reason, or, with `--allow-passwordless`, imported without a
  password. The same holds for Clerk's `md5`, `sha256`, `scrypt` and `phpass` hashers and for any
  hash whose prefix is unknown.
- **A user the provider had disabled, blocked, banned or soft-deleted is refused** (`source.user_disabled`,
  `source.user_deleted`): the route has no way to import a banned account, and importing it as a live
  one would reopen it. This is the command's decision and not the route's.
- **Dry run first.** Without `--yes` nothing is sent and no key is read. The report names rows by
  their number, a code and a masked address; no hash, token, signer key or whole address is printed.
- **A progress file** (row numbers, offsets, counts, codes and ids; no address, name, hash or
  signer key; mode `0600`) lets a stopped run continue, bound to the export, the provider and
  a truncated SHA-256 of the API's origin and key. The route's idempotence by address is what makes
  a re-sent batch safe; the file only saves the work.
- **Rate limit:** a `429` is waited out for `Retry-After` up to a cap (default 120 s) and the batch
  is sent again, as is a request with no answer or a `5xx`, six tries in all.
- **Organizations** are identified by slug (an existing one is used) and members by user id, found
  from the id created in this run or by the user's address.

## Amendment: a retried batch (TULA-126)

A batch whose answer is lost may have been committed. The retry then finds every address taken
and reported them all as `skipped`, so `tula import` counted created users as skipped, and a
Clerk member whose user was made by the lost attempt had no recorded id and fell back to a
lookup by address.

- **Decision: the duplicate answers with the existing user** (option a). A `skipped` result with
  `reason: 'email_exists'` gains two optional fields: `id` (the existing user's id) and
  `sameExternalId` (whether that user's stored `externalId` equals the row's; `false` when either
  side has none). `repeated_in_batch` carries neither. The change is additive.
- **Why not an idempotency key per batch** (option b). It needs a new short-lived table with a
  retention purge (or Redis), a key to generate and persist in the progress file, a policy for a
  key reused with another body, and it still would not cover a run killed between the commit
  and the saved progress. Reading the outcome from the data itself needs none of that, and the
  rows are idempotent by address already.
- **Security.** The administrator sent the address and can already list users by it, so an id is
  nothing new. `sameExternalId` is one bit about a value the administrator also sent. Nothing
  else of the user is returned (no email, name, metadata, or the stored `externalId` itself),
  the read is one store method (`findImportMatch`) scoped to the environment, and the route stays
  behind `secretKey()`. A user who vanishes between the failed insert and the read is skipped
  without an id.
- **The client's rule** (`packages/cli/src/import/run.ts`). Every duplicate with an `id` records
  the pairing of a provider id to a Tula id (no lookup by address later). Only in a batch that
  was **sent again after a failed attempt in this run**, a duplicate with `sameExternalId: true`
  counts as created; anywhere else it stays skipped, because outside a retry the user was
  there before this run. Every parser sets `externalId` to the provider's user id.
- **Residual.** A run killed after the server committed a batch and before the progress file was
  saved resumes by sending that batch as a first attempt, so its users count as skipped. Their
  ids are still recorded. A retried duplicate with the same external id may also have been
  imported by an earlier run, not the lost attempt; either way the row's user is already
  imported, and the count says created. A server that predates this amendment sends no ids and
  the client behaves as before.
