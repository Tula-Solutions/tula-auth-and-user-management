---
'@tula/contract': minor
'@tula/nextjs': minor
'@tula/admin': minor
'@tula/config': minor
'@tula/cli': minor
---

JWT templates: an environment can add custom claims to its sessions
([docs/jwt-templates.md](../docs/jwt-templates.md), ADR 0036). A template is a named set of
claims under `sessions.jwtTemplates`, each read from a closed list of sources (the user's
address, whether it is verified, when the account and the session began, the client kind) or a
constant; a session profile names the one it uses (`jwtTemplate`). The claims are issued under
the one claim `ext` of the access token, and in what the server answers for a stateful
session. A token of a profile without a template is unchanged.

- `@tula/contract`: `JwtTemplateSchema`, `JwtTemplateClaimSchema`, `JWT_TEMPLATE_SOURCES`,
  `jwtTemplateMaxBytes`, `readStoredJwtTemplate`, `jwtTemplateOfProfile`, the optional `ext`
  on `AccessTokenClaimsSchema`, and `settingsWeakenings` reports
  `sessions.profiles.<name>.jwtTemplate` when a profile's sessions lose a claim or get a
  redefined one. A new Zod-free entry point, `@tula/contract/custom-claims`:
  `CUSTOM_CLAIMS_CLAIM`, `RESERVED_CLAIM_NAMES`, the caps (`MAX_CUSTOM_CLAIMS_BYTES` and
  others), `isCustomClaimKey`, `isCustomClaimValue`, `customClaimsBytes` and
  `readCustomClaims`.
- `@tula/nextjs`: `auth()` returns `customClaims` (a read-only record of `unknown` values;
  empty when signed in with none, `null` when signed out), for token and stateful sessions
  alike, and `SessionClaims` gains the optional `ext`. An `ext` that is not what Tula issues
  is treated as absent.
- `@tula/admin`: the settings types carry `jwtTemplates` and a profile's `jwtTemplate`.
- `@tula/config`: both are part of `settings`. An environment without templates keeps the
  fingerprint it had.
- `@tula/cli`: `tula diff` compares templates by name and their claims by key, shows a changed
  claim as one value, and reports a profile whose sessions would lose claims as weaker, which
  `tula apply --yes` refuses without `--allow-weaker`.
