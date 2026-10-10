---
'@tula/contract': patch
---

`tula doctor` checks an environment's native apps
([ADR 0040](../docs/adr/0040-native-app-identity.md#what-tula-doctor-checks-added-2026-10-09-tula-35),
[docs/cli.md](../docs/cli.md#tula-doctor)). The server's diagnostics answer three more
checks: `native_app_identities` (every registered app is well formed),
`native_app_files` (the association files name exactly the registered apps, and the server's
own `PUBLIC_URL` serves them) and `native_app_passkeys` (the passkey relying party is a
domain an app can be associated with). With no app registered they are `skipped`. Apps
registered where passkeys are off is `ok` and said (the files serve saved passwords too).

**Breaking for a deployment, not for a package**: the server now refuses to start when
`PUBLIC_URL` holds a user name, a password, a query or a fragment. It is the issuer of every
access token and the address the server requests to check itself, where the credentials
would be sent as basic authentication. Remove them from the value.

**`@tula/contract`**: the OpenAPI document's description of `getInstanceDiagnostics` names
them. No schema changed: a check's `id` was and is a string.

`@tula/cli` and `@tula/mcp` print whatever checks the server answers and are unchanged. The
server never requests an operator's own domain: whether Apple or Android can reach the files
there is not checked, and the checks' text says so.
