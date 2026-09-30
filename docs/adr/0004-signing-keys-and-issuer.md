# ADR 0004 — Access-token signing keys, issuer and JWKS

- Status: accepted
- Date: 2026-09-30

## Context

Access tokens are short-lived EdDSA JWTs (business plan §5.3) that any language must be able to
verify offline. That needs a public key set per environment, safe key rotation across several
API instances, and private keys that are useless if the database leaks.

## Decision

- **Issuer per environment.** `iss` is `<PUBLIC_URL>/v1/environments/<environment id>`
  (`environmentIssuer` in `@tula/contract`). The key set is served at `iss` +
  `/.well-known/jwks.json` (`jwksUrl`). Standard JWKS clients fetch a URL with no custom headers,
  so the environment has to be in the path. This also follows OIDC discovery conventions.
- **Ed25519 keys, encrypted at rest.** Each private key is sealed with AES-256-GCM (`lib/secret-box.ts`).
  The encryption key is derived per purpose from `TULA_MASTER_KEY` with HKDF-SHA256. The
  associated data binds each ciphertext to its key id and environment, so a ciphertext copied
  into another row fails to decrypt.
- **Lifecycle `next → active → retired`.** Partial unique indexes allow one `active` and one `next`
  key per environment, so instances racing to bootstrap or rotate lose cleanly instead of creating
  two signing keys. Rotation is one transaction of status-guarded updates.
- **Publish before use.** Rotation is refused until the `next` key has been published for
  10 minutes. That exceeds the JWKS `max-age` (300s) plus the per-instance verification-key cache
  (60s), so every verifier has seen a key before it signs anything. Retired keys stay published
  for twice the access-token TTL.
- **Bootstrap** at boot for every environment, on the first JWKS read, and on first signing. An
  empty key set is never cached.

## Consequences

- `sessionAuth` verifies tokens with cached public keys and no database hit.
- Rotation is manual (`POST /v1/admin/signing-keys/rotate`) until scheduled rotation lands.
- Changing or losing `TULA_MASTER_KEY` makes stored signing keys unreadable. A boot-time
  decryption check is planned with the session module.
- Custom domains per environment (Phase 1+) will change `PUBLIC_URL` per environment; the issuer
  format already accommodates that.
