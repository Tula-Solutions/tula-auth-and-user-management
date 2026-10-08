---
'@tula/contract': minor
'@tula/core': minor
---

Session profiles, the stateful session type and session rules (ADR 0028).

- `@tula/contract`: `sessions` in the environment settings (`SessionSettings`): named
  `profiles` (`web` and `mobile` always; `SessionProfile` now has `type`, `accessTokenTtl`,
  `idleTimeout`, `absoluteTimeout`, `refresh.reuseGracePeriod`, `stepUpAfter`,
  `clientSelectable`, with documented bounds; `accessTokenTtl` may not be longer than
  `idleTimeout`), `maxPerUser` and `onLimit`. Helpers
  `resolveSessionProfile`, `profileOfSession`, `builtInSessionProfile`, `stepUpWindowSeconds`.
  New: the `x-tula-session-profile` header (`SESSION_PROFILE_HEADER`), the error code
  `session.limit_reached`, the access-token claim `sp`, `VerifySessionRequest`
  (`POST /v1/admin/sessions/verify`), `HybridSessionTokens`.
  **Breaking:** `SessionTokens.accessToken` and `accessTokenExpiresAt` are optional (absent
  for a session of a `stateful` profile); `SessionType` is now `hybrid | stateful`;
  `SessionProfile` lost `refresh.rotate`, `refresh.reuseDetection`, `multiSession` and
  `maxConcurrent` (never read by a server), and `IMPLEMENTED_SESSION_TYPES` is gone;
  `refresh.reuseGracePeriod` may be `null`.
- `@tula/core`: `createTulaClient({ sessionProfile })` asks for a profile. A browser client
  works against a `stateful` profile: it holds no token (`session.getToken()` returns `null`),
  authenticated calls rely on the httpOnly cookie, a refused call signs the client and its
  other tabs out at once, and sign-out is unchanged. `session.limit_reached` has a message.
