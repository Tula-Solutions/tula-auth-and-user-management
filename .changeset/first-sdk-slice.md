---
'@tula/contract': minor
'@tula/core': minor
---

First prerelease of the contract and the headless client.

- `@tula/contract`: the API's schemas, flow protocol, error codes, token claims and password
  policy, with Zod-free entry points (`/error-codes`, `/headers`, `/password-rules`) for clients.
- `@tula/core`: `createTulaClient` with server-driven sign-up, sign-in and password-reset flows,
  session management with single-flight token refresh, and typed errors.
