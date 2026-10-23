# Importing users

Moving from another provider should not make anyone reset a password. `POST
/v1/admin/users/import` creates up to **500 users per call** and takes, for each, the
password hash they have in the system they come from. The user signs in with their old
password; the first successful sign-in **replaces the foreign hash with Tula's argon2id**,
and nobody notices. The reasoning is in [ADR 0066](adr/0066-user-import.md).

This page covers `bcrypt`, `argon2id` and `argon2i` hashes. A hash made with Firebase's
scrypt variant or PBKDF2 is a later addition to the same request.

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
| `metadata` | Optional object, at most 4 KiB as JSON. |
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

A hash is parsed and refused if it is not well formed or its parameters are out of range:

| Limit | Minimum | Maximum |
| --- | --- | --- |
| bcrypt cost | 10 | 14 |
| argon2 memory | 19,456 KiB (19 MiB) | 262,144 KiB (256 MiB) |
| argon2 passes | 2 | 10 |
| argon2 lanes | 1 | 8 |

The minimums are OWASP's. The maximums protect your sign-in: a user whose hash asks for
gigabytes would make every one of their sign-ins exhaust the server. The environment's
[password policy](methods/password.md) is **not** applied to an imported password (nobody
but the user knows the plaintext); set `password.expiryDays` if you want imported
passwords replaced.

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
| `validation.failed` | `metadata` is over 4 KiB. |

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
