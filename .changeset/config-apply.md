---
'@tula/admin': minor
'@tula/config': minor
'@tula/cli': minor
'@tula/contract': minor
---

Settings as code (ADR 0030): `tula.config.ts`, `tula diff` and `tula apply`.

- `@tula/admin` (new): a typed client for every `/v1/admin/*` operation, generated from the
  OpenAPI contract. `createAdminClient({ baseUrl, secretKey })`, one `call(operationId, input)`
  function, one error class (`TulaAdminError`) carrying the contract's code, field errors and
  `Retry-After`. Server-side only: it refuses a publishable key, refuses to be created in a
  browser, and its `browser` export condition resolves to a module that throws.
- `@tula/config` (new): `defineConfig()` for `tula.config.ts`, validated with the contract's
  schemas. One file describes several environments: the settings document and the OAuth
  providers of each. A provider's secret is `env('NAME')` and nothing else; a literal is a type
  error and a load error. `loadConfig()`, `selectEnvironment()`, `hashEnvironmentConfig()`.
- `@tula/cli` (new): the `tula` executable. `tula diff` prints what would change and exits 2
  when something would; `tula apply` asks, then replaces the settings under `If-Match` and
  creates, updates or (with `--prune`) deletes providers, in an order the server accepts.
- `@tula/contract`: `settingsWeakenings()` (the one definition of "weakened", now shared by
  the server's audit entry and the CLI's warning), `SettingsManagedBySchema`, and the headers
  `x-tula-managed-by` / `x-tula-config-hash` with which a replace records the tool and config
  that manage an environment's settings. `GET /v1/admin/settings` answers `managedBy`
  (additive; `null` when nobody manages them), with `drifted` once they are changed around
  the file.
