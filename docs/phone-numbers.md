# Phone numbers

A signed-in user can add **one phone number** to their account and prove it with a 6-digit
code sent by text message (SMS). The number is contact data. Where an environment switches
the [texted sign-in code](methods/sms-code.md) on, which is off by default, it is also a
way to sign in to that account.

The reasoning, and what was left out on purpose, is in
[ADR 0037](adr/0037-phone-numbers-and-sms.md).

## Switch it on

Two things must both be true before a message is sent: the **deployment** has a way to send
one, and the **environment** allows it.

### The deployment: `SMS_PROVIDER`

| Value | |
| --- | --- |
| `none` (default) | There is no sender. No phone number is offered (`phone.enabled` is `false` whatever the environment's settings say), and a request that would send a message is answered `sms.unavailable`, with no send limit used. |
| `dev` | **Development and tests only.** Nothing is sent; messages are kept in the development SMS inbox (below). Accepted only with `ENVIRONMENT=local` and a loopback `PUBLIC_URL`: the server refuses to start with it in `dev`, `staging` and `prod`. |
| `twilio` | Messages are really sent, through Twilio. Needs the `TWILIO_*` variables: an account, one way to authenticate and one sender. Allowed in every tier. |

Twilio is the one real provider. Before a message reaches a phone the sender has to be
registered with Twilio, Twilio has to be allowed to send to the country, and the account has
to be more than a trial: the [Twilio checklist](providers/twilio.md) has the steps, and
[self-hosting](self-host.md#text-messages-with-twilio) the variables.

**"Sent" means the provider accepted the message, not that it arrived.** No delivery
receipt is read. A message a carrier drops after Twilio took it is a sent message here, and
its code is one that is never used.

`tula doctor` says when the two halves disagree: its `sms_sender` line warns when an
environment has text messages on and the deployment has no sender, and fails when that
environment also signs in with a texted code.

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
- **The limits are counted in the order of the table, a user's own first, and a request a
  later limit refuses has still been counted by the earlier ones.** A user who asks while
  the destination's hour, the environment's hour or the day is spent is refused, and has
  used their minute, one of their 5 tries of the hour and, for a number new to them, one
  of their 3 new numbers of the day. That is on purpose: counted the other way round, one
  account repeating a refused request would spend the allowance every user shares. The
  tries come back by themselves, within the minute, the hour and the day.
- The per-address limit counts the address the API sees. Behind a proxy that needs
  `TRUST_PROXY=true`, or every user shares the proxy's address and its 20 an hour.
- A send the provider **refused** (with Twilio, a 4xx) is counted by the hourly limits
  and not by the day. A send whose outcome is **unknown** (a timeout, a connection that
  failed, or the provider's own error: with Twilio, any 5xx) is counted by both: the message may have gone out and been billed, and the daily
  limit counts what may have been spent. The user is told `sms.unavailable` either way.
  So while the provider cannot be reached, or answers with errors of its own, every try uses one of the day's messages
  ([what the log says](providers/twilio.md#when-twilio-does-not-take-a-message)).

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

The message reads `Your <app name> verification code is 123456.` unless the environment
has [its own wording](#your-own-wording). The code is valid for ten
minutes and has five guesses; a new code can be asked for after a minute, five times an
hour, for at most three different numbers a day.

## Your own wording

An environment can write the sentence of each text message itself: `sms.templates` in the
settings, keyed by the kind of message. The dashboard's **Messages** screen edits it with
a preview ([dashboard](dashboard.md)); the admin API and `tula.config.ts` take the same
document.

```json
{
  "sms": {
    "templates": {
      "phone_verification": { "text": "Welcome to {{appName}}. Your code is {{code}}" },
      "sign_in": { "text": "Use {{code}} to sign in to {{appName}}" }
    }
  }
}
```

| Kind | Sent when | Must contain | May contain |
| --- | --- | --- | --- |
| `phone_verification` | A signed-in user adds or changes their number. | `{{code}}` | `{{appName}}` |
| `sign_in` | A sign-in by texted code was asked for a number that signs in. | `{{code}}` | `{{appName}}` |

A kind with no template is sent in the built-in words. A template is **one sentence**:
the server adds the last line (`@your-host #123456`) itself, after a blank line, exactly
as it does for the built-in text, and a template cannot write or replace that line.

### What a template is refused for

A save with a template that breaks one of these is refused with 422, the field named
(`sms.templates.<kind>.text`), and nothing is stored.

| Refused | Why |
| --- | --- |
| No `{{code}}`, or `{{code}}` or `{{appName}}` written twice | The message carries one code. |
| More than 140 characters | What a message can cost (below). |
| A line break or a control character | A template is one line. |
| A character a reader cannot see (a zero-width space, a text-direction control) | What is sent is what you saw when you saved it. |
| A brace that is not part of a placeholder, or a placeholder this kind does not have | The language is `{{name}}` and nothing else. |
| A letter or a digit directly beside a placeholder (`code{{code}}`) | The code stands alone, for a reader and for a phone. |
| Four or more digits in a row | Only the code looks like a code. `Call 0800 1234` is refused too. |
| A word that starts with `@` or `#` | That is how the last line is recognised: `@other-host #123456` would offer the code on another site. `Ask @support` is refused too. |
| Something that reads as a link, an address or a domain name | A phone turns it into a link, beside a sign-in code. The rule is the [emails' own](email-templates.md#no-link-of-your-own). |
| A text that does not start with a letter of its own | A message starts with a word, never with the code or with the app's name. |

The rules judge the template's own text. The app's name is put in as it is, so one more
check runs when a message is made: if the last six digits of the finished message would
not be the code (an app named `Acme 123456`, in an environment with no allowed origin),
the **built-in text is sent instead** and the API's log says so, with the kind and the
word `code_not_last`. A template is never the reason a message is not sent.

### Length and cost

A text message is billed by the segment: 160 characters of the GSM alphabet in one, 153
each when it takes several. The 140-character cap is chosen so that the whole message
(your sentence with the longest app name, a blank line, the last line with the longest
host) is at most **three segments**, and at most two with a host of up to 102 characters.
The built-in message with a short name and host is one.

One character outside the GSM alphabet (Cyrillic, Arabic, an emoji, a curly quote), in
the template or in the app's name, makes a carrier send the whole message as Unicode: 70
characters in one segment, 67 each in several, and the same worst case is seven segments.
The preview states the segments of its sample. That number is an estimate from the
standard alphabet; a carrier may count one more at a boundary.

`sms.dailyMessageLimit` counts messages, not segments.

### Seeing a wording before it is saved

`POST /v1/admin/message-preview` returns the text the server would send for a draft, with
sample values (the code `123456`) and the environment's saved app name and first allowed
origin. It stores nothing, sends nothing and records nothing.

```json
{ "channel": "sms", "kind": "sign_in", "template": { "text": "Use {{code}} to sign in." } }
```

The answer holds `text`, `segments` (`encoding`, `units`, `segments`) and `unused`, which
names a part the server would replace with the built-in wording and why. A draft that a
save would refuse is refused here the same way, the field under `template.`. Without
`template` the answer is the built-in wording. The route previews an email too
(`"channel": "email"`, with `subject` and the text part): see
[email templates](email-templates.md#seeing-a-template-before-it-is-saved). It is limited
to 120 calls a minute per environment.

### What is recorded, and who writes it

A change is recorded as the key `sms.templates.<kind>.text`, never the words. A change of
wording takes effect within the settings cache's 5 to 30 seconds on other instances.
Changing a template is not treated as a weakening and is not asked about: what it can say
is bounded by the table above. It remains true that whoever can change the settings
writes the sentence your users read beside their code. A template can say something
false; the rules judge its form, not its meaning.

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

## Signing in with the number

With `signIn.methods.smsCode` on, a user who has added a number can sign in with a code
texted to it: [Texted code](methods/sms-code.md) has the screens, the calls and the error
codes. What it changes about a number on an account:

- **The number becomes a way in.** Whoever receives its messages can sign in to the
  account. Such a session cannot change how the account is protected (that needs a step-up,
  which a texted code is not), and its token says `amr: ["sms"]`.
- **Only a number one account holds signs in.** Two accounts may still hold the same
  number; then it signs in neither, and neither user is told.
- **A number signs in for 365 days after it was last proven.** Each sign-in with a texted
  code counts as proving it again, so "verified" on the account moves forward. After a year
  without one, the user removes the number and adds it again.
- **A sign-in's messages share the limits below** with the messages that add a number: one
  a minute and five an hour to a number, whoever asks. A request for a number nobody can
  sign in with is counted by the hourly limits like a real one, and sends nothing.
- Switching it on, and adding a country while it is on, is a weakening: the dashboard asks
  first and `tula apply --yes` needs `--allow-weaker`.
- **A code has five tries, and a right one that could not go on still uses one.** Every
  submission is counted before the code is compared. Where the account's email address is
  not verified, a code is emailed there after the texted one was found right; if that
  email cannot be sent (the relay is down: an error) or was asked for less than a minute
  ago (`rate_limited`, with the time to wait), the texted code is **not** spent, but that
  try is. Wait out the minute before submitting it again: five submissions and the code is
  dead, right or not, and a new one has to be texted.
- **A locked-out number is told "wrong code", not "wait".** Guesses for a number are
  counted whoever makes them: five are free, then each failure makes the number wait,
  from 30 seconds, doubling, up to 15 minutes at a time; the count is forgotten after an
  hour without a failure and cleared by a success. While the number waits, every code is
  answered `auth.invalid_credentials`, the right one included. This differs from the
  password and the emailed code, which answer `rate_limited` with `Retry-After` while
  locked. The reason is uniformity only (every failure of this step is the one generic
  answer); it hides nothing, since a number nobody holds locks at the same count. The cost
  is that the person is not told to wait, nor for how long;
  a new code does not help until the wait is over.

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
- Two accounts may hold the same number. An account is looked up by number in one place:
  a sign-in with a texted code, where the environment has that on.
- The number is returned to its owner and to an administrator (the dashboard's user screen,
  `/v1/admin/users`). It is in no log line, audit entry, event or webhook payload: the events
  `user.phone_number_added` and `user.phone_number_removed` say only which user.
- With `SMS_PROVIDER=twilio` the number and the message's text, code included, go to Twilio,
  which keeps them in its own message log. That is outside Tula: how long Twilio keeps a
  message is set in Twilio.

## Troubleshooting

| Code | Status | Means |
| --- | --- | --- |
| `phone.invalid` | 422 | Not a number with a country code (`+` and 8 to 15 digits). |
| `sms.disabled` | 403 | The environment's `sms.enabled` is off, or its country list is empty. |
| `sms.country_not_allowed` | 422 | The number's country is not on the environment's list. Nothing was sent. |
| `sms.unavailable` | 503 | The message could not be sent: the deployment has no sender (`SMS_PROVIDER=none`), the provider refused it, or the provider gave no answer or failed itself (the message may then arrive all the same; its code is not accepted). An earlier code still works. The answer says no more than that; the API's log has the provider's reason (`twilio did not take a text message`: [what the fields mean](providers/twilio.md#when-twilio-does-not-take-a-message)). |
| `auth.step_up_required` | 403 | The session's last authentication is too old: step up, then repeat the call. |
| `verification.invalid_code` | 422 | A wrong code. |
| `verification.expired` | 410 | No code is pending, or it expired, was used or was replaced by a newer one. |
| `verification.too_many_attempts` | 429 | Five wrong guesses at one code: ask for a new one. |
| `rate_limited` | 429 | A code was asked for too soon or too often (by this user, for this number, from this address, to this destination or by the whole environment), the environment's daily limit is reached, or too many wrong codes in a row; `Retry-After` says when. The server's log names the limit. |
| `service.unavailable` | 503 | A limit could not be counted. Nothing was sent. |

## Not built yet

- Signing up with a phone number; a texted code as a second step, a step-up or a recovery.
- A switch for the texted sign-in code in the dashboard: it is the settings' key
  `signIn.methods.smsCode` for now.
- A second provider: Twilio is the only one.
- Delivery receipts: nothing reads whether a message Twilio accepted reached a phone.
- A limit in money: the daily limit counts messages, and becomes a spend ceiling when a
  provider brings prices.
- A template for the message's last line, a template per language, and how long the code
  lasts as a placeholder.
- Sending a draft to a number to try it.
- No message in an environment's own words was sent to a real phone while this was built:
  that a phone still offers the code from one was not seen. The last line is unchanged.
- An email to the owner when a number is added or removed, or when their number stops
  signing in because another account proved it.
