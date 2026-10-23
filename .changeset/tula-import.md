---
"@tula-tech/cli": minor
---

`tula import --from clerk|auth0|firebase|supabase|better-auth <export file>` moves users, with their password hashes, from another provider. It reads the provider's export on your machine (no request to the old provider), prints a dry-run report (counts, and every refused row by number, code and masked address) and, with `--yes`, imports in batches of up to 500 users and 4 MB through `POST /v1/admin/users/import`, waiting out the rate limit. A progress file of row numbers, counts, codes and ids (no address, hash or signer key) lets an interrupted run continue; users that exist are skipped. Clerk organizations and memberships are imported through the organization admin routes. better-auth's scrypt hashes, which the server does not read, are refused with a reason (or imported without a password with `--allow-passwordless`). One migration guide per provider is in the docs.
