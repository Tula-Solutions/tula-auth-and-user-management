---
'@tula/expo': minor
---

An emailed sign-in link opened in an Expo app ([docs/expo.md](../docs/expo.md#the-emailed-link),
ADR 0055). **No emailed link has opened an app through this package, on a phone or in a
simulator**: it is tested against the real API in process, with the URL handed over as an
operating system would hand it (`docs/plans/phase-2-unverified.md`).

- `createTulaExpoClient({ emailLinkUrl })`: the one `https` app link the app's emailed
  links lead to, with no query, fragment, user name, backslash or white space. Not a
  custom scheme. Without the option nothing changes: asking for a
  link is `storage.failed` before any request, and a step that offers only a link is the
  screen `not_supported`.
- `useSignIn()`: `prepareFirstFactor({ strategy: 'email_link' })`, `openEmailLink(url)`
  for every URL the app is opened with, and `finishEmailLink()`. Without the hooks:
  `requestEmailLink`, `openEmailLink`, `isEmailLink`, and the type `EmailLinkOutcome`.
- A URL is sent to the server only when it is `emailLinkUrl`, character for character,
  followed by a link of the sign-in that asked, while the client still keeps that link's
  binding. Anything else is refused without a request and uses nothing up.
- A link whose request got no answer (`network.failed`, `network.timeout`) may have been
  taken all the same, and the same URL is then `verification.expired`. Nothing is asked on
  a guess: `finishEmailLink()` is what to try after either, and it changes nothing where
  the link was not taken.
- The binding is kept in memory only, for fifteen minutes at most: never in the secure
  store, a file, a log line, an error or a URL. **A link opened after the app was ended
  and started again signs nobody in**: the user asks again. The code in the same email
  works on any device.
- `flowScreen` counts `email_link` as a way for a client that has `emailLinkUrl`
  (`FlowWays.emailLink`).

The server and `@tula/core` are unchanged.
