# @tula/core

The headless TypeScript client for [Tula Auth](../../README.md): server-driven sign-up, sign-in
and password reset, the session, and token refresh. No UI and no framework. It runs in browsers,
Node, Bun and edge runtimes, and is what `@tula/react` and `@tula/nextjs` are built on.

> Not published yet. Inside this repository, depend on it with `"@tula/core": "workspace:*"`.

## Quickstart

```ts
import { createTulaClient, isTulaError } from '@tula/core'

const tula = createTulaClient({
  publishableKey: 'tula_pk_dev_…',          // safe to embed in an app
  baseUrl: 'https://auth.example.com',      // where the Tula API is served
  onSessionChange: (state) => render(state),
})

await tula.load()                           // who is signed in? → 'signed-in' | 'signed-out'

const flow = await tula.signIn.start({ identifier: 'maya@northline.app' })
try {
  const step = await flow.submitPassword({ password })
  if (step.status === 'complete') {
    const token = await tula.session.getToken()   // send this to your own backend
  }
} catch (error) {
  if (isTulaError(error)) {
    show(error.code, error.message)         // 'auth.invalid_credentials', 'The email or password is incorrect.'
  }
}
```

Creating a client sends nothing. Call `load()` once when the app starts.

## Flows

The server decides the next step; draw one screen per `step.status`. The flow object keeps the
attempt's secret to itself (in memory only) and sends it on every call.

```ts
// Sign-up
const flow = await tula.signUp.start({ email, password, firstName: 'Maya' })
flow.step            // { status: 'needs_email_verification', destination: 'm***@northline.app', strategies: ['email_code'] }
await flow.verifyEmail({ code: '123456' })   // → { status: 'complete', userId, sessionId }
await flow.resendCode()

// Sign-in
const flow = await tula.signIn.start({ identifier: email })
flow.step            // { status: 'needs_password' }  (or 'needs_first_factor' with strategies)
await flow.submitPassword({ password })      // → 'complete', 'needs_email_verification' or 'needs_second_factor'
await flow.verifyEmail({ code })

// Forgotten password: the code and the new password travel together
const flow = await tula.resetPassword.start({ email })
await flow.submit({ code, password: newPassword })
```

### Signing in by email

Where the environment enables them, a sign-in start answers `needs_first_factor` with
`email_code` and/or `email_link` among its `strategies`.

```ts
const flow = await tula.signIn.start({ identifier: email })

// A 6-digit code
await flow.prepareFirstFactor({ strategy: 'email_code' })     // emails it; step.prepared says where to
await flow.attemptFirstFactor({ strategy: 'email_code', code })  // → 'complete' (or 'needs_second_factor')

// A link (the same email carries the code as well)
if (tula.signIn.canUseEmailLink()) {
  await flow.prepareFirstFactor({
    strategy: 'email_link',
    redirectUrl: 'https://app.example.com/auth/link',   // an allowed redirect URL, exactly, on this page's origin
  })
  const step = await flow.waitForEmailLink({ signal })  // resolves when the link was opened in this browser
}
flow.discard()   // when the user leaves the screen: stops waiting, forgets the link's binding

// On the page the link leads to, once:
const { status } = await tula.signIn.handleEmailLink()
// 'signed_in' | 'verified' | 'different_browser' | 'expired' | 'none'
```

- **A link works only in the browser that asked for it.** `handleEmailLink()` takes the token
  out of the URL fragment (and out of the address bar), and sends it with a binding this
  browser was given when it asked. In any other browser there is no binding: the answer is
  `different_browser`, nothing is used up, and the user types the code where they started.
- Opening a link never signs the opening tab in by itself. The tab that started the sign-in
  completes it (`waitForEmailLink`), and the landing tab then shares its session: `signed_in`.
  `verified` means the link was accepted but the starting tab has not finished (it was closed,
  perhaps): the user starts again.
