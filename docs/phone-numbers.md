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
| `sms.dailyMessageLimit` | `500` | The most messages the environment sends in one day (UTC). Once it is reached nothing is sent until the next day. 1 to 1,000,000; **no value switches it off**. See [send limits](#send-limits-and-the-daily-limit). |

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

## Send limits and the daily limit

Every message costs money, and an endpoint that texts a number of the caller's choosing is
what **SMS pumping** abuses: someone has codes sent to numbers they are paid for. So every
message goes through the limits below, all on by default, and an attack on an environment
has a fixed maximum cost: **`sms.dailyMessageLimit` messages a day**, whatever else happens.

| Limit | Counted by | Allows |
| --- | --- | --- |
| Country list | the number's calling prefix | Nothing to a country that is not on `sms.allowedCountries`. Such a request is refused before anything is counted. |
| Per user | the account that asks | One a minute, 5 an hour, and 3 numbers **new to that account** in 24 hours. |
| Per number | the number, whoever asks | One a minute, 5 an hour. |
| Per address | the request's IP address (a /64 for IPv6) | 20 an hour, whoever asks and whatever the number. |
| Per destination | the number's calling prefix (`+49`, `+1`, `+1242`) | A tenth of the daily limit in an hour: 50 at the default. |
| Per environment | the environment | A quarter of the daily limit in an hour: 125 at the default. |
| **Daily limit** | the environment, per UTC day | `sms.dailyMessageLimit` messages: 500 by default. |

- The two hourly shares follow the daily limit: raise it and they rise with it. In an
  environment that texts one country the destination's share is the one that binds, so the
  day's allowance takes at least ten hours to spend. That is time to notice.
- Every limit answers the same `rate_limited` (429) with `Retry-After`; for the daily limit
  that is the time to midnight UTC. Which limit it was is in the server's log
  (`text message not sent`, with `limit`), never in the answer.
- **When something cannot be counted, nothing is sent.** The daily limit is counted in the
  database, with the codes sent, so it holds across instances and restarts with or without
  Redis. The other limits are the rate limiter's: shared between instances only with
  `REDIS_URL` set ([self-hosting](self-host.md#settings)), and a limiter that cannot answer
  refuses the send (503).
- The per-address limit counts the address the API sees. Behind a proxy that needs
  `TRUST_PROXY=true`, or every user shares the proxy's address and its 20 an hour.
- A send the provider did not take is counted by the hourly limits and not by the day.

**Raising `sms.dailyMessageLimit` is a weakening**, like a weaker password policy: the audit
entry says `weakened: true`, the dashboard asks first, and `tula apply --yes` needs
`--allow-weaker`. Lowering it is not, and takes effect for the day under way: a day that has
already sent more than the new limit sends nothing more. A change reaches the other API
instances within 5 seconds with Redis and 30 without; until then they hold the day to the
limit they knew.

### What was sent, and what was never used

`GET /v1/admin/sms/usage?days=7` (a secret key; 1 to 30 days, UTC, today included) returns
how many codes the environment texted and how many were then entered correctly, **by
destination prefix**: a country calling prefix, never more of a number.

<!-- snippet: examples/docs-snippets/admin.ts#sms-usage -->
```ts
const { data } = await admin.call('getSmsUsage', { query: { days: 7 } })
// A destination where most codes are never entered is being texted for money.
const suspicious = data.prefixes.filter(({ sent, unused }) => sent >= 20 && unused / sent > 0.8)
```
<!-- /snippet -->

```
{ "since": "2026-10-02", "days": 7, "sent": 212, "used": 187, "unused": 25,
  "prefixes": [ { "prefix": "+1", "sent": 190, "used": 181, "unused": 9 }, … ],
  "truncated": false }
```

`prefixes` lists the destinations with the most unused codes first. People do mistype a
number or give up, so some codes are always unused; a destination where nearly all of them
are is being texted for money. Take its country off the list. The counts are kept for 90
days and hold no phone number and nothing about who asked.

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
hour, for at most three different numbers a day.

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

## What this does not stop

A number is not proven before the first message to it, so a signed-in user of your app can
have codes texted to a number that is not theirs. The limits narrow that, and do not close
it:

- One account reaches at most **three numbers a day** that are new to it, and one number
  gets at most **five codes an hour** from your app, whoever asks. Many accounts still reach
  many numbers, up to the destination's and the environment's hourly shares and the daily
  limit: those are what bound the total, and the cost.
- The owner of a number someone else had texted cannot add it themselves until its minute,
  or its hour, has passed: the allowance is the number's.
- The `rate_limited` answer tells a caller that a limit was reached. It is the same answer
  for every limit, so it does not say whether that was their own, the number's or the
  environment's; a caller who has not asked before can still infer that somebody else did.
- An attacker who spends the daily limit stops your real users from getting a code until
  midnight UTC. That is the trade the limit makes: a fixed cost, at the price of
  availability under attack. The usage counts and the log line say that it is happening.
- The limit counts messages, not money: a message to one country may cost many times one to
  another. Keep the country list short.
- Without Redis, each API instance keeps the hourly limits for itself, and forgets them
  when it restarts. The daily limit does not depend on it.

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
| `rate_limited` | 429 | A code was asked for too soon or too often (by this user, for this number, from this address, to this destination or by the whole environment), the environment's daily limit is reached, or too many wrong codes in a row; `Retry-After` says when. The server's log names the limit. |
| `service.unavailable` | 503 | A limit could not be counted. Nothing was sent. |

## Not built yet

- Signing in with a texted code.
- A real SMS provider.
- A limit in money: the daily limit counts messages, and becomes a spend ceiling when a
  provider brings prices.
- Editing the message's text.
- An email to the owner when a number is added or removed.
