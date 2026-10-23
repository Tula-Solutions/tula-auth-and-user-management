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
  created and the retry reports them as skipped.
- **Name, metadata and external id.** A row's `name` is split at the first whitespace into
  `firstName` and `lastName` (each cut to the 100 characters the columns allow); users have
  no single name field. `metadata` (an object, at most 4 KiB as JSON; `validation.failed`
  beyond it) and `externalId` are stored on two new columns of `users` (migration `0036`):
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
  `params`, a branch in `Foreign.parse`, and a verifier in front of `Bun.password.verify`
  for formats it does not read. The wire format does not change.

## Not done

- `tula import` and each provider's export format.
- Importing organizations and memberships.
- Returning `externalId` and `metadata` on `User`.
- A way to mark an import's rows as webhook-visible (`user.created` too). The ticket
  asks for deliberate subscription; a flag on the call is a later decision.
