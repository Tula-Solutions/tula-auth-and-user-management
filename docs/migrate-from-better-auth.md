# Migrating from better-auth

`tula import --from better-auth` reads better-auth's `user` and `account` tables, exported on your
machine, shows what it would do, and imports the users. The command makes **no request** to
your old app. How the import works, and what the server checks, is in
[Importing users](user-import.md); every option is in [the CLI page](cli.md#tula-import).

> **Read this first: better-auth's default password hash is scrypt, and this server does not read
> it yet.** Users whose password is hashed that way are **refused** by default
> (`import.unsupported_algorithm`, with the reason in the report), or, with `--allow-passwordless`,
> imported without a password so that they sign in another way or reset it. A better-auth app that
> was configured with a bcrypt or argon2 password hasher is carried. The server reads `bcrypt`,
> `argon2id`, `argon2i`, `pbkdf2_sha256` and `firebase_scrypt`, and nothing else.

## What you need

- **The `user` table**, as JSON or CSV: `id`, `name`, `email`, `emailVerified`, and `banned` if you
  use the admin plugin. Column names in camelCase (`emailVerified`) or snake_case are both read.
- **The `account` table**, which holds the passwords, as JSON or CSV: only the rows with
  `providerId` = `credential` matter (`userId`, `providerId`, `password`). Your tables may be
  named differently (a prefix, a `modelName`).

  ```sh
  psql "$DATABASE_URL" -c '\copy (select * from "user") to ba-user.csv csv header'
  psql "$DATABASE_URL" -c '\copy (select * from account where "providerId" = '"'"'credential'"'"') to ba-account.csv csv header'
  ```
- **A secret key** of the environment you are importing into, and the server's address
  ([credentials](cli.md#credentials-are-never-arguments)).

## Dry run

```sh
bun add -d @tula-tech/cli@latest
bunx tula import --from better-auth ba-user.csv --accounts ba-account.csv
```

The report lists every refused row with its number, a code, a masked address and the reason.
Without `--accounts` no password is carried and the report says so. Nothing is sent, and no key is
needed. Then:

```sh
export TULA_API_URL=https://auth.example.com
export TULA_SECRET_KEY=tula_sk_prod_…
bunx tula import --from better-auth ba-user.csv --accounts ba-account.csv --allow-passwordless --yes
```

If the run stops, run **the same command** again: it continues from
`ba-user.csv.tula-import-progress.json`, a file of row numbers, counts, codes and ids with no
address and no hash.

## What is carried over

| better-auth | Tula |
| --- | --- |
| `email`, `emailVerified` | `email`, `emailVerified` |
| `name` | `name` |
| `id` | `externalId` (stored, not yet returned by the user routes) |
| `username`, `role` | `metadata.betterAuth` (stored, not yet returned) |
| a credential `password` that is bcrypt (`$2a$`, `$2b$`, `$2y$`) or argon2 (`$argon2id$`, `$argon2i$`) | the password; the first sign-in replaces it with argon2id |

## What is refused, and what is not carried

- **scrypt passwords** (better-auth's `salt:key` hex form): refused with
  `import.unsupported_algorithm`, or imported without a password with `--allow-passwordless`.
- **Banned users** (`banned: true`) are refused with `source.user_disabled`.
- **Users with no email address** are refused with `email.invalid`.
- **Social accounts, two-factor secrets, passkeys and sessions are not carried over.** Set up the
  providers in Tula; [OAuth](methods/oauth.md) says how a provider sign-in meets an account that
  exists.

## After the import

Users imported without a password sign in another way you have switched on (an
[emailed code](methods/email-code.md), for example) or reset the password
([password reset](methods/password.md)). Tell them before you switch, since the reset email is
the only way back for someone who signs in with a password.
