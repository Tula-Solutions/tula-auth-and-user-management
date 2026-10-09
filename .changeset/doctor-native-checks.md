---
'@tula/contract': patch
---

`tula doctor` checks an environment's native apps
([ADR 0040](../docs/adr/0040-native-app-identity.md#what-tula-doctor-checks-added-2026-10-09-tula-35),
[docs/cli.md](../docs/cli.md#tula-doctor)). The server's diagnostics answer three more
checks: `native_app_identities` (every registered app is well formed),
`native_app_files` (the association files name exactly the registered apps, and the server's
own `PUBLIC_URL` serves them) and `native_app_passkeys` (the passkey relying party is a
domain an app can be associated with). With no app registered they are `skipped`.

**`@tula/contract`**: the OpenAPI document's description of `getInstanceDiagnostics` names
them. No schema changed: a check's `id` was and is a string.

`@tula/cli` and `@tula/mcp` print whatever checks the server answers and are unchanged. The
server never requests an operator's own domain: whether Apple or Android can reach the files
there is not checked, and the checks' text says so.
