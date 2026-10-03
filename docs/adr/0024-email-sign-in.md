# ADR 0024 — Signing in by email: codes, same-browser links, passwordless sign-up

- Status: accepted
- Date: 2026-10-03
- Builds on [ADR 0007](0007-verification-codes.md) (codes and link tokens),
  [ADR 0018](0018-environment-settings.md) (settings; first use of `urls.allowedRedirectUrls`),
  [ADR 0019](0019-flow-engine-v2.md) (bound attempts, first-factor choice),
  [ADR 0021](0021-core-sdk.md) and [ADR 0022](0022-react-sdk.md) (the SDKs).

## Context

Phase 1 step 1.7 adds the first sign-in methods beside the password: a 6-digit code sent by
email, a link in that email ("magic link"), and sign-up without a password. The engine was
prepared for them (ADR 0019): attempts are bound to a secret their starting client holds, a
sign-in start offers the strategies the environment enables, and a second factor stands between
any first factor and a session.

Three things had to be decided.

**What a click on an emailed link may do.** An attacker can start a sign-in for a victim's
address. The victim receives a genuine email from the app they use and may well click the link
in it. If that click completed the waiting attempt, the attacker's client (which holds the
attempt's secret) would be signed in as the victim. The phase plan's sketch ("opening the link
on another device completes the original tab") has exactly this hole: attempt binding decides
*who receives the session*, it does not decide *whether the click was made by the person who
asked*.

**Where a link's token travels.** A token in a URL reaches whatever sees the URL: the app's own
server and its logs, proxies, and other sites through `Referer`.

**What an unknown address is told.** As for sign-up and reset, nothing a caller can observe may
depend on whether the address has an account.

## Decision

### Settings

Additive, with defaults that keep an existing environment as it is:

- `signIn.methods.emailCode.enabled` and `signIn.methods.emailLink.enabled`, both `false`.
  "At least one method enabled" now counts every method, so the password can be switched off
  once the email code is on.
- **`emailLink` needs `emailCode`.** A link works only in the browser that asked for it (below);
  the code in the same email is the way in from any other device. A link without the code would
  strand those users, so the settings refuse the combination.
- `signUp.password`: `required` (default) or `optional`. `optional` needs `emailCode`, because
  an account without a password can only get in by email.
- `/v1/client/config` lists the enabled methods and `signUp.password`.
- `FIRST_FACTORS` (`modules/factor`) gains `email_code` and `email_link`. What a start offers
  still depends on the settings alone.

Switching a method on is not recorded as a weakening (`Settings.weakened`): an inbox already
resets a password. It is recorded, like every settings change, by key.

### Protocol

A sign-in start is unchanged: `needs_password` when the password is the only method,
`needs_first_factor { strategies }` otherwise. **The start sends nothing.** An email is asked
for explicitly, so a start still costs nothing and looks nothing up.

| Route | Authorized by | Does |
| --- | --- | --- |
| `POST /v1/client/sign-ins/:id/first-factor/prepare` `{ strategy, redirectUrl? }` | attempt secret | Emails the code (and, for `email_link`, the link). |
| `POST /v1/client/sign-ins/:id/first-factor/attempt` `{ strategy: 'email_code', code }` | attempt secret | Checks the code and completes. |
| `POST /v1/client/sign-ins/:id/first-factor/attempt` `{ strategy: 'email_link' }` | attempt secret | Completes if the link was accepted; otherwise answers the unchanged step. |
| `POST /v1/client/sign-ins/link` `{ token, attemptId, binding? }` | link token **and** binding | Accepts the link. Returns `{ status: 'verified' }`, never tokens. |

- **The step while waiting** is `needs_first_factor` with an added, optional
  `prepared: { strategy, destination }` (the masked identifier the attempt was started with, so
  it says nothing about an account). A dedicated step was considered and rejected: the user can
  still choose another offered strategy at this point (type the password after all), so the
  step *is* still "prove one of these"; and a client that does not know `prepared` keeps
  working. There is no "resend" route: asking again is `prepare` again.
- **Tokens** have a new purpose, `sign_in`, beside `email_verification` and `password_reset`.
  A token is looked up by purpose, so one issued for one purpose is never honoured for
  another. The column is plain `text` and the attempt's new fields live in its existing JSON
  state, so there is **no migration**; the retention job already deletes both.
- **The code** allows five guesses and ten minutes (ADR 0007). Every try is also counted
  against the per-identifier lockout **under the same key as password sign-in**
  (`CREDENTIAL_LOCKOUT`), so guessing codes and guessing passwords share one budget; it is
  cleared on success. Per-IP limits and the environment ceiling apply as on every credential
  step. `prepare` is limited like every email: one a minute and five an hour per address.
- **After the factor**: the ban check, `Factors.requiredFor` (a user with a second factor gets
  `needs_second_factor` and no tokens), the "new sign-in" notice (through `finish`), and the
  address is marked verified with its audit entry: the email is the proof, so an email sign-in
  never detours through `needs_email_verification`. The proof is spent only after the second
  factors were read, so a failure there leaves it usable, and of two requests holding the same
  code exactly one signs in.
- **A user without a password** where only the password is offered still gets the generic
  `auth.invalid_credentials`.

### An unknown address

`prepare` looks the address up only to decide what to send. An address with no account is sent
a notice ("someone asked to sign in … there is no account") instead: **no code and no link**.
Its attempt stores a decoy token whose code nobody knows. The response (including a
`linkBinding` for `email_link`), the send limits, the ceiling and the cost of one email are the
same; a wrong guess answers the same; a "right" guess of the decoy answers like a wrong one;
and waiting for a link looks the same for ever. A banned user is sent a code like anyone else
and learns of the ban only after the factor.

### The link works only in the browser that asked for it

- `prepare` with `email_link` returns, **once**, a `linkBinding`: 256 random bits (prefixed
  `tula_lb_`). Only its SHA-256 is kept, on the attempt.
- The email's link is the `redirectUrl` followed by
  `#tula_link=<token>&tula_attempt=<attempt id>`.
- The page the link leads to posts the token, the attempt id and the binding **its own
  browser** holds to `sign-ins/link`. The server checks the token (single use, ten minutes,
  256 bits, newest only, purpose `sign_in`, issued for exactly that attempt) and compares the
  binding's hash in constant time.
  - A dead token, or one for another attempt: `verification.expired`.
  - A good token **without the matching binding**: `verification.different_browser` (409), and
    **nothing is used up**. The link still works in the browser that asked, and so does the
    code. This is the victim's click on the attacker's link: their browser never received the
    attacker's binding, so the click proves nothing and the attacker's attempt waits for ever.
    It is also the honest user reading mail on a phone: the page tells them to open the link
    where they started or to type the code there.
  - A good token with its binding: the token is spent (which ends the code too) and the
    attempt is marked proven. **No session is created and no tokens are returned.**
- **Who gets the session:** only a caller holding the attempt's secret. The tab that started
  the sign-in asks `first-factor/attempt { strategy: 'email_link' }` and completes when the
  link was accepted. Until then the answer is the unchanged step: one read, no guess counted,
  no ceiling charged, identical for a decoy. The alternative, keeping the attempt's secret
  where the landing tab could read it, was rejected: the secret would have to leave memory, and
  it is the credential that receives the session.

The binding is deliberately **not** a credential. Alone it does nothing; with the emailed token
it only marks an attempt as proven; the session still goes to the holder of the attempt's
secret. That is why it may be kept where a second tab can read it.

### The token is in the fragment

A URL fragment is not sent to a server, is not forwarded by proxies and is not included in
`Referer`. The landing page's script reads it, removes it from the address bar
(`history.replaceState`) **before** sending anything, and posts the token in a JSON body. The
logger's redaction list names `linkToken`, `binding`, `linkBinding` and `tula_link`, although
nothing passes them to the logger; the request log records paths only.

What a fragment does not hide: scripts on the landing page can read it until it is removed, and
the browser keeps the page's first URL in its Navigation Timing entry (observed in Chromium),
which analytics scripts sometimes report. Such a copy is of a token that is spent within the
same moment in the asking browser and is useless without the binding anywhere else.

### The redirect URL is matched exactly

`redirectUrl` must be, character for character, an entry of the environment's
`urls.allowedRedirectUrls`: no prefix, no pattern, no "same host". In the `local` tier any
`http://` URL on a loopback host is allowed as well, mirroring the CORS rule. Anything else is
`request.redirect_not_allowed` (400), before anything is looked up or sent, and the same for
every address. This is the first use of that list.

### Sign-up without a password

`POST /v1/client/sign-ups` accepts a request without `password` where `signUp.password` is
`optional` (a field error on `password` otherwise). The account is created, with no password
credential, when the emailed code is verified; the audit entry carries `passwordless: true`.
The existing-address decoy is unchanged, and nothing is hashed for either kind of address, so
the two still cost the same. Such an account signs in by email, "change my password" answers
`password.not_set`, and a first password is set through the reset flow (ADR 0019). A sign-up
that does send a password behaves as before. Each later step checks the switch of the method
the sign-up relies on: the password's, or the email code's for a sign-up without one.

### `@tula/core`

- `SignInFlow` gains `prepareFirstFactor`, `attemptFirstFactor`, `waitForEmailLink` and
  `discard`; `signIn` gains `canUseEmailLink()` and `handleEmailLink()`; `signUp.start` takes an
  optional password.
- **The binding is kept in `localStorage`**, under `tula.link.<attempt id>`, as
  `{ b: binding, e: expiry, s: client scope }`. This is the one thing the SDK puts in web
  storage, and the rule against storage for tokens and attempt secrets stands. It has to be
  storage a *new tab* can read; nothing in memory is. The entry is removed when the link is
  used, when the sign-in completes and on `discard()`, and otherwise fifteen minutes after it
  was stored, **on the device's own clock** (comparing the server's expiry with a device clock
  that runs fast would drop it at once). Without usable storage (a sandboxed frame, some
  privacy modes) `canUseEmailLink()` is `false`, asking for a link fails before any email is
  sent, and the code path is untouched.
