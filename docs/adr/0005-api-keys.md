# ADR 0005 — API keys

- Status: accepted
- Date: 2026-09-30

## Context

Each environment needs a public identifier for apps (publishable key) and a credential for
servers and the dashboard (secret key). Resolving a key is what determines the tenant, so key
lookup has to run before any environment is known.

## Decision

- **Format** `tula_{pk|sk}_{dev|prod}_<256 random bits, base64url>`. The prefix tells a human (and
  secret scanners) what a key is and where it belongs.
- **Stored as SHA-256 only.** Keys are high-entropy, so a plain hash is enough; lookup is by hash.
  The full key is returned once, with `Cache-Control: no-store`.
- **`api_keys` has no row-level security,** because the lookup precedes the tenant. Every other
  query on the table filters by `environment_id` explicitly, and tests prove a key from one
  environment cannot list or revoke another's.
- **One generic error.** Missing, malformed, unknown, wrong-kind and revoked keys all return
  `auth.invalid_key`, so responses reveal nothing about which keys exist.
- **Guard rails:** a key cannot revoke itself (rotate by creating a new key first), at most 100
  active keys per environment, a per-IP rate limit ahead of key resolution, and `last_used_at`
  recorded at most once a minute.
- **Bootstrap** of the first secret key is a CLI (`bun run api-key:create`) that calls the same
  service function as the API.

## Consequences

- Secret keys are per environment, so a development key can never touch production data.
- Project-level credentials for the dashboard (managing several environments at once) are a
  Phase 1 decision.
