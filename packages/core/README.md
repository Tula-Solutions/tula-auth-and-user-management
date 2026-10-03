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

Every step status, so that a `switch` can be exhaustive: `needs_identifier`, `needs_password`,
`needs_first_factor`, `needs_email_verification`, `needs_new_password`, `needs_second_factor`,
`complete`. `needs_second_factor` has no action yet (it arrives with TOTP).

When a step is `complete` the client is signed in: `tula.state.status === 'signed-in'`, and
the flow object is spent (its secret is dropped; further actions are refused locally).
Disable the submit button while an action is pending: a second one is refused with `flow.busy`.
A flow cannot be resumed after a page reload; start again (attempts last ten minutes).

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

const config = await tula.config.get()             // app name, sign-in methods, password policy (cached)
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
`storage.failed`, and `flow.busy` (a second action on a flow while one is still being sent).
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