- **Waiting is polling, with a nudge.** `waitForEmailLink()` asks every three seconds; the tab
  that accepted the link posts a message on a `BroadcastChannel`, which makes the waiting tab
  ask at once, so in practice the timer is the fallback. One loop per flow, shared by every
  caller; each caller leaves with its own `AbortSignal` and the loop ends with the last one, on
  `discard()`, on sign-out, when the step moves on, or on an error (an expired attempt answers
  `flow.not_found`, so a wait never outlives its attempt). `Retry-After` is obeyed. Nothing is
  left running. The route's per-IP limit is 60 a minute, twice the usual, to leave room for it.
- `handleEmailLink()` returns `none`, `signed_in`, `verified`, `different_browser` or `expired`.
  After `verified` it waits up to four seconds for the session the starting tab's completion
  shares (the existing session channel, or the cookie), so the landing tab normally ends up
  signed in as well.

### `@tula/react`

- `<SignIn>` draws `needs_first_factor` as one form plus "other ways to sign in". Choosing an
  email method asks for its email in the same click. Where the email code is the only method,
  submitting the address goes straight to the code. The link screen says to open the link in
  this browser, and takes the code from the same email for a user on another device.
  "Email me a link" is offered only when the app gave a page for links (`emailLinkUrl`, a prop)
  and the browser can keep the binding.
