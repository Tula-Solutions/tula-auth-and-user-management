# Hooks

A hook is a signed **question** the server asks your backend before it does something. Your
answer decides whether it happens. That is the difference from a
[webhook](webhooks.md), which tells you about something that has already happened and whose
answer changes nothing.

There is one hook so far: **before a sign-up**. You register an address; when a sign-up is
about to create an account, the server posts the address being signed up to it, and you
answer allow, or deny with a message code of your own. The design and its reasons are in
[ADR 0035](adr/0035-hooks.md). What is not built yet is listed [at the end](#not-built-yet).

## Register a hook

With a secret key. An environment has one hook per point; the server makes the signing secret
and returns it **once**:

<!-- snippet: examples/docs-snippets/admin.ts#hook-register -->
```ts
const { data: hook } = await admin.call('createHook', {
  body: {
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
  -d '{"point":"before_sign_up","url":"https://api.example.com/tula/before-sign-up"}'
```

| Field | |
| --- | --- |
| `point` | `before_sign_up`. Cannot be changed afterwards. |
| `url` | Where the question is posted. `https`, no credentials, and a host that resolves to public addresses only; otherwise `hook.url_not_allowed` (422) with a fixed word in `params.reason`. Judged when it is saved and again at every call. |
| `enabled` | `true` unless given. A hook that is off is not asked: sign-ups go through as if there were none. |
| `deadlineMs` | How long the server waits for your answer. `2000` unless given, at least `100`, **never more than `5000`**. |
| `failureMode` | `deny` unless given. See [When the hook fails](#when-the-hook-fails). |

There is no `secret` field: you cannot supply one, and no later call returns it. To replace a
secret, remove the hook and register it again (for that moment there is no hook).

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
(`webhook-id`, `webhook-timestamp`, `webhook-signature`), signed with the hook's secret:

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

| Field of `data` | |
| --- | --- |
| `email` | The address the account would be created for, in lower case. It has been **proven** by the time you are asked: by an emailed code, or by a provider that asserts it verified. |
| `method` | How the sign-up is made: `password`, `passwordless`, or `oauth_google`, `oauth_github`, `oauth_apple`. |
| `client` | The kind of client the sign-up started from (`web`, `ios`, `android`, …). |
| `ipAddress` | The address the request came from, as the server knows it, or `null`. Behind a proxy this is right only where the deployment says how the address is known ([self-host.md](self-host.md)). |

That is all of it. A question never holds a password, a code, a token, a name, a user agent
or anything of a provider's profile. It is not an event (it has no `actor` and no `target`),
and it is never stored: not in the outbox, not in the audit log.

## The answer

A `200` whose body is **exactly** one of:

```json
{ "decision": "allow" }
```

```json
{ "decision": "deny", "code": "disposable_email" }
```

`code` is optional and is yours: lower-case letters, digits and underscores, at most 64
characters. The client gets it back and your app turns it into words
([What the user sees](#what-the-user-sees)).

Anything else is **not an answer** but a failed call: a status that is not 2xx (whatever its
body says), a redirect, a body over 1 KiB, a body that is not JSON, another `decision`, a
`code` beside an `allow`, **any other key**, or no answer inside the deadline. An unknown key
is not ignored: a later version may give one meaning, and the server will not act on half of
an answer.

A complete receiver:

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

`verifyHook` checks what `verifyWebhook` checks (the signature in constant time, a timestamp
within five minutes) and that the body is a question: it refuses an event, and
`verifyWebhook` refuses a question, whatever secret signed either. Pass it the body exactly as
it arrived. **Never answer `allow` to a request that did not verify.**

Answer quickly. The person signing up is waiting, a question is asked once and never
repeated, and at the deadline the server stops listening.

## When the hook fails

A call fails when your endpoint cannot be reached, answers too late, or answers with
something that is not an answer. What happens then is the hook's `failureMode`:

| `failureMode` | A failed call | |
| --- | --- | --- |
| `deny` (default) | The sign-up is refused with `hook.unavailable` (503). | A check that is down lets nobody in. Your sign-ups depend on your endpoint being up. |
| `allow` | The sign-up goes through as if there were no hook. | Your sign-ups do not depend on your endpoint, and **whoever can make it fail, or wait until it does, signs up unchecked**. |

`allow` costs exactly the protection the hook is for, at the moments an attacker would choose.
That is why choosing it is **recorded as a weakening**: the audit entry of the registration
or the change carries `weakened: true`. So does switching a hook off, and removing one that
is on.

Every account that was let through because the hook failed says so: its `user.created` event
and audit entry carry `hookBypassed: true`. To find them afterwards, list the audit log with
`action=user.created` and look for it; to learn of one as it happens, subscribe a
[webhook](webhooks.md) to `user.created`.

**Seeing that a hook is failing.** The hook's read answer has `lastFailedAt` and
`lastFailureReason`, one of the server's fixed words: `timeout`, `connection_failed`,
`resolve_failed`, `address_not_allowed`, `scheme_not_allowed`, `invalid_url`,
`invalid_request`, `response_too_large`, `status_not_ok` (not a 2xx), `answer_invalid` (not
exactly an answer) or `secret_unreadable` (the server could not open the hook's secret:
`TULA_MASTER_KEY` changed). It is the last failure, whenever that was; a denial is not a
failure. The server also logs one line per failed call, with ids and the reason. Nothing of
what your endpoint said is kept.

## Where the hook is asked, and where it is not

**Asked**, once, when an account is about to be created by a sign-up:

- a sign-up with a password, after the emailed code was accepted;
- a sign-up without a password, at the same step;
- a first sign-in with Google, GitHub or Apple that would create an account.

**Not asked:**

- when a sign-up **starts**, or for a wrong code. A start answers the same for an address that
  has an account and one that has none; asking you there would let anyone measure which is
  which. You are asked only once the address is proven;
- for an address that already has an account (a provider sign-in that signs in, or connects
  to, an existing account);
- when an **administrator creates a user** through the admin API or the dashboard. That is
  your own act;
- on sign-in. (A hook before a session is created is a later step.)

The hook is read when the account is about to be created, so one that was registered,
changed, switched off or removed while a sign-up was under way applies as it is at that
moment. An environment's hooks are called at most 600 times a minute; past that the request
is refused with `rate_limited`.

## What a hook cannot do

It can allow or deny. It cannot mark an address verified, skip a second factor, choose which
user is created, set a name, or add anything to an account or a session. An answer that tries
(any key beyond `decision` and `code`) is a failed call. After an allow the sign-up continues
exactly as it would have with no hook, second factor included.

## What the user sees

A denied or failed sign-up creates nothing: no user, no session. The attempt has ended, so
the client starts a new sign-up to try again.

| Error code | Status | |
| --- | --- | --- |
| `hook.denied` | 403 | Your endpoint said no. `params.code` is the code you answered with, if any. |
| `hook.unavailable` | 503 | The call failed and the hook refuses on failure. Not a refusal of this person: "try again later". |

With `@tula/core` both are a `TulaError`; read `error.params?.code` to show your own message
for a denial. The `@tula/react` components show the default message for the code on the
code screen ("This sign-up was not allowed." / "Sign-up is unavailable right now. Try again
later.") and keep the control to start again.

## Not built yet

- Hooks before a session is created and before a token is issued.
- Replacing a hook's secret without removing the hook.
- Hooks in `tula.config.ts` and in the dashboard.
- A log of calls, and a way to send a test question.
