# Phone numbers

A signed-in user can add **one phone number** to their account and prove it with a 6-digit
code sent by text message (SMS). The number is contact data: nobody signs in with it yet.

The reasoning, and what was left out on purpose, is in
[ADR 0037](adr/0037-phone-numbers-and-sms.md).

## Switch it on

Two things must both be true before a message is sent: the **deployment** has a way to send
one, and the **environment** allows it.

### The deployment: `SMS_PROVIDER`

| Value | |
| --- | --- |
| `none` (default) | There is no sender. No phone number is offered (`phone.enabled` is `false` whatever the environment's settings say), and a request that would send a message is answered `sms.unavailable`, with no send limit used. |
| `dev` | **Development and tests only.** Nothing is sent; messages are kept in the development SMS inbox (below). Accepted only with `ENVIRONMENT=local` and a loopback `PUBLIC_URL`. |

There is no adapter for a real provider yet: outside development, no message can be sent.
See [self-hosting](self-host.md#settings).

### The environment: the `sms` setting

| Setting | Default | |
| --- | --- | --- |
| `sms.enabled` | `false` | Whether the environment sends text messages at all. |
| `sms.allowedCountries` | `[]` | The countries a message may go to, as ISO 3166-1 alpha-2 codes in upper case (`US`, `DE`). **An empty list means nothing is sent**; there is no "all countries". |

| Where | How |
| --- | --- |
| Dashboard | **Settings**, the **Text messages** section. |
| `tula.config.ts` | `settings.sms` ([settings as code](config.md)). The country list is a set: its order is not a change. |
| Admin API | `PUT /v1/admin/settings`. |

<!-- snippet: examples/docs-snippets/admin.ts#settings-sms -->
```ts
const { data } = await admin.call('getEnvironmentSettings')
await admin.call('replaceEnvironmentSettings', {
  headers: { 'If-Match': ifMatch(data.revision) },
  body: { ...data.settings, sms: { enabled: true, allowedCountries: ['US', 'DE'] } },
})
```
<!-- /snippet -->

A number's country is read from its calling code. Countries that share one are one
destination: most `+1` numbers belong to both `US` and `CA`, so allowing either allows both.
List only the countries your users are in: every message costs money, and a short list is
what keeps someone from having codes sent to expensive destinations.

Switching the setting off, or taking a country off the list, takes effect for codes already
sent: a code asked for before the change is not honoured after it. Removing a number never
needs a message and always works.

## What the user sees

In `<UserProfile>` (`@tula/react`) a **Phone number** section appears when the environment
can text a code, or when the user already has a number:

1. **Add a phone number**: a field for the number with its country code
   (`+1 415 555 0142`). Spaces, hyphens and parentheses are fine; a number without a country
   code is refused, never guessed.
2. The code from the text message. The field is `autocomplete="one-time-code"`, and the
   message ends with a line (`@your-host #123456`) that lets a phone offer the code on your
   site only. The host is that of the **first** entry of the environment's
   `urls.allowedOrigins`: put the origin where users type the code first. The list is
   otherwise a set, so `tula diff` reports nothing when it is only reordered, although the
   message's last line then changes.
3. The number, marked **Verified**, with **Change** and **Remove**.

Adding, changing and removing ask for a recent authentication first
([step-up](methods/two-step-verification.md)): the dialog appears by itself.

The message reads `Your <app name> verification code is 123456.` The code is valid for ten
minutes and has five guesses; a new code can be asked for after a minute, five times an
hour.

## With `@tula/core`

<!-- snippet: examples/docs-snippets/core.ts#phone-number -->
```ts
// Both calls need a recent authentication: handle `auth.step_up_required` as above.
const sent = await tula.user.phone.request({ phoneNumber: '+1 (415) 555-0142' })
// sent.destination === '***42'; the code is in the text message, never in an answer
const user = await tula.user.phone.verify({ code })
// user.phoneNumber === '+14155550142', user.phoneNumberVerifiedAt is when
await tula.user.phone.remove()
```
<!-- /snippet -->

The environment's public configuration (`GET /v1/client/config`) says whether a number can
be added now, as `phone.enabled`, and nothing about which countries.

## The development SMS inbox

With `SMS_PROVIDER=dev` the server keeps the newest 50 messages in memory and answers them
at:

```
GET /v1/dev/sms/messages          every message, oldest first
GET /v1/dev/sms/messages?to=+14155550142
```

Each is `{ to, text, sentAt }`. The route exists only in the `local` tier, is not part of
the API's contract, and refuses a request that carries an `Origin` (it is for `curl` and
test runners, not for pages) or whose `Host` is not `localhost`, `127.0.0.1`, `[::1]` or a
`*.localhost` name: ask it under one of those, on whatever port. Every instance has its own inbox, and a restart empties it.

## What this does not stop yet

A number is not proven before the first message to it, and the limit of five codes an hour
is the number's, whoever asks. A signed-in user of your app can therefore have up to five
codes an hour texted to a number that is not theirs; the number's owner cannot add it
themselves for the rest of that hour; and the "too many requests" answer tells the caller
that someone asked for that number recently. Limits per destination and a ceiling on what
SMS may cost are not built yet.

## What is stored, and where a number goes

- The account's number, in E.164 form, and when it was verified. There is never an
  unverified number on an account: until the code is confirmed the number is only pending,
  on the code's own row.
- Two accounts may hold the same number. Nothing is looked up by one.
- The number is returned to its owner and to an administrator (the dashboard's user screen,
  `/v1/admin/users`). It is in no log line, audit entry, event or webhook payload: the events
  `user.phone_number_added` and `user.phone_number_removed` say only which user.

## Troubleshooting

| Code | Status | Means |
| --- | --- | --- |
| `phone.invalid` | 422 | Not a number with a country code (`+` and 8 to 15 digits). |
| `sms.disabled` | 403 | The environment's `sms.enabled` is off, or its country list is empty. |
| `sms.country_not_allowed` | 422 | The number's country is not on the environment's list. Nothing was sent. |
| `sms.unavailable` | 503 | The message could not be sent: the deployment has no sender (`SMS_PROVIDER=none`), or it failed. An earlier code still works. |
| `auth.step_up_required` | 403 | The session's last authentication is too old: step up, then repeat the call. |
| `verification.invalid_code` | 422 | A wrong code. |
| `verification.expired` | 410 | No code is pending, or it expired, was used or was replaced by a newer one. |
| `verification.too_many_attempts` | 429 | Five wrong guesses at one code: ask for a new one. |
| `rate_limited` | 429 | A code was asked for too soon or too often, or too many wrong codes in a row; `Retry-After` says when. |

## Not built yet

- Signing in with a texted code.
- A real SMS provider.
- Limits that bound what SMS can cost (per destination, per environment, a spend ceiling).
- Editing the message's text.
- An email to the owner when a number is added or removed.
