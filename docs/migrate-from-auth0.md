# Migrating from Auth0

`tula import --from auth0` reads Auth0's bulk user export and, when you have it, the separate
file of password hashes, on your machine. It shows what it would do and imports the users, so
nobody resets a password. The command makes **no request to Auth0**. How the import works, and
what the server checks, is in [Importing users](user-import.md); every option is in
[the CLI page](cli.md#tula-import).

## What you need

- **The user export.** Export the tenant's users with the Management API's `users-exports` job
  (format `json`: one JSON object per line) or the Bulk User Import / Export extension. A JSON
  array is read too. The fields used are `user_id`, `email`, `email_verified`, `name`,
  `given_name`, `family_name`, `user_metadata`, `app_metadata` and `blocked`.
- **The password hashes, from Auth0 support.** Auth0 does not put password hashes in the user
  export, and no API returns them. They are given through a support request (available on paid
  plans) as a second file, one JSON object per line, with `_id`, `email` and `passwordHash`. The
  hashes are bcrypt. Ask for the hashes of the tenant's database connection.
- **A secret key** of the environment you are importing into, and the server's address
  ([credentials](cli.md#credentials-are-never-arguments)).

Auth0's screens and the support process change; the formats above are what the command reads.

## Dry run

```sh
bun add -d @tula-tech/cli@latest
bunx tula import --from auth0 auth0-users.ndjson --password-hashes auth0-password-hashes.ndjson
```

The report counts the users by password algorithm and lists every refused row with its number, a
code and a masked address. Nothing is sent, and no key is needed. Then:

```sh
export TULA_API_URL=https://auth.example.com
export TULA_SECRET_KEY=tula_sk_prod_…
bunx tula import --from auth0 auth0-users.ndjson \
  --password-hashes auth0-password-hashes.ndjson --yes
```

If the run stops, run **the same command** again: it continues from
`auth0-users.ndjson.tula-import-progress.json`, a file of row numbers, counts, codes and ids with
no address and no hash.

## How the hashes are matched to users

Each entry of the hash file is matched to a user by `auth0|<_id>`, which is the user's `user_id`.
If the id does not match, an address that **exactly one** entry has is used. The report says how
many entries matched no user, and how many database users had no hash. Without
`--password-hashes`, the database users are imported without a password and the report says so.

A user may also carry Auth0's own import field, `custom_password_hash`, in the user file; a
`bcrypt` or `argon2` one is carried too.

## What is carried over

| Auth0 | Tula |
| --- | --- |
| `email`, `email_verified` | `email`, `emailVerified` |
| `name`, else `given_name` and `family_name` | `name` |
| `user_id` | `externalId` (stored, not yet returned by the user routes) |
| `user_metadata`, `app_metadata`, `username` | `metadata.auth0` (stored, not yet returned), left out if it would pass 4 KiB |
| bcrypt `passwordHash` | the password; the first sign-in replaces it with argon2id |

## What is refused, and what is not carried

- **Blocked users** (`blocked: true`) are refused with `source.user_disabled`: importing them would
  make the account usable again.
- **Users with no email address** (a phone-only user, for example) are refused with `email.invalid`.
- **A hash in another format** is refused with `import.unsupported_algorithm`, or with
  `--allow-passwordless` the user is imported without a password.
- **Social and passwordless users** are imported without a password, and sign in the way they did
  before once you have set the provider up in Tula ([OAuth](methods/oauth.md)). Their
  linked accounts are not carried over.
- **Multi-factor enrolments and sessions are not carried over.**
- A line of the user file that is not a JSON object is a refused row (`source.row_unreadable`), not
  a failed run.

## After the import

Keep Auth0 running until your users have signed in once: a user who signs in with the old password
gets a Tula argon2id hash in the same sign-in. See
[what the first sign-in does](user-import.md#what-the-first-sign-in-does).
