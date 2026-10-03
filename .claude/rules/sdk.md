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
  once: no retry, one notification. Any other failure keeps the session. The only automatic
  retry in the SDK is one immediate repeat of a refresh that got no answer (`network.timeout`,
  `network.failed`), inside the single flight and inside `REFRESH_RETRY_WINDOW_MS`; an HTTP
  answer of any status is never retried. Honour `Retry-After` by failing fast, not by sleeping.
- Storage: httpOnly cookies on web (SDK never reads the refresh token), Keychain/Keystore on
  native, memory otherwise. Never `localStorage` or `sessionStorage` for any token or for an
  attempt's secret, and never a token, secret or password in an error, a log line or a
  `toJSON`.
- A signed-out client stays signed out: no late 401, in-flight refresh or other tab's message
  about an ended session may sign it back in. A 200 is validated (hand-written guards) before
  tokens or a flow are built from it. Look server-supplied keys up with `ownString` /
  `Object.hasOwn`, never by plain indexing.
- The refresh request's timeout (`REFRESH_TIMEOUT_MS`) must stay below the default
  `refresh.reuseGracePeriod` in `packages/contract/src/session-profile.ts`; a test holds it.
- One error class: every failed call throws `TulaError` with a contract code or one of the
  client's own (`network.failed`, `network.timeout`, `response.invalid`, `storage.failed`,
  `flow.busy`), all `status: 0`.
- Types come from `src/generated/api.gen.ts` (run `bun run core:generate` after
  `contract:generate`); run-time imports from the contract use its Zod-free entry points only.
  No `Buffer`, `process` or `node:` import: `typecheck:portable` must pass.
- Every conformance scenario is covered by a journey in `apps/api/src/sdk-journeys.test.ts` or
  listed there as server-only with a reason (the guard test enforces it). The JSON scenarios
  themselves are HTTP-level and are run by servers and native SDKs.
- Check browser behaviour in a browser: `bun run playground`.
