---
paths:
  - "packages/core/**"
  - "packages/nextjs/**"
  - "packages/expo/**"
---

# SDK rules

- SDKs hold **no auth logic** beyond rendering flow steps, storing tokens and refreshing. Flow
  decisions come from the server (`FlowStep` in `@tula/contract`).
- Every public export is part of the semver surface: JSDoc with `@example`, no breaking changes
  without a major changeset.
- Token refresh is **single-flight**: concurrent requests hitting an expired token share one
  refresh, in one client and (through a Web Lock and a `BroadcastChannel`) across tabs. Every
  change to `packages/core/src/session.ts` needs a test for the interleaving it touches:
  refresh racing sign-out, a refused refresh with waiters, another tab's message arriving
  mid-refresh. A result that arrives for an older session generation is never installed.
- A refused refresh (`session.*`, `auth.unauthenticated`, `auth.user_banned`) ends the session
  once: no retry, one notification. Any other failure keeps the session and is never retried
  automatically; honour `Retry-After` by failing fast, not by sleeping.
- Storage: httpOnly cookies on web (SDK never reads the refresh token), Keychain/Keystore on
  native, memory otherwise. Never `localStorage` or `sessionStorage` for any token or for an
  attempt's secret, and never a token, secret or password in an error, a log line or a
  `toJSON`.
- One error class: every failed call throws `TulaError` with a contract code or one of the
  client's own (`network.failed`, `network.timeout`, `response.invalid`, `storage.failed`).
- Types come from `src/generated/api.gen.ts` (run `bun run core:generate` after
  `contract:generate`); run-time imports from the contract use its Zod-free entry points only.
  No `Buffer`, `process` or `node:` import: `typecheck:portable` must pass.
- Every conformance scenario is covered by a journey in `apps/api/src/sdk-journeys.test.ts` or
  listed there as server-only with a reason (the guard test enforces it). The JSON scenarios
  themselves are HTTP-level and are run by servers and native SDKs.
- Check browser behaviour in a browser: `bun run playground`.
