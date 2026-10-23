# Migrating from Firebase Authentication

`tula import --from firebase` reads the export of `firebase auth:export` and the project's hash
parameters on your machine, shows what it would do, and imports the users with their
Firebase scrypt hashes, so nobody resets a password. The command makes **no request to
Firebase**. How the import works, and what the server checks, is in
[Importing users](user-import.md#firebase-authentication); every option is in
[the CLI page](cli.md#tula-import).

## What you need

- **The user export.** With the Firebase CLI:

  ```sh
  firebase auth:export firebase-users.json --format=JSON --project <project-id>
  ```

  Each user has `localId`, `email`, `emailVerified`, `passwordHash`, `salt`, `displayName`,
  `disabled` and `customAttributes`. Firebase writes `passwordHash` and `salt` in URL-safe base64;
  the command converts them to the alphabet the server reads.
- **The project's hash parameters.** In the Firebase console, **Authentication, Users, the menu
  at the top of the list, Password hash parameters**. They are four values, the same for every user
  of the project: `base64_signer_key`, `base64_salt_separator`, `rounds` and `mem_cost`. Save
  what the console shows to a file, as it is shown (`hash_config { … }`) or as JSON with the same
  four names.
- **A secret key** of the environment you are importing into, and the server's address
  ([credentials](cli.md#credentials-are-never-arguments)).

The console's screens change; the formats above are what the command reads.

## Dry run

```sh
bun add -d @tula-tech/cli@latest
bunx tula import --from firebase firebase-users.json --firebase-hash-config firebase-hash-config.txt
```

The report counts the users by password algorithm and lists every refused row with its number, a
code and a masked address. Nothing is sent, and no key is needed. Then:

```sh
export TULA_API_URL=https://auth.example.com
export TULA_SECRET_KEY=tula_sk_prod_…
bunx tula import --from firebase firebase-users.json \
  --firebase-hash-config firebase-hash-config.txt --yes
```

If the run stops, run **the same command** again: it continues from
`firebase-users.json.tula-import-progress.json`, a file of row numbers, counts, codes and ids with
no address, no hash and no signer key.

## The hash parameters are a secret

The signer key is a secret of your Firebase project. The command never takes it as an option:

- It is read from the file you name with `--firebase-hash-config`; or
- from the environment, `TULA_FIREBASE_SIGNER_KEY` (and `TULA_FIREBASE_SALT_SEPARATOR`), with
  `--firebase-rounds` and `--firebase-mem-cost` for the two numbers.

It is registered for redaction before anything is printed, so an error that quotes it shows
`[redacted]`; it is never written to the progress file; and it is sent to your Tula server once
per batch that has a Firebase user in it. The server seals it with its master key, bound to the
user it is kept for, and the user's first sign-in removes it. Keep the file out of version
control and delete it when the import is done. See
[the server's side](user-import.md#firebase-authentication).

## What is carried over

| Firebase | Tula |
| --- | --- |
| `email`, `emailVerified` | `email`, `emailVerified` |
| `displayName` | `name` |
| `localId` | `externalId` (stored, not yet returned by the user routes) |
| `customAttributes` | `metadata.firebase` (stored, not yet returned), left out if it would pass 4 KiB |
| `passwordHash` and `salt` | the password, as `firebase_scrypt`; the first sign-in replaces it with argon2id |

## What is refused, and what is not carried

- **Disabled users** (`disabled: true`) are refused with `source.user_disabled`: importing them would
  make the account usable again.
- **Users with no email address** (phone and anonymous users) are refused with `email.invalid`.
- **A user with a `passwordHash` and no `salt`** is refused with `import.hash_malformed`.
- **Parameters the server does not accept** (a `mem_cost` outside 12 to 16, `rounds` outside 4 to
  16, or more than 64 MiB of scrypt memory) refuse each Firebase row with
  `import.hash_parameters_too_weak` or `import.hash_parameters_too_costly`.
- **Users who sign in with Google, Apple and the other providers** are imported without a password
  and sign in the way they did once the provider is set up in Tula
  ([OAuth](methods/oauth.md)). Their linked accounts are not carried over.
- **Without the parameters** the command stops before it reads further, naming the option, unless
  you pass `--allow-passwordless`, which imports those users without a password.
- **Sessions and multi-factor enrolments are not carried over.**

## After the import

Keep Firebase running until your users have signed in once: a user who signs in with the old
password gets a Tula argon2id hash in the same sign-in. See
[what the first sign-in does](user-import.md#what-the-first-sign-in-does).
