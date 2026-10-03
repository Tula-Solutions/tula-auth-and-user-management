# ADR 0006 — Password hashing, policy and breach checks

- Status: accepted
- Date: 2026-09-30

## Context

Passwords are the Phase 0 credential. We need storage that resists offline cracking, rules that
web, iOS and Android enforce identically, a breached-password check that doesn't leak the
password, and sign-in that doesn't reveal which accounts exist.

## Decision

- **argon2id via `Bun.password`, parameters pinned** in `HASH_OPTIONS` (64 MiB, 2 passes, above
  OWASP's 19 MiB / 2 minimum) so a runtime upgrade can't change them silently. `needsRehash`
  flags hashes made with other parameters; sign-in rehashes them after a successful verify.
- **NFC normalization** before hashing, verifying, measuring and breach lookup, so the same
  passphrase typed on any platform matches.
- **Unknown users cost the same.** `verify(null, pw)` checks a constant dummy hash made with the
  same parameters (argon2 reads its cost from the hash, so a cheaper dummy would answer faster).
  It always returns false, so the dummy's password is not a secret.
- **Hard length cap** of 1024 code points on hash and verify, whatever the policy, so a
  multi-megabyte body can't be fed to argon2. Over-long input is rejected before normalizing or
  hashing; no stored password can be that long, so this reveals nothing about the account. The
  app also refuses request bodies over 64 KiB (`MAX_BODY_BYTES`).
- **One policy object, evaluated everywhere.** `evaluatePassword` in `@tula/contract` is pure;
  the server enforces it and SDKs fetch `GET /v1/client/password-policy` to render the same live
  checklist. Setting a password returns the first failed rule as `code` and every failed rule in
  `errors`, so simple clients show one message and rich ones show all.
- **Breach check behind a `BreachChecker` port.** Live tiers use Have I Been Pwned's range API
  (k-anonymity: only a 5-character SHA-1 prefix leaves the server, with `Add-Padding`); local and
  dev use the bundled common-password list with no network. The lookup runs only after the local
  rules pass, times out after 2 s, and **fails open**: an HIBP outage must not block every
  sign-up. The policy's `breachCheck` chooses `off`, `warn` (returned as a warning) or `block`.
- **Each environment has its own policy** (since Phase 1.2, [ADR 0018](0018-environment-settings.md)):
  the `password` section of its settings, changed with `PUT /v1/admin/settings`.
  `Passwords.policy(deps, tenant)` reads it, so sign-up, reset, change and the admin routes all
  enforce the environment's own rules, and two environments of one deployment can differ. The
  `PASSWORD_POLICY` preset (default `recommended`) is now only the default of an environment
  that has saved no settings. Phase 0 had that one policy for the whole deployment.

## Consequences

- Each hash or verify costs ~64 MiB for a moment, which is why the endpoints that hash are
  rate limited per IP, per identifier and per environment (ADR 0011).
- A weak hash is upgraded after a successful sign-in only if it is still the hash that was
  verified, so an upgrade can never overwrite a password changed in the same moment.
- Failing open means a password set during an HIBP outage may be breached; the policy check
  still applies, and a later change or reset is checked again.
- `password.*` codes are detailed on purpose, and are only returned when a password is being
  set. Sign-in always answers `auth.invalid_credentials`.