- `waitForEmailLink()` asks the server every few seconds, at once when the landing tab says the
  link was accepted, and obeys `Retry-After`. It ends when the step moves on, on `signal`,
  `discard()`, sign-out or an error (an expired attempt is `flow.not_found`); nothing keeps
  running afterwards. The other actions keep working while it waits.
- **The link's page must be on the same origin as the page that asks** (scheme, host and
  port). The binding is kept in that origin's storage; a page elsewhere could not read it, and
  the link would answer `different_browser` in the very browser that asked. In a browser,
  `prepareFirstFactor` refuses such a `redirectUrl` itself with `link.cross_origin` (`status:
  0`, nothing sent); outside a browser there is no page origin and nothing is checked.
- A dead link (`expired`) leaves this browser's binding alone: the link of an older email, or
  a forged one, cannot undo the email that is current.
- The answer to `prepareFirstFactor` is the same whether or not the address has an account.
- `signUp.start({ email })` without a password is accepted where the environment's config says
  `signUp.password === 'optional'`.

Every step status, so that a `switch` can be exhaustive: `needs_identifier`, `needs_password`,
`needs_first_factor`, `needs_email_verification`, `needs_new_password`, `needs_second_factor`,
`needs_factor_enrolment`, `complete`. The last two before `complete` are covered under
[Two-step verification](#two-step-verification).

When a step is `complete` the client is signed in: `tula.state.status === 'signed-in'`, and
the flow object is spent (its secret is dropped; further actions are refused locally).
Disable the submit button while an action is pending: a second one is refused with `flow.busy`.
A flow cannot be resumed after a page reload; start again (attempts last ten minutes).

## Signing in with a provider (OAuth)

```ts
// On the sign-in page: keeps a binding for this tab and navigates to the provider.
await tula.signIn.withOAuth({ provider: 'google', redirectUrl: `${location.origin}/oauth/callback` })

// On /oauth/callback, on every load:
const outcome = await tula.signIn.handleOAuthCallback()
switch (outcome.status) {
  case 'complete':          // signed in
  case 'needs_step':        // outcome.flow.step is needs_second_factor or needs_factor_enrolment:
    break                   //   outcome.flow.submitSecondFactor({ method: 'totp', code })
  case 'linked':            // a link started with tula.user.identities.link(): outcome.identity
  case 'different_browser': // this browser did not start it; nothing was completed
  case 'error':             // outcome.code: 'oauth.account_exists', 'oauth.access_denied', …
  case 'none':              // no OAuth answer in the address
}

await tula.user.identities.list()
await tula.user.identities.link({ provider: 'github', redirectUrl })   // needs a recent sign-in
await tula.user.identities.unlink({ identityId })                      // refused for the last way in
```

The provider returns to the API, which redirects to `redirectUrl` with a single-use, 60-second
ticket in the URL **fragment**. `handleOAuthCallback()` removes it from the address before it
sends anything and exchanges it together with the binding. The binding is the one thing kept
in `sessionStorage` (`tula.oauth.<attempt id>`): the page is replaced by the provider's, so
memory does not survive, and only the same tab may finish. It is not a token and not the
attempt's secret, it is removed on every outcome, and it expires after fifteen minutes.
`redirectUrl` must be on the page's own origin (`link.cross_origin` otherwise) and on the
environment's allow-list. `withOAuth({ navigate: false })` returns the URL instead of
navigating. No provider token ever reaches the client.

## Session

```ts
await tula.session.getToken()      // a valid access token, refreshed first if needed; null when signed out
await tula.session.refresh()       // refresh now
await tula.session.signOut()

const sessions = await tula.session.list()         // the user's devices; `current` marks this one
await tula.session.revoke(sessions[1].id)
await tula.session.revokeOthers()                  // → how many ended

await tula.user.get()                              // the signed-in user (also updates tula.state)
await tula.user.changePassword({ currentPassword, newPassword })

const config = await tula.config.get()             // app name, sign-in methods, password policy, mfa.policy (cached)
```

Access tokens last about a minute. Call `getToken()` each time you need one rather than keeping
it: the call is free while the token is fresh, and any number of concurrent calls share one
refresh.

### State

```ts
tula.state      // { status: 'loading' } | { status: 'signed-out' } | { status: 'signed-in', sessionId, user }
const stop = tula.onChange((state) => { … })      // also: the onSessionChange option
```

The state object keeps its identity until something changes, and a token refresh is not a
change, so it can be used directly as an external-store snapshot.

## Two-step verification

An authenticator app (TOTP) plus ten backup codes. Whether an app offers it is the
environment's `mfa.policy`: `(await tula.config.get()).mfa?.policy ?? 'off'` is `off` (hide
it), `optional` or `required`.

