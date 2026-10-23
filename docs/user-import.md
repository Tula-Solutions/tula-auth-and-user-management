# Importing users

Moving from another provider should not make anyone reset a password. `POST
/v1/admin/users/import` creates up to **500 users per call** and takes, for each, the
password hash they have in the system they come from. The user signs in with their old
password; the first successful sign-in **replaces the foreign hash with Tula's argon2id**,
and nobody notices. The reasoning is in [ADR 0066](adr/0066-user-import.md).

To move users from Clerk, Auth0, Firebase, Supabase or better-auth, you do not call the route
yourself: [`tula import`](cli.md#tula-import) reads the provider's export, reports what it would
do and sends the batches. One guide each: [Clerk](migrate-from-clerk.md),
[Auth0](migrate-from-auth0.md), [Firebase](migrate-from-firebase.md),
[Supabase](migrate-from-supabase.md), [better-auth](migrate-from-better-auth.md).

This page covers `bcrypt`, `argon2id`, `argon2i`, `pbkdf2_sha256` (Django and others) and
`firebase_scrypt` (Firebase Authentication) hashes.

## Import users

With a secret key, on the admin API (an agent key is refused: an import is a write):

<!-- snippet: examples/docs-snippets/admin.ts#user-import -->
```ts
// Up to 500 users per call. Run it again over the same file after a failure:
// a user that exists is skipped, never created twice.
const { data } = await admin.call('importUsers', {
  body: {
    users: rows.map((row) => ({
      email: row.email,
      emailVerified: true,
      name: row.name,
      password: { algorithm: 'bcrypt', hash: row.bcryptHash },
    })),
  },
})
const refused = data.results.filter((result) => result.status === 'refused')
// Each refused row has a contract error `code`, such as `import.hash_parameters_too_weak`.
```
<!-- /snippet -->

Or without the SDK:

```sh
curl -X POST https://auth.example.com/v1/admin/users/import \
  -H "Authorization: Bearer $TULA_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "users": [{
    "email": "maya@northline.app",
    "emailVerified": true,
    "name": "Maya Chen",
    "externalId": "auth0|64f1",
    "metadata": { "plan": "team" },
    "password": { "algorithm": "bcrypt", "hash": "$2b$10$…" }
  }] }'
```

### A row

| Field | |
| --- | --- |
| `email` | Required. Validated and normalized as for any user. |
| `emailVerified` | Required. `true` only if the source had proven the address: a user whose address is not verified signs in with the old password only after verifying it. |
| `name` | Optional, up to 200 characters. Split at the first space into the first and last name. |
| `metadata` | Optional object, at most 4 KiB **as stored**: the compact JSON plus about one byte for every `:` and `,` (the database prints a space after each), nested at most 32 levels deep. |
| `externalId` | Optional, up to 256 characters: the user's id in the system they come from. |
| `password` | Optional. Without it the user has no password and signs in another way or resets. |

`metadata` and `externalId` are stored with the user. They are not returned by the user
routes yet.

### The password

`password` is `{ algorithm, hash }`. `algorithm` is one of:

| `algorithm` | `hash` |
| --- | --- |
| `bcrypt` | A bcrypt string: `$2a$`, `$2b$` or `$2y$`, cost 10 to 14. |
| `argon2id` | An argon2 PHC string (`$argon2id$v=19$m=…,t=…,p=…$salt$digest`). |
| `argon2i` | The same, for argon2i. |
| `pbkdf2_sha256` | PBKDF2-HMAC-SHA256, in one of the forms [below](#pbkdf2-sha256). |
| `firebase_scrypt` | Firebase's `passwordHash`, with the user's `salt` in `params` and the project's parameters in the call's `firebaseScrypt` ([below](#firebase-authentication)). |

A hash is parsed and refused if it is not well formed or its parameters are out of range:

| Limit | Minimum | Maximum |
| --- | --- | --- |
| bcrypt cost | 10 | 14 |
| argon2 memory | 19,456 KiB (19 MiB) | 262,144 KiB (256 MiB) |
| argon2 passes | 2 | 10 |
| argon2 lanes | 1 | 8 |
| PBKDF2-SHA256 iterations | 100,000 | 2,000,000 |
| scrypt cost (`memCost`, log2 of N) | 12 | 16 |
| scrypt `rounds` (r) | 4 | 16 |
| scrypt memory (128 × N × r) | | 64 MiB |

The minimums are OWASP's. The maximums protect your sign-in: a user whose hash asks for
gigabytes would make every one of their sign-ins exhaust the server. The environment's
[password policy](methods/password.md) is **not** applied to an imported password (nobody
but the user knows the plaintext); set `password.expiryDays` if you want imported
passwords replaced.

### PBKDF2-SHA256

Set `algorithm` to `pbkdf2_sha256`. The hash may be any of:

| Form | Example |
| --- | --- |
| Django | `pbkdf2_sha256$260000$Xp9aBcDeFgHi$tPuMiTl59uBG…=` (the salt as written, the hash base64) |
| PHC | `$pbkdf2-sha256$i=600000,l=32$<salt>$<hash>` (unpadded base64; `l`, if given, is the hash length) |
| passlib | `$pbkdf2-sha256$600000$<salt>$<hash>` (its `.` for `+` base64, unpadded) |
| A derived key | `hash` is the base64 key and `params` is `{ "iterations": 600000, "salt": "<base64>" }` |

The salt must be 8 to 64 bytes and the key 16 to 64 bytes. The floor of 100,000 iterations
is below OWASP's current 600,000 so that the real exports of older systems (Django before
4.2 used 260,000) can be moved; the user's first sign-in replaces the hash with argon2id
whatever it was. A hash below the floor is `import.hash_parameters_too_weak`; above 2,000,000
(about 135 ms of CPU on every sign-in of that user until it is replaced) it is
`import.hash_parameters_too_costly`. A salt that is not a salt, a count that is not a whole
number or base64 that is not base64 is `import.hash_malformed`.

### Firebase Authentication

Export the users with the Firebase CLI, which also gives you the project's hash parameters:

```sh
firebase auth:export users.json --format=JSON --project <project-id>
```

The project's parameters (**Authentication → Users → ⋮ → Password hash parameters** in the
console) are four values, the same for every user: `base64_signer_key`,
`base64_salt_separator`, `rounds` and `mem_cost`. Each user in the export has a `passwordHash`
and a `salt`. Send the parameters **once per call** as `firebaseScrypt`, and each user's two
values in their row:

```sh
curl -X POST https://auth.example.com/v1/admin/users/import \
  -H "Authorization: Bearer $TULA_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "firebaseScrypt": {
      "signerKey": "<base64_signer_key>",
      "saltSeparator": "<base64_salt_separator>",
      "rounds": 8,
      "memCost": 14
    },
    "users": [{
      "email": "maya@northline.app",
      "emailVerified": true,
      "password": {
        "algorithm": "firebase_scrypt",
        "hash": "<passwordHash>",
        "params": { "salt": "<salt>" }
      }
    }]
  }'
```

`emailVerified` comes from the export's `emailVerified`. Firebase's own values are `rounds: 8`
and `memCost: 14`; the server accepts a `memCost` of 12 to 16 and `rounds` of 4 to 16 whose
scrypt memory (128 × 2^`memCost` × `rounds`) is at most 64 MiB. The signer key is a secret of
your Firebase project: the server **seals it** with its master key, bound to the user it is
kept for, inside that user's stored hash. It is never returned, logged, put in an audit entry
or an event, and it is gone from the user's record when their first sign-in replaces the hash.
A `firebase_scrypt` row in a call without `firebaseScrypt`, or with parameters outside the
limits, is refused on its own with `import.hash_malformed`,
`import.hash_parameters_too_weak` or `import.hash_parameters_too_costly`.

## The answer

The call is not all-or-nothing, and each row is. The answer has one entry per row, in order:

```json
{
  "results": [
    { "index": 0, "status": "created", "id": "0199c2f5-…" },
    { "index": 1, "status": "skipped", "reason": "email_exists" },
    { "index": 2, "status": "refused", "code": "import.hash_parameters_too_weak", "message": "…" }
  ],
  "created": 1,
  "skipped": 1,
  "refused": 1
}
```

| `status` | Meaning |
| --- | --- |
| `created` | The user exists now. `id` is theirs. |
| `skipped` | `email_exists`: that address (compared in its normalized form) is already a user. `repeated_in_batch`: an earlier row of the same call has it. |
| `refused` | The row is wrong. `code` says why. Nothing was written for it. |

Importing the same file again creates nobody twice, so an import that stopped halfway is
resumed by running it again.

A request that is not the right shape at all, such as more than 500 rows, an empty list or a
row with no `email`, is refused whole with `422`.

### Why a row is refused

| `code` | |
| --- | --- |
| `email.invalid` | The address is not valid. |
| `import.unsupported_algorithm` | `algorithm` is not one of the above. |
| `import.hash_malformed` | The hash is not a hash of the algorithm named. |
| `import.hash_parameters_too_weak` | Below the minimums above. |
| `import.hash_parameters_too_costly` | Above the maximums above. |
| `validation.failed` | A row's `metadata`, `name` or `externalId` cannot be stored: `metadata` is over 4 KiB as stored (about one extra byte per `:` and `,`); `metadata` is nested more than 32 levels deep; a NUL character or a lone surrogate is in `metadata` (a key or a value), `name` or `externalId`; `metadata` holds a number JSON writes with an exponent (such as `1e300`); or the database itself refused the row's data. Only that row is refused. |

## What the first sign-in does

The stored hash is verified with its own algorithm. When the password is right the server
stores an argon2id hash of it in place of the foreign one, in the same sign-in. The
password's age does not change: it starts at the import, so
[`password.expiryDays`](methods/password.md) counts from the day you imported, and the user
has no password history before it.

## What an import records

Each user is one audit entry, **`user.imported`**, by the administrator whose key ran the
import, written in the same transaction as the user. It holds whether the address was
verified and which algorithm the password came with, never the address, a name or a hash.

An import does **not** fire `user.created`. A webhook endpoint that wants imports subscribes
to [`user.imported`](webhooks.md) on purpose, so that a migration of a hundred thousand
users does not become a hundred thousand sign-up deliveries.

## Limits

- 500 rows and 4 MiB per call.
- 20 calls a minute per environment (and the admin per-IP limit): a rate-limited call is
  `429` with `Retry-After`.
- Rows are written one after another.
