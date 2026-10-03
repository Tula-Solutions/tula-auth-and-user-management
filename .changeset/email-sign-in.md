---
'@tula/contract': minor
'@tula/core': minor
'@tula/react': minor
---

Signing in by email: a 6-digit code, a link that works only in the browser that asked for it,
and sign-up without a password.

- `@tula/contract`: `EnvironmentSettings` gains `signIn.methods.emailCode` and
  `signIn.methods.emailLink` (both off by default; `emailLink` needs `emailCode`) and
  `signUp.password` (`required` by default, or `optional`, which needs `emailCode`).
  `ClientConfig` gains `signUp.password`. The `needs_first_factor` step gains an optional
  `prepared: { strategy, destination }`, `FlowAttempt` an optional `linkBinding`, and
  `SignUpRequest.password` becomes optional. New request shapes `FirstFactorPrepareRequest`,
  `FirstFactorAttemptRequest`, `EmailLinkRequest` and `EmailLinkResult`; new error codes
  `verification.different_browser` (409) and `request.redirect_not_allowed` (400); and
  `EMAIL_LINK_TOKEN_PARAM` / `EMAIL_LINK_ATTEMPT_PARAM` in the Zod-free `/headers` entry point.
  All additive: documents saved earlier read with the new methods off.
- `@tula/core`: sign-in flows gain `prepareFirstFactor`, `attemptFirstFactor`,
  `waitForEmailLink` (polling with cancellation, nudged across tabs, obeys `Retry-After`) and
  `discard`; `signIn.canUseEmailLink()` and `signIn.handleEmailLink()` for the page a link
  leads to; `signUp.start` takes an optional password. An emailed link's binding is kept in
  `localStorage` (it is not a token; see the README's security notes), and the link's token is
  read from the URL fragment and removed from the address before anything is sent.
- `@tula/react`: `<SignIn>` draws the emailed code and link and lets the user switch between
  the methods on offer (new prop `emailLinkUrl`, also on the provider); `<SignUp>` marks the
  password optional where the environment says so; new `<EmailLinkCallback>` and
  `useEmailLinkCallback()` for the landing page; `useSignIn` gains the matching actions. New
  element names `alternatives` and `waiting`, and new localization keys under `signIn`,
  `signUp` and `emailLink`.