```ts
// Turning it on, for the signed-in user
const { totp, backupCodes } = await tula.mfa.get()   // { enabled, confirmedAt }, { remaining }
const { secret, uri } = await tula.mfa.startTotp()   // show `uri` as a QR code, `secret` for typing
const { codes } = await tula.mfa.confirmTotp({ code: '123456' })   // ten backup codes, once

await tula.mfa.regenerateBackupCodes()               // → { codes }: the earlier ones stop working
await tula.mfa.disableTotp()

// Signing in (and resetting a password) with it on
const flow = await tula.signIn.start({ identifier: email })
await flow.submitPassword({ password })              // → { status: 'needs_second_factor', options: ['totp', 'backup_code'] }
const { step } = await flow.submitSecondFactor({ method: 'totp', code: '123456' })
// or a backup code, which is spent:
const { step, backupCodesRemaining } = await flow.submitSecondFactor({ method: 'backup_code', code })

// Where the environment requires it and the user has none, a flow stops to enrol
if (flow.step.status === 'needs_factor_enrolment') {
  const { secret, uri } = await flow.startTotpEnrolment()
  const { step, backupCodes } = await flow.confirmTotpEnrolment({ code: '123456' })   // signed in
}
```

- **The secret, its URI and the backup codes are handed to you once and kept nowhere in the
  SDK**: not on the client or a flow object, not in `JSON.stringify` of either, not in storage,
  not in an error. The server cannot show them again either. Put them on screen and let them go.
- `submitSecondFactor` and `confirmTotpEnrolment` answer `{ step, … }` rather than the step
  alone, because they carry something for the caller: `backupCodesRemaining` after a backup
  code, `backupCodes` after an enrolment. If the device cannot store the session
  (`storage.failed`), `confirmTotpEnrolment` still returns the codes, with the error as
  `failure` instead of throwing it: the user is signed in for as long as the app runs.
- `confirmTotp` ends the user's other sessions and refreshes this one, so that its next access
  token says the second factor was proven. If that refresh cannot be made the codes are
  returned all the same, and the next `getToken()` asks again.
- A wrong code is `mfa.invalid_code`; repeated wrong codes are `rate_limited` with
  `retryAfterMs`. An authenticator code is accepted once: after a wrong guess wait for the app
  to show the next one. `mfa.enrolment_expired` means start again (a pending enrolment lasts
  ten minutes). `mfa.not_available`: the policy is `off`. `mfa.required_by_policy`: it cannot
  be turned off.
- There is no emailed bypass. A user who lost both the authenticator and the backup codes is
  reset by an administrator.

## Step-up

Sensitive calls need a recent proof of who the user is: `mfa.startTotp`, `mfa.disableTotp`,
`mfa.regenerateBackupCodes`, and, for a user with two-step verification,
`user.changePassword`. When the session's last proof is older than ten minutes (or did not
include the second factor) they answer `auth.step_up_required`. The SDK never prompts and
never retries by itself; your UI does:

```ts
import { isStepUpRequired, stepUpMethods } from '@tula/core'

try {
  await tula.mfa.regenerateBackupCodes()
} catch (error) {
  if (!isStepUpRequired(error)) throw error
  const methods = stepUpMethods(error)       // ['totp', 'backup_code'], ['password'] or []
  if (methods.length === 0) {
    // Nothing to prove with (an account that signs in by email only): sign in again.
  }
  await tula.session.stepUp({ method: 'totp', code })        // or { method: 'backup_code', code }
  // a user without two-step verification: { method: 'password', password }
  await tula.mfa.regenerateBackupCodes()     // repeat the call
}
```

