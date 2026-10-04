---
'@tula/core': patch
'@tula/react': patch
'@tula/nextjs': patch
'@tula/cli': patch
---

Fixes from the whole-phase review of the client SDKs and the CLI.

- `@tula/nextjs`: `safeRedirectPath` checks the path it returns, not only the value it was
  given. `/.//host`, `/..//host`, `/a/..//host` and `/%2e//host` were normalised by the URL
  parser to `//host` and returned, which a router reads as another origin (an open redirect
  through `redirect_url`). A path that starts with an encoded slash or backslash (`/%2f`,
  `/%5c`) is refused too.
- `@tula/react`: `safeUrl` and `go()` refuse a destination with no scheme that names a host
  (`//host`, `/\host`, a path that normalises to one). A relative destination means this
  origin; another site is written with its scheme.
- `@tula/react`: a failed sign-out is no longer shown as a sign-out. `<UserButton>` and
  `<UserProfile>` swallowed the error `@tula/core` throws when the server could not be told
  and went to `afterSignOutUrl`; behind `@tula/nextjs` the cookies were still there and the
  next request was signed in again. They now navigate only after a sign-out that went
  through; otherwise the provider shows a dialog (an alert) saying the session may still be
  active on this device, with "Try again". New strings: `signOutFailed.title`, `.message`,
  `.retry`, `.close`. `useTulaContext()` gains `signOut(redirectUrl?)`.
- `@tula/nextjs`: the server-side session refresh waits at most 8 seconds (it used the
  general 15-second timeout, longer than the 10-second floor of the refresh reuse grace
  window) and, like the browser's client, repeats once, at once, a refresh that got no answer;
  an HTTP answer is never repeated. `timeoutSeconds` smaller than 8 still applies.
- `@tula/nextjs`: `auth()` and `currentUser()` read the `__Host-` cookie names when the
  request carries one of them and neither `TULA_APP_URL` nor `X-Forwarded-Proto` says the
  scheme. Before, an app served over https without either was signed in for the middleware
  and signed out in every Server Component. Setting `TULA_APP_URL` remains the recommended way.
- `@tula/core`: `discard()` ends an attempt, and every flow has it (sign-up and password reset
  gain it). The attempt's secret is forgotten, later actions throw `flow.invalid_step`, and
  the answer to an action still in flight is dropped: it can no longer sign the client in
  through an attempt the user left. **Changed:** a `SignInFlow` could be waited on again
  after `discard()`; it now refuses with `flow.invalid_step`. To stop waiting and go on with
  the same attempt, abort the wait's `signal` instead.
- `@tula/core`: on a client that holds its own refresh token (every kind but `web`), a
  `signOut()` that could not reach the server can be repeated. The token had already been
  dropped, so a second call sent nothing and resolved while the session lived on. It is now
  kept in memory only (never storage) until a sign-out is delivered, the API says the session
  is over, or a new session is adopted. The client is signed out throughout.
- `@tula/react`: when a provider dialog closes and the control that opened it is gone (the
  "Sign out" item after a failed sign-out, a sign-in form after an enrolment), focus moves to
  the page's first focusable control instead of being left on the document. The
  failed-sign-out dialog also closes when the provider is given another `client`.
- `@tula/cli`: `tula dev` refuses anything at `.env.local` that is not a regular file (a
  named pipe there made it wait for ever).
- `@tula/cli`: `tula dev` writes `.env.local` through a temporary file created exclusively
  under a random name (it was the guessable `.env.local.<pid>.tmp`, written through a
  symbolic link if one was planted there), and refuses a symbolic link at `.env.local`
  instead of writing or changing a mode through it.
- `@tula/cli`: `tula doctor` also removes bidi overrides, zero-width characters, private-use
  and unassigned code points from text the server sent before printing it.
