# Hooks

A hook is a signed **question** the server asks your backend before it does something. Your
answer decides what happens. That is the difference from a
[webhook](webhooks.md), which tells you about something that has already happened and whose
answer changes nothing.

There are three, one per **point**:

| Point | Asked | Your answer |
| --- | --- | --- |
| `before_sign_up` | when a sign-up is about to create an account for a proven address | allow, or deny with a message code of your own |
| `before_session` | when every factor of a sign-in is proven and its session is about to be created | allow, or deny with a message code of your own |
| `before_token` | when a session is created, and when its user proves a factor again | claims to add to the session's tokens |

You register an address for a point; the server posts the question to it and reads your
answer inside a deadline. The design and its reasons are in
[ADR 0035](adr/0035-hooks.md). What is not built yet is listed [at the end](#not-built-yet).

## Register a hook

With a secret key. An environment has **one hook per point**; the server makes the signing
secret and returns it **once**:

<!-- snippet: examples/docs-snippets/admin.ts#hook-register -->
```ts
const { data: hook } = await admin.call('createHook', {
  body: {
    // `before_sign_up`, `before_session` or `before_token`: one hook per point.
    point: 'before_sign_up',
    url: 'https://api.example.com/tula/before-sign-up',
    // Optional: 2000 unless given, at least 100, never more than 5000.
    deadlineMs: 2000,
  },
})
// The only time the secret is returned: put it in your secret manager now.
await storeSecret(hook.secret)
```
<!-- /snippet -->

or without the SDK:

```bash
curl -X POST https://auth.example.com/v1/admin/hooks \
  -H "Authorization: Bearer $TULA_SECRET_KEY" -H 'content-type: application/json' \
  -d '{"point":"before_session","url":"https://api.example.com/tula/before-session"}'
```

| Field | |
| --- | --- |
| `point` | `before_sign_up`, `before_session` or `before_token`. Cannot be changed afterwards. |
| `url` | Where the question is posted. `https`, no credentials, and a host that resolves to public addresses only; otherwise `hook.url_not_allowed` (422) with a fixed word in `params.reason`. Judged when it is saved and again at every call. |
| `enabled` | `true` unless given. A hook that is off is not asked: things go on as if there were none. |
| `deadlineMs` | How long the server waits for your answer. `2000` unless given, at least `100`, **never more than `5000`**. |
| `failureMode` | `deny` unless given. See [When the hook fails](#when-the-hook-fails). |

There is no `secret` field: you cannot supply one, and no later call returns it. To replace a
secret, remove the hook and register it again (for that moment there is no hook). Each hook
has a secret of its own.

`GET /v1/admin/hooks`, `GET`, `PATCH` and `DELETE /v1/admin/hooks/{id}` list, read, change and
remove:

<!-- snippet: examples/docs-snippets/admin.ts#hook-manage -->
```ts
// What the operator sees of a hook that is failing: when, and a fixed word for why.
const { data: current } = await admin.call('getHook', { params: { id: hook.id } })
if (current.lastFailureReason === 'timeout') {
  // The endpoint did not answer inside `deadlineMs`.
}
// Each of these removes a check and is recorded with `weakened: true`.
await admin.call('updateHook', { params: { id: hook.id }, body: { failureMode: 'allow' } })
await admin.call('updateHook', { params: { id: hook.id }, body: { enabled: false } })
await admin.call('deleteHook', { params: { id: hook.id } })
```
<!-- /snippet -->

## The question

A `POST` with `content-type: application/json` and the three
[Standard Webhooks](https://www.standardwebhooks.com/) headers a webhook delivery has
(`webhook-id`, `webhook-timestamp`, `webhook-signature`), signed with the hook's secret. The
envelope is the same for every point; `type` says which, and `data` is that point's own:

```json
{
  "id": "0199c2f6-0000-7000-8000-000000000001",
  "type": "hook.before_sign_up",
  "schemaVersion": 1,
  "occurredAt": "2026-10-08T09:30:00.000Z",
  "data": {
    "email": "ada@example.com",
    "method": "password",
    "client": "web",
    "ipAddress": "203.0.113.7"
  }
}
```

A question never holds a password, a code, a token, a name, a user agent, an attempt's id or
anything of a provider's profile. It is not an event (it has no `actor` and no `target`), and
it is never stored: not in the outbox, not in the audit log.

### `hook.before_sign_up`

| Field of `data` | |
| --- | --- |
| `email` | The address the account would be created for, in lower case. It has been **proven** by the time you are asked: by an emailed code, or by a provider that asserts it verified. |
| `method` | How the sign-up is made: `password`, `passwordless`, or `oauth_google`, `oauth_github`, `oauth_apple`, `oauth_microsoft`, `oauth_discord`, `oauth_linkedin`. |
| `client` | The kind of client the sign-up started from (`web`, `ios`, `android`, …). |
| `ipAddress` | The address the request came from, as the server knows it, or `null`. Behind a proxy this is right only where the deployment says how the address is known ([self-host.md](self-host.md)). |

### `hook.before_session`

```json
{
  "userId": "0199c2f4-7a10-7c3e-9b1a-5d2e8f4a6c01",
  "client": "web",
  "profile": "web",
  "amr": ["pwd", "otp", "mfa"],
  "signUp": false,
  "ipAddress": "203.0.113.7"
}
```

| Field of `data` | |
| --- | --- |
| `userId` | The user who has just proven who they are. The account exists; look it up by this id (`GET /v1/admin/users/{id}`) if you need more. |
| `client` | The kind of client the sign-in started from. |
| `profile` | The name of the [session profile](adr/0028-session-profiles.md) the session will have. |
| `amr` | What the sign-in proved (`pwd`, `email`, `otp`, `mfa`, `fed`, …). **A set**: test membership, never position. |
| `signUp` | `true` when this sign-in created the account: the first session of a sign-up, or a first sign-in with a provider. |
| `ipAddress` | The address the request came from, or `null`, as above. |

**No email address.** The account exists and its id names it; an address would be one more
copy of personal data in every question. A sign-up's question has it because there is no id
yet.

### `hook.before_token`

```json
{
  "userId": "0199c2f4-7a10-7c3e-9b1a-5d2e8f4a6c01",
  "sessionId": "0199c2f4-7a12-7d4f-8c2b-6e3f9a5b7d02",
  "client": "web",
  "profile": "web",
  "amr": ["pwd", "otp", "mfa"]
}
```

| Field of `data` | |
| --- | --- |
| `userId` | The session's user. |
| `sessionId` | The session the claims are for. At a sign-in it is the id the session is about to get. |
| `client`, `profile` | As above. |
| `amr` | What the session has proven **by now**: at a step-up, with what was just proven added. |

No email address and **no IP address**: your answer is stored on the session and issued with
every later token, and a claim that depended on the address of one request would be signed
into tokens used from others.

## The answer

### A deciding hook: `before_sign_up`, `before_session`

A `200` whose body is **exactly** one of:

```json
{ "decision": "allow" }
```

```json
{ "decision": "deny", "code": "disposable_email" }
```

`code` is optional and is yours: lower-case letters, digits and underscores, at most 64
characters. The client gets it back and your app turns it into words
([What the user sees](#what-the-user-sees)). It is logged; it is in no event and no audit
entry.

### A claims hook: `before_token`

A `200` whose body is **exactly**:

```json
{ "claims": { "plan": "pro", "seats": 5, "beta": false } }
```

The claims are issued inside the one namespace claim `ext` of the session's access tokens,
next to (and under the same rules as) the claims of the profile's
[JWT template](jwt-templates.md):

- a key is letters, digits and underscores, at most 32 characters, and **not a reserved
  claim name** (`sub`, `iss`, `aud`, `exp`, `amr`, `auth_time`, `sid`, `ext`, … the list in
  [jwt-templates.md](jwt-templates.md#rules));
- a value is one string, number or boolean: no object, no list, no `null`;
- **the whole of `ext` is at most 1,024 bytes** as JSON: your claims *together with* the
  template's. Over that when you answer is a failed call (`claims_too_large`). If the two
  stop fitting later (a larger template is saved, an address grows), your claims are still
  issued and the template's are left out ([jwt-templates.md](jwt-templates.md#claims-from-a-hook));
- where your hook and the template set the same key, **yours wins**. A template is the
  profile's default for everybody; your answer is about this user.

`{ "claims": {} }` is an answer and means none. A claims hook **cannot deny**: there is no
`decision` in its answer. To refuse a sign-in, use `before_session`.

**One claim that breaks a rule fails the whole answer.** None of it is issued, not even its
good claims, and the hook's failure mode decides. The server does not issue half of an
answer: an application that authorizes on `plan` must not get a token whose `plan` survived
and whose `suspended` was dropped.

### Either kind

Anything else is **not an answer** but a failed call: a status that is not 2xx (whatever its
body says), a redirect, a body over the size cap (1 KiB for a decision, 4 KiB for claims), a
body that is not JSON, **any other key**, the other kind of answer, or no answer inside the
deadline. An unknown key is not ignored: a later version may give one meaning, and the server
will not act on half of an answer.

A complete receiver for each point:

<!-- snippet: examples/docs-snippets/admin.ts#hook-receive -->
```ts
// The route the hook's address leads to, on any server that gives you a `Request`.
export async function beforeSignUp(request: Request): Promise<Response> {
  let question: TulaHookQuestion
  try {
    // The body exactly as it arrived: the signature is over these bytes.
    question = await verifyHook(await request.text(), request.headers, hookSecret)
  } catch (error) {
    // Not from Tula, changed on the way, older than five minutes, or not a question.
    // Never answer `allow` to a request that did not verify.
    return new Response(null, { status: isTulaAdminError(error) ? 400 : 500 })
  }
  if (question.type !== 'hook.before_sign_up') {
    // Another point's question sent to this address: not one this route answers.
    return new Response(null, { status: 400 })
  }
  // `question.data` is the address being signed up, how (`password`, `passwordless`,
  // `oauth_google`, …), the kind of client and the IP address the request came from.
  const answer: TulaHookAnswer = isDisposable(question.data.email)
    ? // Your own code, for your app to turn into words: lower-case letters, digits, `_`.
      { decision: 'deny', code: 'disposable_email' }
    : { decision: 'allow' }
  // A 200 with exactly this body. Anything else is a failed call, not an answer.
  return Response.json(answer)
}
```
<!-- /snippet -->

<!-- snippet: examples/docs-snippets/admin.ts#hook-receive-session -->
```ts
// Asked when every factor of a sign-in is proven, just before its session is created.
export async function beforeSession(request: Request): Promise<Response> {
  let question: TulaHookQuestion
  try {
    question = await verifyHook(await request.text(), request.headers, hookSecret)
  } catch (error) {
    return new Response(null, { status: isTulaAdminError(error) ? 400 : 500 })
  }
  if (question.type !== 'hook.before_session') {
    return new Response(null, { status: 400 })
  }
  // `question.data` is the user's id, the kind of client, the session profile, what was
  // proven (`amr`), whether this sign-in created the account, and the IP address.
  const { userId, amr, profile } = question.data
  let answer: TulaHookAnswer = { decision: 'allow' }
  if (await isSuspended(userId)) {
    answer = { decision: 'deny', code: 'account_suspended' }
  } else if (profile === 'admin' && !amr.includes('mfa')) {
    // `amr` is a set: test membership, never position.
    answer = { decision: 'deny', code: 'two_step_needed' }
  }
  return Response.json(answer)
}
```
<!-- /snippet -->

<!-- snippet: examples/docs-snippets/admin.ts#hook-receive-token -->
```ts
// Asked when a session is created and when its user proves a factor again. Not at a
// refresh: what you answer is stored on the session and issued until one of those happens.
export async function beforeToken(request: Request): Promise<Response> {
  let question: TulaHookQuestion
  try {
    question = await verifyHook(await request.text(), request.headers, hookSecret)
  } catch (error) {
    return new Response(null, { status: isTulaAdminError(error) ? 400 : 500 })
  }
  if (question.type !== 'hook.before_token') {
    return new Response(null, { status: 400 })
  }
  const { plan, seats } = await planOf(question.data.userId)
  // Exactly `{ claims }`. Each value one string, number or boolean; no reserved name
  // (`sub`, `amr`, …); at most 1,024 bytes together with the profile's template claims.
  const answer: TulaHookClaimsAnswer = {
    claims: { plan, seats, elevated: question.data.amr.includes('mfa') },
  }
  return Response.json(answer)
}
```
<!-- /snippet -->

`verifyHook` checks what `verifyWebhook` checks (the signature in constant time, a timestamp
within five minutes) and that the body is a question of a type this version knows: it refuses
an event, and `verifyWebhook` refuses a question, whatever secret signed either. Pass it the
body exactly as it arrived. **Narrow on `question.type` before you read `data`**, and never
answer `allow` to a request that did not verify.

Answer quickly. The person is waiting, a question is asked once and never repeated, and at
the deadline the server stops listening.

## When the hook fails

A call fails when your endpoint cannot be reached, answers too late, or answers with
something that is not an answer. What happens then is the hook's `failureMode`:

| Point | `deny` (default) | `allow` |
| --- | --- | --- |
| `before_sign_up` | The sign-up is refused with `hook.unavailable` (503). No account. | The account is created; its `user.created` says `hookBypassed: true`. |
| `before_session` | The sign-in is refused with `hook.unavailable` (503). No session. | The session is created; its `session.created` says `hookBypassed: true`. |
| `before_token` | The sign-in, or the step-up, is refused with `hook.unavailable` (503). No session is created; a step-up changes nothing. | The session is created, or stepped up, **without your claims**; `session.created` or `session.stepped_up` says `claimsHookBypassed: true`. |

With `deny`, a check that is down lets nobody in: your sign-ins depend on your endpoint being
up. With `allow` they do not, and **whoever can make your endpoint fail, or wait until it
does, gets in unchecked**. That costs exactly the protection the hook is for, at the moments
an attacker would choose, which is why choosing it is **recorded as a weakening**: the audit
entry of the registration or the change carries `weakened: true`. So does switching a hook
off, and removing one that is on.

For a claims hook, `allow` means a session **without** your claims, never with stale or
partial ones. Write the application so that a missing claim is the least privilege (no
`plan` is the free plan, no `role` is no role), and let a template constant say the default
if you want one present.

To find what was let through, list the audit log with `action=user.created` or
`action=session.created` and look for the flag; to learn of one as it happens, subscribe a
[webhook](webhooks.md) to those events.

**Seeing that a hook is failing.** The hook's read answer has `lastFailedAt` and
`lastFailureReason`, one of the server's fixed words: `timeout`, `connection_failed`,
`resolve_failed`, `address_not_allowed`, `scheme_not_allowed`, `invalid_url`,
`invalid_request`, `response_too_large`, `status_not_ok` (not a 2xx), `answer_invalid` (not
exactly an answer), `claims_invalid` (a claim with a reserved or malformed key, or a value
that is not one string, number or boolean), `claims_too_large` (the claims, alone or together
with the template's, are over 1,024 bytes) or `secret_unreadable` (the server could not open
the hook's secret: `TULA_MASTER_KEY` changed). It is the last failure, whenever that was; a
denial is not a failure. The server also logs one line per failed call, with ids and the
reason. Nothing of what your endpoint said is kept.

## In the dashboard and in the config file

**The dashboard** has a Hooks screen per environment ([dashboard.md](dashboard.md)): the
three points, each with its hook or none. It adds a hook (the signing secret is shown once,
in that dialog and nowhere after), changes its address, deadline and failure mode, switches
it off and on, and removes it. Every change the server records as a weakening is asked about
first, in a sentence that says what is let through at that point, and in a production
environment the point's name has to be typed: `allow` on failure, switching a hook off, and
removing one that is on.

What the screen can say about calls is what the server keeps: **the last call that failed**
(when, and the fixed word for why, with "timed out" told apart from the rest). It says so in
those words. A call that was answered leaves no record, so the screen cannot say how often a
hook allowed or denied, nor that a hook "is failing now": the last failure stays until
another one replaces it.

**The config file** can hold an environment's hooks, by point, without their secrets
([config.md](config.md#hooks)):

<!-- snippet: examples/tula-config/tula.config.ts#hooks -->
```ts
// The questions this environment asks before it acts, by point: at most one hook per
// point. There is no secret to write here either. What an entry leaves out is the
// API's default: on, a deadline of two seconds, and `failureMode: 'deny'` (a call that
// fails refuses what was asked about). `dev` has no `hooks` key: its hooks are not
// managed by this file.
hooks: {
  before_sign_up: { url: 'https://api.northline.app/hooks/tula/sign-up' },
  before_token: { url: 'https://api.northline.app/hooks/tula/claims', deadlineMs: 1000 },
},
```
<!-- /snippet -->

`tula diff` marks the same weakenings (`! weakens security: hooks.before_sign_up.failureMode`)
and `tula apply --yes` refuses them without `--allow-weaker`. A new hook's secret goes where
a new webhook endpoint's goes: `--secrets-file`, `--show-secrets` or `--discard-secrets`.

### How long a sign-in can wait

Each call ends at its hook's deadline, which is never more than five seconds; nothing is
retried. A sign-in asks **two hooks at most** (`before_session`, then `before_token`), so
with both registered:

| | Each deadline | A sign-in waits at most |
| --- | --- | --- |
| The default | 2 s | 4 s |
| The most a hook can have | 5 s | 10 s |

A sign-up that completes in one request can ask all three (its own hook first): 6 seconds at
the defaults, 15 at the most. A hook that hangs therefore fails a sign-in in bounded time,
and shows on the hook as `lastFailureReason: "timeout"`. Set the deadline to what your
endpoint really needs.

## Where each hook is asked, and where it is not

### `before_sign_up`

**Asked**, once, when an account is about to be created by a sign-up:

- a sign-up with a password, after the emailed code was accepted;
- a sign-up without a password, at the same step;
- a first sign-in with Google, GitHub, Apple, Microsoft, Discord or LinkedIn that would create an account.

**Not asked:**

- when a sign-up **starts**, or for a wrong code. A start answers the same for an address that
  has an account and one that has none; asking you there would let anyone measure which is
  which. You are asked only once the address is proven;
- for an address that already has an account (a provider sign-in that signs in, or connects
  to, an existing account);
- when an **administrator creates a user** through the admin API or the dashboard. That is
  your own act.

### `before_session`

**Asked**, once, when a sign-in has proven **every** factor it needs and its session is about
to be created:

- a sign-in, after its last factor: the password, an emailed code or link, a passkey, a
  provider, and then the second factor or the enrolment where one is required;
- the first session of a sign-up (`signUp: true`), after `before_sign_up` allowed the account;
- the session a password reset ends in.

**Not asked:**

- when a sign-in **starts**, for a wrong password or code, or between a first and a second
  factor. Someone who cannot sign in never reaches your endpoint, so whether you were asked
  tells them nothing about an account;
- at a **refresh**, at a **step-up**, or on any request of an existing session. It decides
  whether a session begins, not whether it continues: to end one, revoke it;
- for anything an administrator does.

**A sign-up asks two deciding hooks, in order.** `before_sign_up` first, before the account
exists; then, once the account is created, `before_session`. A denial at `before_session`
therefore **leaves the account** (created, with its address verified) and creates no
session: the person has an account they are not signed in to, and signs in later if you then
allow it. If you never want the account, deny at `before_sign_up`.

### `before_token`

**Asked** when a session's inputs are set or change. Its inputs are what the question
names: the user, the session, the client kind, the profile, and what the session has proven.
Only the last can change, so:

- **when a session is created** (after `before_session` allowed it, in the same request): the
  claims are stored on the session and are in its first token;
- **when the session's user proves a factor again** (a step-up, or enrolling an authenticator
  from that session): `amr` has changed, so you are asked again and your new answer
  **replaces** the stored one. Nothing is merged or kept from the earlier answer.

**Not asked** at a **refresh**, at a refresh replayed inside the grace window, or when a
stateful session is checked. Those run about once a minute for every session there is; they
issue the stored claims and do not call you. So:

- a change in your own data reaches a session's tokens **at its next sign-in or step-up**, not
  at its next refresh. If a claim must change sooner, end the user's sessions
  (`DELETE /v1/admin/users/{userId}/sessions`), or keep that fact out of the token and look it up;
- a hook that is changed, switched off or removed does not change sessions that exist: they
  keep the claims they were given until they end or step up. At a step-up with no hook any
  more, the stored claims are cleared;
- your endpoint being down fails no refresh.

A stateful session gets the same claims in the answer of its check, and in `auth()` of
`@tula/nextjs`.

### All three

A hook is read at the moment it is asked, so one that was registered, changed, switched off
or removed while a sign-in was under way applies as it is at that moment.

Calls are counted per environment and per point: `before_sign_up` at most 600 times a
minute, `before_session` and `before_token` at most 3,000 each. Past that the request is
refused with `rate_limited`, whatever the hook's failure mode. The count is taken only once
the address or the factors are proven, so that nobody who cannot sign in can use it up.

## What a refusal costs

A denial or a failure is known only after the last proof was accepted, so that proof is
**spent** and the attempt has **ended**:

- an emailed code is used; an authenticator's code cannot be used again for its time step; a
  passkey's counter has moved; a **backup code is gone** and is not given back;
- the client starts a new sign-in. For `hook.unavailable` that is the retry.

**Backup codes are the sharp case.** A user has ten. Under the default `failureMode: "deny"`,
while your endpoint is down every sign-in that uses a backup code burns one and signs
nobody in; a user who keeps trying can use up all ten during one outage and then needs an
administrator. The order is deliberate (asking you before the proof would tell someone who
cannot sign in something about the account, and giving a spent code back would let it be
replayed), so what follows is advice:

- if you cannot keep the endpoint up, weigh `failureMode: "allow"` for `before_session`
  against what the check is for: a check that locks users out of their recovery codes when
  your service is down may cost more than it protects;
- tell a user who is refused (`hook.denied`, `hook.unavailable`) **not to try again with a
  backup code**: an authenticator's next code costs nothing, a backup code is one of ten;
- watch `lastFailedAt` on the hook.

The other choice was to keep the attempt open for a retry. It would have meant a step that
can be repeated after its proof was accepted, and for a sign-up or an in-flow enrolment a
step whose effect (the account, the confirmed authenticator) already happened. A sign-in
that reaches a hook is one request away from a new attempt; ending it is the simple rule.

A refused sign-in is **not a failed guess**: it does not count against the account's
lockout, and it does not clear guesses someone else has made beyond what the correct password
itself clears.

At a **step-up**, a `before_token` failure under `deny` refuses the step-up
(`hook.unavailable`) and the session is exactly as it was: not stepped up, its claims
unchanged, nothing recorded. The code that proved the step-up is spent; the user asks again.

One case asks your endpoint about a session that then does not exist: an environment whose
concurrent-session rule refuses the newest session (`session.limit_reached`) refuses it
after both hooks were asked.

**A refusal while a user sets up an authenticator inside a sign-in ends their other
sessions and undoes the setup.** Where the environment requires two-step verification, a
user without an authenticator sets one up as part of signing in. Confirming it ends every
other session they have, at once, because those sessions were made without it. If your
hook then denies the sign-in, or fails under `deny` (`before_session` or `before_token`),
the authenticator and its backup codes are removed again and no session is created, but
the other sessions **stay ended**: the user is signed out on their other devices and sets
the authenticator up again at their next sign-in. This can happen once per user, at that
first setup. The order is not changed to spare it: a session that did not prove the
authenticator must never outlive it being turned on, not for the seconds a hook takes to
answer and not when something fails in between.

## What a hook cannot do

A deciding hook can allow or deny. A claims hook can add claims under `ext`. Neither can
mark an address verified, skip a second factor, choose or change the user, set a name,
change what a session has proven (`amr`), its lifetime or its profile, or set any claim
outside `ext`. An answer that tries (any key beyond the ones above, a reserved claim name)
is a failed call, and nothing of it is used. After an allow, the sign-in continues exactly
as it would have with no hook.

## What the user sees

| Error code | Status | |
| --- | --- | --- |
| `hook.denied` | 403 | Your endpoint said no. `params.code` is the code you answered with, if any. |
| `hook.unavailable` | 503 | The call failed and the hook refuses on failure. Not a refusal of this person: "try again later". |

The same two codes for every point. With `@tula/core` both are a `TulaError`; read
`error.params?.code` to show your own message for a denial. The `@tula/react` components show
the default message for the code ("This was not allowed." / "This is unavailable right now.
Try again later.") and keep the control to start again.

## Not built yet

- Replacing a hook's secret without removing the hook.
- A log of calls (the dashboard shows the last failed call and says that nothing else is
  recorded), counts of what a hook allowed and denied, and a way to send a test question.
- A hook at a refresh, and claims a hook can change without a sign-in or a step-up.
