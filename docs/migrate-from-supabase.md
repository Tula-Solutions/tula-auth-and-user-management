# Migrating from Supabase Auth

`tula import --from supabase` reads an export of Supabase's `auth.users` table on your machine,
shows what it would do, and imports the users with their bcrypt hashes, so nobody resets a
password. The command makes **no request to Supabase**. How the import works, and what the server
checks, is in [Importing users](user-import.md); every option is in
[the CLI page](cli.md#tula-import).

## What you need

- **An export of `auth.users`**, as CSV or JSON. In the dashboard's SQL editor, run a query for the
  columns the command reads and download the result:

  ```sql
  select id, email, encrypted_password, email_confirmed_at, raw_user_meta_data,
         raw_app_meta_data, banned_until, deleted_at, is_anonymous
  from auth.users;
  ```

  With `psql`, `\copy (select … from auth.users) to 'supabase-users.csv' csv header` does the same.
  The columns `raw_user_meta_data` and `raw_app_meta_data` hold JSON; in a CSV they are a quoted cell.
- **A secret key** of the environment you are importing into, and the server's address
  ([credentials](cli.md#credentials-are-never-arguments)).

Supabase's screens change; the columns above are what the command reads.

## Dry run

```sh
bun add -d @tula-tech/cli@latest
bunx tula import --from supabase supabase-users.csv
```

The report counts the users by password algorithm and lists every refused row with its number, a
code and a masked address. Nothing is sent, and no key is needed. Then:

```sh
export TULA_API_URL=https://auth.example.com
export TULA_SECRET_KEY=tula_sk_prod_…
bunx tula import --from supabase supabase-users.csv --yes
```

If the run stops, run **the same command** again: it continues from
`supabase-users.csv.tula-import-progress.json`, a file of row numbers, counts, codes and ids with
no address and no hash.

## What is carried over

| Supabase | Tula |
| --- | --- |
| `email` | `email`; it is `emailVerified` when `email_confirmed_at` is set |
| `raw_user_meta_data` `full_name`, else `name` | `name` |
| `id` | `externalId` (stored, not yet returned by the user routes) |
| `raw_user_meta_data`, `raw_app_meta_data` | `metadata.supabase` (stored, not yet returned), left out if it would pass 4 KiB |
| `encrypted_password` (bcrypt, `$2a$`) | the password; the first sign-in replaces it with argon2id |

A user with no `encrypted_password` (a magic-link or OAuth user) is imported without a password.

## What is refused, and what is not carried

- **Soft-deleted users** (`deleted_at` set) are refused with `source.user_deleted`.
- **Banned users** (`banned_until` in the future) are refused with `source.user_disabled`: importing
  them would make the account usable again.
- **Anonymous users and rows with no email** are refused with `email.invalid`.
- **A hash that is not bcrypt, argon2 or PBKDF2-SHA256** is refused with
  `import.unsupported_algorithm`, or with `--allow-passwordless` the user is imported without a
  password.
- **OAuth identities, phone numbers, MFA factors and sessions are not carried over.** Set the
  providers up in Tula; [OAuth](methods/oauth.md) says how a provider sign-in meets an account
  that exists.
- **Row-level policies and custom claims** are yours to rebuild; see [JWT templates](jwt-templates.md).

## After the import

Keep Supabase running until your users have signed in once: a user who signs in with the old
password gets a Tula argon2id hash in the same sign-in. See
[what the first sign-in does](user-import.md#what-the-first-sign-in-does).