`session.stepUp` gives the **same session** a new access token. The refresh token (or cookie)
is untouched, `tula.state` does not change, and other tabs get the token too. A wrong password
is `auth.invalid_credentials`, a wrong code `mfa.invalid_code`; a method the user may not use
(a password, for a user with two-step verification) is `auth.step_up_required` again. If the
session's token was replaced while the proof was on its way (a refresh, here or in another
tab), the step-up's token is not installed over it; the client refreshes once more instead, so
the token it ends with was issued after the proof.

## Password checklist

```ts
import { evaluatePassword } from '@tula/core'

const { password: policy } = await tula.config.get()
const { ok, checks } = evaluatePassword(policy, typed, { email })
// checks: [{ rule: 'min_length', code: 'password.too_short', passed: false, params: { min: 10 } }, …]
```

The same function the server runs, so the checklist and the server never disagree. (The
breached-password check is server-side only.)

## Errors

Every failed call throws a `TulaError`:

```ts
error.code           // a contract code ('password.too_short', 'rate_limited', …) or a client one
error.status         // HTTP status; 0 when the request got no answer
error.message        // ready to show, from the locale table
error.params         // { min: 10 }
error.errors         // field errors: [{ field: 'password', code: 'password.too_short', message, params }]
error.retryAfterMs   // on a 429 or 503 that says when to try again
```

Client-side codes (all `status: 0`): `network.failed`, `network.timeout`, `response.invalid`
(the answer could not be read, or a 200 was not what the API sends: check `baseUrl`),
`storage.failed`, `flow.busy` (a second action on a flow while one is still being sent), and
`link.cross_origin` (an emailed sign-in link was asked for with a page on another origin).
One contract code is also raised locally: `flow.invalid_step` with `status: 0` for an action on
a flow that has already completed. The client never retries on its own, with one exception: a refresh that got no answer is sent
once more (see the security notes). After a 429 or 503
with `Retry-After`, `getToken()` fails fast until then (at most five minutes,
`MAX_REFRESH_BACKOFF_MS`); an explicit `session.refresh()` always asks. For another language, pass messages for any subset of
codes (the rest stay English); a message may use the error's params as placeholders:

```ts
createTulaClient({
  publishableKey,
  baseUrl,
  messages: {
    'auth.invalid_credentials': 'El correo o la contraseña no son correctos.',
    'password.too_short': 'Usa al menos {min} caracteres.',
  },
})
tula.setMessages(otherLocale)      // switch later
```

`EN_MESSAGES` is the full English table, the starting point for a translation.

## Options

| Option | Default | |
| --- | --- | --- |
| `publishableKey` | required | `tula_pk_<env>_…`. A secret key is refused. |
| `baseUrl` | required | The API's absolute URL. |
| `client` | `web` in a browser, `server` elsewhere | `web`, `ios`, `android` or `server`: decides where the refresh token lives. |
| `storage` | `memoryStorage()` | Where a non-`web` client keeps its refresh token. Not allowed for `web`. |
| `fetch` | the global `fetch` | `(request: Request) => Promise<Response>`. |
| `onSessionChange` | none | Same as a first `onChange` listener. |
| `messages` | English | Messages by error code. |
| `timeoutMs` | `15000` | Per request. A refresh uses `min(timeoutMs, 8000)`; see the security notes. |

## Security notes

**Where tokens live.**

- The **access token** is kept in memory only. It is never written to `localStorage`,
  `sessionStorage`, a cookie or the storage adapter.
- In a browser (`client: 'web'`) the **refresh token** is an `HttpOnly` cookie set by the API.
  JavaScript, this SDK included, cannot read it; requests are sent with
  `credentials: 'include'`. An XSS bug in your app cannot steal it.
