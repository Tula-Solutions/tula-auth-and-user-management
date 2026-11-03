# Migrating from Clerk

`tula import --from clerk` reads Clerk's user export on your machine, shows what it would do,
and imports the users with their password hashes, so nobody resets a password. It can also
import Clerk's organizations and their members. The command makes **no request to Clerk**: you
export the files, the command reads them. How the import works, and what the server checks, is
in [Importing users](user-import.md); every option of the command is in [the CLI page](cli.md#tula-import).

## What you need

- **The user export.** In the Clerk dashboard, export the users as CSV (or fetch them as JSON
  from the Backend API). The CSV has `id`, `first_name`, `last_name`, `username`,
  `primary_email_address`, `verified_email_addresses`, `password_digest`, `password_hasher` and
  `totp_secret`, among others. A JSON file is read too: an array, or `{ "data": [ … ] }`, with
  the Backend API's `email_addresses` and `public_metadata`.
- **A secret key** of the environment you are importing into, and the server's address, as for
  every `tula` command ([credentials](cli.md#credentials-are-never-arguments)).
- **For organizations**, switch them on in the environment first (`organizations.enabled`,
  [ADR 0065](adr/0065-organizations.md)).

Clerk's screens change; if a column or a menu is not where this page says, the formats above are
what the command reads.

## Dry run

```sh
bun add -d @tula-tech/cli@latest
bunx tula import --from clerk clerk-users.csv
```

The report counts the users it would import, by password algorithm, and lists every row it would
refuse with its number, a code and a masked address (`m***@***.app`). Nothing is sent, and no key
is needed. Fix what you can in the export, or accept the refusals, then:

```sh
export TULA_API_URL=https://auth.example.com
export TULA_SECRET_KEY=tula_sk_prod_…
bunx tula import --from clerk clerk-users.csv --yes
```

If the run stops (a network failure, `Ctrl-C`), run **the same command** again: it continues
from its progress file, `clerk-users.csv.tula-import-progress.json`. The file holds row numbers,
counts, codes and ids, never an address or a hash, and it can be deleted when you are done.

## What is carried over

| Clerk | Tula |
| --- | --- |
| `primary_email_address` | `email`; it is `emailVerified` only when it is in `verified_email_addresses` |
| `first_name`, `last_name` | `name` |
| `id` | `externalId` (stored, not yet returned by the user routes) |
| `username`, public, private and unsafe metadata | `metadata.clerk` (stored, not yet returned), left out if it would pass 4 KiB |
| `password_digest` with `password_hasher` `bcrypt`, `argon2id`, `argon2i`, `pbkdf2_sha256` | the password; the first sign-in replaces it with argon2id |

## What is refused, and what is not carried

- **Other hashers** (`md5`, `sha256`, `scrypt`, `phpass`, LDAP and the rest) are refused with
  `import.unsupported_algorithm`. A user from a Firebase project that you moved into Clerk
  (`scrypt_firebase`) needs the Firebase parameters, which Clerk's export does not have: import them
  from the [Firebase export](migrate-from-firebase.md). With `--allow-passwordless` a row
  whose hash cannot be read is imported without a password instead, and the user resets it.
- **Banned and locked users** (in a JSON export) are refused with `source.user_disabled`: importing them
  would make the account usable again.
- **Rows with no email address** are refused with `email.invalid`.
- **Two-step verification is not carried over.** The report says how many users had an
  authenticator app; they enrol again.
- **Sessions are not carried over.** Everyone signs in once.

## Organizations and memberships

Clerk's dashboard does not export them; the Backend API lists them. With a Clerk secret key
(your own commands, not this tool's), save the organizations and each organization's members:

```sh
curl -s -H "Authorization: Bearer $CLERK_SECRET_KEY" \
  "https://api.clerk.com/v1/organizations?limit=100" > clerk-organizations.json
for id in $(jq -r '.data[].id' clerk-organizations.json); do
  curl -s -H "Authorization: Bearer $CLERK_SECRET_KEY" \
    "https://api.clerk.com/v1/organizations/$id/memberships?limit=100"
done | jq -s '{ data: [ .[].data[] ] }' > clerk-memberships.json
```

Page with `offset` if you have more than 100 of either. Then:

```sh
bun add -d @tula-tech/cli@latest
bunx tula import --from clerk clerk-users.csv \
  --organizations clerk-organizations.json --memberships clerk-memberships.json --yes
```

The users are imported first, then the organizations, then the members:

- An organization is its **slug** (Clerk's, made lower case with single hyphens, at most 48
  characters). One that exists already is used as it is, so a second run creates nothing twice.
- A member is found by the user's address in the users file, or by the id of the user created in
  this run. The Clerk role `org:admin` becomes `admin`, and `org:member` becomes `member`; any
  other `org:<key>` becomes the role `<key>`, which must exist in the environment
  ([custom roles](adr/0065-organizations.md)). A role that does not exist makes that
  membership fail with `organization.role_unknown`, and the report lists it.
- A user who was refused is not a member of anything, and the membership is reported.

## After the import

Run the dry run's refusals past your list, point your app at Tula, and keep Clerk running until
your users have signed in once: a user who signs in with the old password gets a Tula
argon2id hash in the same sign-in. See [what the first sign-in does](user-import.md#what-the-first-sign-in-does).