- `<SignUp>` labels the field "Password (optional)" where it is, with a hint, and shows no
  requirements until something is typed. The field was kept rather than hidden behind a
  button: it is one form either way, and password managers still offer to fill it.
- `<EmailLinkCallback>` / `useEmailLinkCallback()` is the landing page: signed in here,
  continue in your other tab, open it where you started (or use the code), expired, or no link.
  It also handles a link that arrives by a fragment change alone (pasted into a tab already
  showing the page), which loads nothing.

## Consequences

- **Cross-device magic links do not exist**, by decision. A user who opens the link on another
  device is told to type the code on the device where they started. This is a deliberate step
  back from the phase plan's sketch, for the reason given in Context.
- A user who **closes the tab** they started in and then opens the link in the same browser has
  the link accepted and nobody to complete it: the page says "continue in your other tab … if
  you closed it, sign in again". Completing in the landing tab would need the attempt's secret
  in storage.
- Enabling the email code makes the inbox a first factor. It already was the way to reset a
  password; a second factor (1.8) still stands between it and a session.
- The landing page and the allow-list are app set-up: an app that wants links lists its landing
  URL in `urls.allowedRedirectUrls` and renders `<EmailLinkCallback>` there.
- A waiting tab makes about twenty requests a minute for at most ten minutes when no other tab
  nudges it. An unopened link's answer costs one read.
- The conformance format gained `emailLink` steps (a runner reads the link from the email) and
  `cleanup` steps, which run whether or not a scenario's steps passed, so a scenario that
  changes the environment's settings puts them back even when it fails.
- `@tula/core` grew from about 7.7 kB to 9.7 kB gzip; its budget is now 11 kB (was 9), and
  `@tula/react`, at 26.4 kB, has one of 30 kB (was 26).
- 1.9 (OAuth) reuses the exact-match redirect check; 1.8 (TOTP) is reached from the email
  factors through the same `Factors.requiredFor` hook as from the password.
