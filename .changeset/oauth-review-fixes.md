---
'@tula/core': minor
'@tula/react': minor
---

An OAuth sign-in is no longer lost when the ticket exchange gets no answer.

- `@tula/core`: when `signIn.handleOAuthCallback()` fails with `network.failed`,
  `network.timeout` or `rate_limited`, the round trip is kept (the binding in `sessionStorage`,
  the ticket in memory only, for 60 seconds) and calling it again retries the exchange. Any
  answer from the API, success or refusal, ends the round trip as before. New:
  `signIn.discardOAuthCallback()` to give up on a held round trip (sign-out and a new round trip
  do the same), and `isRetryableOAuthError(error)`.
- `@tula/react`: `useOAuthCallback()` returns `canRetry` and `retry()`, and `<OAuthCallback>`
  shows a "Try again" button after such a failure. New localization string `oauth.tryAgain`.