- Elsewhere the refresh token is held in memory and in the `storage` adapter you provide.
  It is a long-lived credential: back the adapter with the platform's secure store (Keychain,
  Keystore), never with `localStorage` or a plain file. The default keeps it in memory, so the
  session ends with the process. A React Native secure-store adapter comes in Phase 2.
- An attempt's secret stays inside its flow object, in memory. It is not in `JSON.stringify(flow)`,
  not in logs and not in errors.
- A TOTP secret, its `otpauth://` URI and backup codes pass through the SDK to the caller and
  are kept nowhere: not in memory after the call returns, not in storage, not in an error.
- **The one thing this SDK puts in `localStorage`** is the binding of an emailed sign-in link
  (`tula.link.<attempt id>`), because a new tab of the same browser has to read it. It is not a
  token and not the attempt's secret: alone it authorizes nothing, with the emailed token it
  only marks the attempt as proven, and the session still goes to the tab holding the secret.
  It is removed when the link is used, when the sign-in completes and on `discard()`, and after
  fifteen minutes otherwise. Where storage is missing or refused, `canUseEmailLink()` is
  `false` and only the code is available.
- An emailed link's token travels in the URL **fragment**, which a browser never sends to a
  server, and `handleEmailLink()` removes it from the address before it sends anything.

**The app and the API must be same-site (browsers).** The refresh cookie is `SameSite=Lax` and
belongs to the API's origin, so the browser only sends it when the page and the API are on the
same site: `app.example.com` with `auth.example.com`, or two ports on `localhost`. An app on a
different site (`myapp.com` with `auth.tula.example`) needs a first-party proxy in front of the
API; `@tula/nextjs` will provide one. The page's origin must also be in the environment's
allowed origins (`urls.allowedOrigins`), or flows answer `request.origin_not_allowed`.

**Tabs.** Tabs of one app share the cookie. They take turns refreshing (Web Locks) and tell
each other the result, and a sign-out in one tab signs the others out at once
(`BroadcastChannel`). Where a browser lacks either, the server's short reuse grace period makes
the leftover race harmless.

**A lost refresh and the grace period.** Refresh tokens are single-use. If the server rotates
one but its answer never arrives, the client still holds the old token, and presenting it again
is forgiven only inside the server's reuse grace period (10 seconds by default); after that it
is treated as theft and the whole session is revoked, on every device. So a refresh gives up
after 8 seconds (`REFRESH_TIMEOUT_MS`), not the general 15, and if it got no answer at all (a
timeout or a network failure, never an HTTP answer) the client sends it **once more, at once**,
with what is left of the 10-second window (`REFRESH_RETRY_WINDOW_MS`). This is the only request
the client ever repeats by itself. If the retry also fails, `getToken()` rejects with the
network error and the session is kept; asking again later than the grace period may then sign
the user out. An operator who shortens `refresh.reuseGracePeriod` below 8 seconds removes that
margin.

**A signed-out client stays signed out.** After `signOut()` (here or in another tab), a late
401, a refresh that was in flight, or another tab's message about the session that ended
cannot sign the client back in. Only a new sign-in, or this client's own `load()`/`refresh()`,
can.

**When a session ends.** If a refresh is refused (expired, revoked, signed out elsewhere, or a
reused refresh token), the state becomes `signed-out`, listeners are told once, and nothing is
retried.

## Development

```bash
bun run --filter @tula/core test            # unit tests (fake fetch, locks, channel, clock)
bun run --filter @tula/core typecheck       # also typecheck:portable: web-platform types only
bun run --filter @tula/core generate        # regenerate src/generated/api.gen.ts from the OpenAPI snapshot
bun test apps/api/src/sdk-journeys.test.ts  # the SDK against the real API, in process
bun run playground                          # manual test bench in a browser (examples/core-playground)
```

Design and reasoning: [ADR 0021](../../docs/adr/0021-core-sdk.md).
