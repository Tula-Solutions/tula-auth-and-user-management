# ADR 0037: A phone number on an account, and how text messages are sent

- **Status:** accepted (started: the first of several steps; see "What is not built")
- **Date:** 2026-10-08
- **Ticket:** TULA-11 (phase 2); TULA-28 (send limits); TULA-29 (Twilio)

## Context

Until now a user was reached at one place, an email address. Signing in with a texted code,
and a phone as a second place to reach someone, both need the same things first: a way to
send a text message, a setting that says whether an environment sends any and where to, a
number on the user, and a code that proves the number is theirs.

SMS is unlike email in three ways that shape this decision. A message costs money, and the
price depends on the country, so "send to whoever asks" is a way to run up someone's bill
(toll fraud). A phone number is personal data that identifies a person more durably than an
address. And a texted code is read on a device that may not be the one that asked, which is
what makes it phishable.

This ADR is the tracer: the smallest path through all of it. A signed-in user adds a number
and proves it with a code; in development the message lands in a local inbox.

## Decision

### The sender is a port, and it fails closed

`SmsSender` (`apps/api/src/ports/sms-sender.ts`) has one method, `send({ to, text })`, and
throws `SmsSendError` with a fixed word (`not_configured`, `failed`). Four adapters, chosen
in `container.ts` by `SMS_PROVIDER`:

| `SMS_PROVIDER` | Adapter | |
| --- | --- | --- |
| `none` (the default) | `adapters/sms/unconfigured.ts` | Every send throws `not_configured`. Nothing is logged by it and nothing is kept. |
| `dev` | `adapters/sms/dev.ts` | Sends nothing. Keeps the newest 50 messages in the process's memory (the development inbox). |
| `twilio` | `adapters/sms/twilio.ts` | The one that really sends: one request to Twilio's Messages resource per message. See "Twilio" below. |
| (tests) | `adapters/memory/sms-sender.ts` | `createTestDeps().sms`: an outbox a test reads, and a switch to make sends fail. |

There is no adapter that falls back to another, and no tier in which a message that could
not be sent is treated as sent: the caller gets `sms.unavailable` (503).

A sender says whether the deployment has one at all (`SmsSender.configured`; `false` only for
`none`). Without one, the client configuration's `phone.enabled` is `false` whatever the
settings say, so no screen offers a number that could not be added; and a request that
would send is refused (`Sms.requireSender`) after the settings were asked and **before any
send limit is counted**, so a try that can only fail uses up nobody's allowance. The
diagnostics say when an environment has text messages on in such a deployment (the
`sms_sender` check, added with Twilio: below).

Every adapter runs one behaviour suite (`adapters/sms-sender.suite.ts`, `smsSenderSuite`):
what `configured` says, that a message it takes resolves with nothing, and that one it does
not take is the port's error with a fixed word and nothing of the number or the text. The
two that keep messages also run `smsInboxSuite`.

**The development inbox is readable only in the `local` tier.** It hands every code to
whoever asks, so it is gated like the mock OAuth provider ([ADR 0026](0026-oauth.md)):
`env.ts` refuses to boot with `SMS_PROVIDER=dev` unless `ENVIRONMENT=local` **and**
`PUBLIC_URL` is a loopback address; `container.ts` builds the inbox only in that tier and
warns at every boot; `createApp` mounts `GET /v1/dev/sms/messages` only when the tier is
`local` and there is an inbox, and the handler checks both again. The route is for tools:
a request with an `Origin`, or one a browser marks as coming from another site, is refused,
so a page open beside a local API cannot read its codes. Neither check stops a page that
reaches the port by DNS rebinding (it is same-origin with itself), so the request's `Host`
header must also name this machine (`isLoopbackHost`, the rule `PUBLIC_URL` is judged by, on
any port): otherwise 403 with an empty body. It is not in the OpenAPI document.
Each instance has its own inbox; a reader of several instances asks each.

**A code the inbox shows is one that can be used** (TULA-71). A sign-in's message is handed
to the sender before its token is stored ("Signing in with a texted code", below), and the
development sender takes a message by keeping it where the route reads it: a runner that
polled the inbox read the code and presented it before the token's write had finished, and
the right code was answered `auth.invalid_credentials`. It failed CI's two-instance
conformance job now and then, in the scenario where the next step expects another answer.
So the port's `send` takes, beside the message, what the caller knows about it
(`SmsSendContext`), and for a detached send `Sms.sendCode` gives it `usable`: a promise
that resolves `true` once `onTaken` has finished and `false` when the sender did not take
the message or the token could not be stored. The development inbox answers `send` at once,
as a provider would, and makes such a message readable only when `usable` says `true`. On
`false` it is never readable: a reader waits for a code and gives up, and the log has
"texted code not stored". Showing it would be the same wrong answer again, and a message
nobody can use is no message a test should find. A message whose send is waited for (a
phone number's code, a second factor's) carries no `usable` and is readable when it is
handed over; its token is stored before its request is answered.

What this does not change: when the token is stored (after the sender's answer, never
before), that the request does not wait for the sender, and what a sender that really sends
does. Twilio's adapter does not read the context, sends the same request and answers as
before; `smsSenderSuite` hands every adapter a `usable` that never resolves and expects its
answer all the same. A decoy hands no message to any sender, so the inbox shows nothing for
it before or after. The alternatives were weaker: storing the token first, or waiting for
the sender in the request, undo the two rules above; a submission tried again spends one
of five guesses and softens what a scenario asserts; a sleep in the runner only makes the
gap less likely. The memory sender used by the unit tests keeps what it is handed, at
once: those tests wait with `Sms.settled()`, and the browser tests' fixture waits for it
before it answers `/__test/sms`.

### The number on a user

A user has one optional `phoneNumber` in E.164 form and `phoneNumberVerifiedAt`. The
database holds both or neither (`users_phone_number_whole`): **there is no unverified number
on an account**. A number is stored only by the confirmation of a code.

- Validation is strict (`parsePhoneNumber` in `@tula/contract`): spaces, hyphens and
  parentheses are taken out, and what is left must be `+` and 8 to 15 digits. A national
  number, a `00` prefix or anything else is `phone.invalid`. A country is never guessed:
  guessing is how a code reaches someone else's phone.
- **A number is not unique.** Two accounts in one environment may hold the same one. Uniqueness
  would tell whoever adds a number whether someone else has it. When this was first decided
  nobody signed in with a number and nothing was looked up by one; signing in by SMS
  (TULA-27) decided it again and kept it: an account is now looked up by number in one
  place (`Phone.signInHolder`), and a number two accounts hold signs in
  neither ("Signing in with a texted code", below).
- It is personal data. It is returned to its owner (`GET /v1/client/me`) and to an
  administrator (`/v1/admin/users`), and nowhere else: not in a log line, an audit entry, an
  event payload, an error, a rate-limit or lockout key (those hold a keyed hash) or an
  `@tula/mcp` result.

### The settings

`sms` in the environment's settings ([ADR 0018](0018-environment-settings.md)):

- `sms.enabled`, default `false`.
- `sms.allowedCountries`, default `[]`: ISO 3166-1 alpha-2 codes in upper case, each once.
  **Empty means nothing is sent**, also with `enabled: true`. There is no "all countries".
- `sms.dailyMessageLimit`, default `500` (added by TULA-28): the most messages the
  environment sends in one UTC day, 1 to 1,000,000. See "Send limits and the daily limit".

`Settings.requireSms(deps, tenant, phoneNumber?)` is the one place they are checked, and
every step that sends a code by SMS or accepts one calls it first, before anything is
counted, spent or sent: a code asked for before SMS was switched off, or before its country
left the list, is not honoured after. A number's country comes from its calling code
(`COUNTRY_CALLING_PREFIXES`, plain data in the contract). Countries that share a prefix
are one destination: a `+1` number outside the area codes the table gives to one country
belongs to both `US` and `CA`, so allowing either allows both, while `+1 242` is `BS` alone.
A calling code the table does not know is refused.

**Switching SMS on, or adding a country, is not a weakening** in the sense of
`settingsWeakenings`. A weakening removes a protection an account has. This adds a place
codes can go, for a number its owner must prove while signed in and recently authenticated;
nothing signs in with it. That holds **while no texted code signs anyone in**. Where one
does, or begins to with the change, it is a weakening, listed under
`signIn.methods.smsCode` or `sms.allowedCountries` ("Signing in with a texted code",
below). **Raising
`sms.dailyMessageLimit` is a weakening** (below): it protects no account, it bounds what
abuse can cost the operator, and a change that enlarges that is asked about like the others.
A third case was added with the dashboard's screen (2026-10-09, TULA-54): where
`mfa.smsCode` is on and `mfa.policy` is `required` after the change, switching text
messages on or allowing a first country is listed as `mfa.smsCode`, and a country added
where a texted code could already be that second step as `sms.allowedCountries`
([ADR 0025](0025-mfa.md), "Addendum (step 2.4)"). Outside those two uses of a texted code
the sentence above stands: SMS switched on, or a country added, is not a weakening.

The hourly shares of the daily limit (`SMS_PREFIX_HOURLY_SHARE`,
`SMS_ENVIRONMENT_HOURLY_SHARE`) and the function that applies them (`smsCostLimits`) live
in the contract's `phone.ts` since the same change, and `Sms.limitsOf` calls it: the
dashboard shows an operator what a daily limit allows in an hour, and a second copy of the
arithmetic in a screen would drift from what a send is held to. They are still not
settings.

The public client configuration says one thing, `phone.enabled`: whether a number can be
added now (on, with at least one country, in a deployment that has a sender). It never lists the countries.

### Adding, confirming and removing

Three routes under `/v1/client/me/phone`, each behind `publishableKey()`, a per-IP limit of
its own, `sessionAuth()` and `requireRecentAuth()`:

| Route | |
| --- | --- |
| `POST /v1/client/me/phone` | Texts a code to the number. Answers the masked number (`***42`) and when the code expires. |
| `POST /v1/client/me/phone/verify` | Confirms the pending number with the code. Answers the user. |
| `DELETE /v1/client/me/phone` | Removes the number. `204` whether or not there was one. |

Removing needs no SMS and works with SMS off: a user must always be able to take their
number back.

**The pending number lives on the code's verification token** (`destination`), not on the
user and not in a table of its own. Asking again replaces the pending number; the account's
own number is untouched until a code is confirmed, and then replaced. The token is stored
after the message was sent, so a send that fails leaves an earlier code working.

**The code** ([ADR 0007](0007-verification-codes.md)) is six digits, valid ten minutes, with
five guesses, stored as a keyed hash. Its purpose is `phone_verification` and it is honoured
for nothing else. The hash also covers the user's id and the number, so a code proves that
number for that user and nothing else, even if a row were moved or rewritten.

**Guesses are counted under the existing lockout** (`deps.lockout`, `CREDENTIAL_LOCKOUT`),
before the code is looked at, and cleared by a success. The key is per user and **its own**
(`phone_code:<environment>:<user>`), not `Mfa.stepUpLockKey`: whoever holds a session can
always succeed here with a phone of their own, and a success clears the key it counted
under, so a shared key would let a phone confirmation reset the budget of guesses at the
account's password.

**Send limits are not this module's.** `Phone.request` tells `Sms.sendCode` who asks, from
which address, and whether the number is new to them; every limit is there (next section).

Both changes are recorded in the same transaction as the write
(`user.phone_number_added`, `user.phone_number_removed`). Their event payload is empty: the
target is the user, and the number is in neither the event nor the audit entry.

### The message

Written in one place, `modules/sms/templates.ts`:

```text
Your Northline verification code is 123456.

@app.northline.app #123456
```

- It names the app. The name is operator input that reaches a subscriber's phone: it goes
  through `smsAppName` (one line, nothing invisible, the default name when nothing printable
  is left).
- The last line is the origin-bound one-time-code format: a browser or operating system that
  knows it offers the code only on that site. The host is that of the environment's **first**
  allowed origin, never anything a request said. With no allowed origin the line is left out.
  The list is a set everywhere else (`tula diff` shows nothing for a reordering), so this is
  the one reader of its order: accepted and documented, until a setting names the host.
- It starts with a word, and the code is its last run of six digits.
- With the longest app name the settings accept it is one GSM-7 segment.
- It says nothing of when the code expires: the sentence would not fit one segment beside a
  long name, and the form that asked says it.

### Clients

- `@tula/core`: `client.user.phone.request({ phoneNumber })`, `.verify({ code })`,
  `.remove()`. No rule about numbers or countries is in the client.
- `@tula/react`: a "Phone number" section in `<UserProfile>`, through `useStepUp()`, shown
  when `phone.enabled` or the user has a number. The code field is
  `autocomplete="one-time-code"`.
- Dashboard: the number on a user's screen; a "Text messages" section in the general
  settings.
- `@tula/mcp`: `get_settings` names `sms`; a user's number is not in any projection.
- Conformance: an `smsCode` step reads a code from the development inbox; a scenario with
  one sets `needsSmsInbox` and is skipped by a target without an inbox
  (`CONFORMANCE_SMS_INBOX_URLS`).

### Send limits and the daily limit (TULA-28)

An endpoint that texts a number of the caller's choosing is what SMS pumping abuses: the
attacker is paid per message to numbers they control, and the bill arrives after the attack.
The defences are all on by default and all in one place.

**One send path.** `Sms.sendCode` is the only function that calls the sender, and everything
that decides whether a message goes is in it, in this order. A message refused at one step
is counted by none of the later ones:

1. `Settings.requireSms`: SMS on, the number's country on the list. A number that is never
   sent to is counted nowhere.
2. `Sms.requireSender`: the deployment has a sender.
3. The limits the rate limiter keeps, narrowest first, so that hammering one number cannot
   spend everybody's allowance with tries that send nothing:

   | Limit | Key | Allows |
   | --- | --- | --- |
   | Asker | `sms_asker_cooldown:`, `sms_asker:` + environment and the asker's id | 1 a minute, 5 an hour |
   | Asker's new numbers | `sms_asker_new_number:` + the same | 3 in 24 hours |
   | Number | `sms_number_cooldown:`, `sms_number:` + environment and a keyed hash of the number | 1 a minute, 5 an hour |
   | Address | `sms_address:` + environment and a keyed hash of the address bucket | 20 an hour |
   | Destination prefix | `sms_prefix:` + environment and a keyed hash of the prefix | a tenth of the daily limit an hour |
   | Environment | `sms_environment:` + environment | a quarter of the daily limit an hour |

4. The daily limit: `sms.dailyMessageLimit` messages per environment per UTC day.
5. The send.

Every refusal is the same `rate_limited` with a wait; which limit it was is one log line
(environment and the limit's fixed word, a warning for the three that bound cost).

**Narrow limits are counted first, and a send a wide limit refuses has still been counted
by them.** A limit is counted when it is reached. So a user turned away by the
destination's hour, the environment's hour or a spent day has used their minute, one of
their five tries of the hour and, for a number new to them, one of their three new numbers
of the day, for a message that was never sent. That is accepted. The other order (the wide
limits first) would count every try against the allowance the whole environment shares
before anything asked whether this asker may try at all, and one account repeating a
refused request would spend the destination's hour and the environment's for everyone. Nor
is a narrow count given back when a wide limit refuses: a refund is a second write that
can fail, and it would make a spent day a way to try without a limit. What it costs a real
user is small and passes by itself: a minute, and tries that come back within the hour or
the day, on a day when nothing would have been sent to them anyway. A test named for it
pins the order (`modules/sms/service.test.ts`, "narrow limits are counted before wide
ones").

**Keys hold ids and keyed hashes.** The number, the address and the prefix are each an
HMAC (`~/lib/keyed-hash`, purpose `sms-send-limits`) that also covers the environment, so
nothing in Redis is a number or narrows one down, and no value can be followed from one
environment to another. The asker is a user id for a signed-in user's request. For a
sign-in it is not the attempt's id, which anyone mints by starting an attempt: it is a keyed
hash of the environment and the identifier the attempt was started with ("Signing in with a
texted code", below).

**A destination prefix is the calling prefix the country list matched** (the contract's
`phoneNumberPrefix`: the longest entry of `COUNTRY_CALLING_PREFIXES`), so what is limited and
counted is exactly what can be allowed or left out. A finer prefix (the first six digits,
which is how number ranges are sold) was considered and not taken: it tells an operator
more, but it is a part of a number in a table and in an answer, and the remedy an operator
has is the country list either way. With prices and a provider's own range data (TULA-29)
it can be revisited.

**A number new to the asker** is one their last code was not texted to. Three a day keeps
one account from working through other people's numbers; it is the narrowing of the gap
below that needs nothing from the number's owner.

**The daily limit is counted in messages, in the database.** There are no prices before a
provider exists (TULA-29), so it is a count: the fixed maximum is `dailyMessageLimit`
messages a day, and the operator knows their dearest allowed destination. It is not counted
in the rate limiter, because that is per instance without Redis and forgets on a restart,
and a ceiling that multiplies with the number of instances is not one. The count is the
day's rows of `sms_code_counts`, added up; reading it and adding the message about to be
sent are **one step of the usage store** (`SmsUsageStore.takeFromDay`), before the send and
never during it. A message the sender then **said it did not take** is counted back out
(`recordNotSent`); if that write fails the count stays one too high, which errs on the side
of sending less. A send that ended with no answer either way stays counted ("What counts as
sent, and which way the count errs", below).

**The take is one transaction on one connection, under a transaction-level advisory lock,
and not under the environment lock.** The first version took `deps.environmentLock` around
a read and a write. That lock's holder keeps a pool connection for the whole call (a
session-level advisory lock) while the queries inside it need a second connection from the
same pool, which has ten and no connection timeout. For the administrator's rare writes it
was built for that is fine. A send is a request any signed-in user makes: with ten sends
at once in ten environments every connection is held by a holder waiting for another, and
none ever comes. So the take opens the tenant's transaction, takes
`pg_advisory_xact_lock(SMS_DAY_LOCK_NAMESPACE, hashtext(environment id))`, adds the day up,
inserts or increments when the sum is below the limit, and commits, which releases the
lock. It holds nothing while it waits for anything but its own turn, and waits for that at
most five seconds (`lock_timeout`, set for the transaction), after which it fails and the
message is not sent.

*The key cannot be one a session-level lock has.* Session-level and transaction-level
advisory locks are one number space, and every key `withAdvisoryLock` is given (the job
locks, the environment locks) begins with `ADVISORY_LOCK_NAMESPACE` (`tula` as an int4).
This one begins with `SMS_DAY_LOCK_NAMESPACE` (`smsd`), a different first integer, so no
second integer makes the two equal; both constants are in `packages/db/src/advisory-lock.ts`
and a test holds them apart. The second integer is the database's own `hashtext` of the
environment id, so every instance computes the same one. Two environments whose ids hash
alike take turns with each other: a wait, and no wrong count.

**Everything fails closed.** A limiter that cannot count and a count that cannot be taken
(the database unreachable, the turn not had in time) each answer `service.unavailable`
(503), and nothing is sent. No rule here uses `whenUnavailable: 'allow'`.

**The hourly shares are computed from the one setting** (`Sms.limitsOf`), so an operator
has one number to choose and cannot set an hour above the day. A value that is not a whole
number of at least one reads as one.

**The setting has no off, and raising it is a weakening** (`settingsWeakenings`:
`sms.dailyMessageLimit`): the audit entry says `weakened: true`, the dashboard asks first,
`tula apply --yes` needs `--allow-weaker`. Lowering it is not. No value removes it: an
operator who wants no limit in practice sets a high one, and is asked.

**The settings cache and the limit.** Settings are cached per instance for up to 5 seconds
with Redis and 30 without (ADR 0018). The limit's safety does not rest on a change being
seen everywhere at once, for two reasons. The *count* is never cached: every instance adds
to the same rows, each in its environment's turn. And what is cached is only the bound it is held to:
after a limit is lowered, another instance may hold the day to the old, higher limit for
that long, and after it is raised, to the old, lower one. So the most a day can send is the
highest limit that was configured during it, plus nothing.

**Codes sent and never used.** `sms_code_counts` has one row per environment, UTC day and
destination prefix: `sent` and `used`. A code is counted as used by the step that accepts
it (`Sms.recordUsed`), against the day it was sent on, so each used code pairs with its own
send; `used` never passes `sent`, in the statement and in a check. `GET /v1/admin/sms/usage`
(behind `secretKey()`) returns the last 1 to 30 days by prefix, the most unused first, at
most 100 prefixes. The table is tenant data behind row-level security; the runtime role may
update only the two counters; the prefix is at most four digits by a check, so the column
cannot hold a number. Rows are deleted by the retention job 90 days after their day
(`SMS_COUNT_RETENTION`, [ADR 0017](0017-retention.md)).

**The database keeps the last week of counts whatever a delete asks**
(`sms_code_counts_retention_floor`, a restrictive policy `FOR DELETE`:
`day < (now() at time zone 'utc')::date - 7`). The runtime role needs `DELETE` for the
retention job, and today's rows are what the daily limit is held against: without the
floor, a bug or an injected statement running as the API could delete them and reopen a
spent day. Seven days is far inside the 90 the job keeps. The role has no `UPDATE` on
`day`, so a row cannot be made old to get past it. What the grants do not do is prove a
count right: the role can still lower `sent` as far as `used` (that is how a message that
was not sent is counted back out), so they bound how a count can be erased, and the send
path is what keeps it true. The counts are not a record of who
can do what, so they carry no `Activity` ([ADR 0012](0012-events-and-audit-log.md)); they
are counted per message, which an audit entry per message would not survive.

### Twilio (added 2026-10-09, TULA-29)

`SMS_PROVIDER=twilio` is the one production sender. Its setup, and what Twilio's own rules
ask of an operator, is `docs/providers/twilio.md`.

**Configuration is environment variables, judged at boot and only when chosen.**
`TWILIO_ACCOUNT_SID`; one way to authenticate, an API key (`TWILIO_API_KEY_SID` and
`TWILIO_API_KEY_SECRET`, preferred: revocable by itself, not the account's master
credential) or `TWILIO_AUTH_TOKEN`; one sender, `TWILIO_MESSAGING_SERVICE_SID` or
`TWILIO_FROM_NUMBER`. With `twilio`, `env.ts` refuses to boot unless there is an account,
exactly one of each pair, and every value has Twilio's shape (`AC`/`SK`/`MG` and 32
hexadecimal digits, E.164; a secret is only held to printable ASCII without spaces, because
Twilio documents no format for one). The refusal names the variable and a fixed sentence,
never a value. `container.ts` asks again before it builds the sender. **With any other
`SMS_PROVIDER` the Twilio variables are ignored, whatever they hold**: `env.ts` had no
earlier convention for a provider's unused variables, and the webhook worker reads the same
schema while sending nothing, so a leftover line must not stop a process that never uses
it. The Compose file gives the variables to the API instances only
(`.claude/hooks/compose.test.ts`): a credential is in no container that has no use for it.

They are deployment configuration and not an environment's settings, unlike OAuth
credentials, because the ticket says so and because one Twilio account per deployment is
what a self-hosted operator has. Per-environment senders (a tenant's own Twilio account)
would be sealed rows like `oauth_providers`; nothing here prevents that later.

**The request.** `POST https://api.twilio.com/2010-04-01/Accounts/<sid>/Messages.json`,
form-encoded, HTTP Basic, built by hand: no Twilio SDK and no new dependency. Three fields,
`To`, the sender (`MessagingServiceSid` or `From`) and `Body`, and no other: no status
callback, schedule, link shortening, validity period or `RiskCheck`. The text is what
`modules/sms/templates.ts` wrote, unchanged. (A Messaging Service's own settings can still
alter a message on Twilio's side, Smart Encoding among them: said in the checklist.)

**The host is a constant, so this is not the outbound guard's.** `~/lib/outbound` exists
for an address an operator typed, where a name can be made to resolve to something inside
the network. Here the address is `api.twilio.com`, written in the adapter; nothing in the
configuration or a request changes it (the account's SID is in the path, percent-encoded,
and is held to its shape at boot). So the adapter follows the OAuth adapters
(`adapters/oauth/profile-read.ts`): `fetch`, one deadline (`PROVIDER_TIMEOUT_MS`, the ten
seconds the OAuth providers get, as an abort signal and again as a timer for a `fetch` that
ignores its signal), `redirect: 'error'` (a redirect would carry the credentials wherever it
points), at most 64 KB of the answer read, nothing of the answer returned.

*The proxy question.* `lib/outbound.ts` avoids `fetch` because Bun's `fetch` takes a proxy
from the environment whatever it is told; that was observed again for this change (Bun
1.4.2: with `HTTP_PROXY` set, a request made with `proxy: ''` still went to the proxy). For
an operator's address that defeats the guard: the proxy, not Tula, resolves the name, so
"every address it resolves to is public" is judged for the wrong machine. For Twilio there
is no such judgement to defeat. A proxy in the API's environment is the operator's own
egress, the OAuth providers and the breach check already go through it, and for an https
address a proxy is a tunnel: the TLS session is with `api.twilio.com`, and the proxy learns
the host and the sizes, not the credentials or the text. **So it does not matter here the
way it does there, and the adapter uses `fetch`.** What would matter is a certificate that
is not checked, since the credentials are in every request: `NODE_TLS_REJECT_UNAUTHORIZED=0`
makes Bun's `fetch` accept any certificate. The adapter therefore passes
`tls: { rejectUnauthorized: true }`, which was observed (same version, a self-signed local
server) to hold against that variable; the OAuth adapters do not, and that is their ADR's
to revisit. That the option also holds through a proxy's tunnel was not observed.

#### What counts as sent, and which way the count errs

The first version of the adapter had two outcomes, and called a send "failed" whenever it
was not a 2xx with a message `sid` of the documented shape. `Sms.sendCode` takes a failed
message back out of the day's count (TULA-28). So a 2xx whose body could not be read, a
`sid` of another shape, and a timeout or a connection that died after the request was
written were all given back to the day, although Twilio may well have taken and billed
each, and the user was invited to ask again. A ceiling on what is spent that undercounts
exactly when things go wrong is not one. It was changed before the review: **when nothing
says a message was not sent, it stays counted.**

The port's error has three fixed words (`SmsFailureReason`):

| Word | Means | The day's count and `sent` |
| --- | --- | --- |
| `not_configured` | The deployment has no sender. Nobody was asked. | Never taken (refused before any limit). |
| `failed` | The provider **answered and refused**. The message did not go. | Taken back out (`recordNotSent`). |
| `unconfirmed` | The provider was asked and **no answer says it refused**: none came, or the one that came is the provider's own failure. The message may have gone, and may be billed. | **Kept.** |

And the Twilio adapter maps what happened to them like this:

| What happened | Outcome | Log line (`reason`) |
| --- | --- | --- |
| Any 2xx, with a message `sid` in its JSON | **sent** | `debug`: `twilio accepted a text message` (`messageSid`) |
| Any 2xx whose body broke off or did not arrive in time, is over 64 KiB, is not JSON, or has no `sid` that may be logged | **sent** | `warn`: `twilio accepted a text message, and its answer could not be read` (`body_unread`, `too_large`, `not_json`, `no_sid`, and the status) |
| Any 4xx (400, 401, 404, 408, 429, …) or a 3xx that was handed back, whatever its body, also when the body then broke off or timed out | `failed` | `warn`: `twilio did not take a text message` (`refused`, the status, Twilio's code and masked text) |
| A redirect the runtime refused to follow | `failed` | the same line (`redirected`) |
| Any 5xx (500, 502, 503, 504, …), whatever its body, also when the body then broke off or timed out | `unconfirmed` | `warn`: `twilio answered without saying whether it took a text message` (`server_error`, the status, Twilio's code and masked text) |
| A status that is no final answer (a 1xx, a number outside 100 to 599), should the runtime hand one back | `unconfirmed` | the same line (`unexpected_status`, the status) |
| No status line within the deadline | `unconfirmed` | `warn`: `twilio gave no answer for a text message` (`timeout`) |
| The request ended without a status line: the network, DNS, TLS, a connection refused or cut off, anything else `fetch` rejects with | `unconfirmed` | the same line (`no_answer`) |

- **Any 2xx of the Messages resource is "sent".** The status line is the answer; the body
  is read for the log only. The `sid` is read leniently (letters and digits, 64 at most)
  and written to the `debug` line unless it is a value the adapter was configured with or
  carries digits of the number or of the text, in which case the line is the warning
  (`no_sid`). Nothing rests on its shape any more, so a real `sid` that differs from the
  documented `SM` + 32 hexadecimal digits breaks nothing.
- **A 4xx is a refusal; a 5xx is not.** The first review found that every status that is
  not a 2xx was `failed`, so that a 5xx gave its message back to the day. A 5xx does not
  say "Twilio answered and refused": it says that Twilio, or a load balancer or gateway in
  front of it, failed, and a 502 or a 504 is exactly what a gateway answers when the
  service behind it was slow, which it can be after taking the request. So **any 5xx is
  `unconfirmed`, whatever its body, a body that breaks off included**: Twilio's own JSON
  error on a 503 is logged (its number and masked text) and decides nothing. **Any 4xx is
  `failed`**, 429 and 408 included: a request Twilio would not authenticate, validate,
  find, wait for or make room for created no message. No documentation was found that a
  4xx of the Messages resource can follow an accepted message; if one turns up, that
  status moves to `unconfirmed`. The status alone decides, in one function
  (`notAccepted`), and the log line of a 5xx is one of its own, with the status, so that
  an operator can tell "Twilio is failing" from "nothing came back". The cost is the same
  as for silence, and is stated: **during a Twilio outage that answers 5xx, every try
  spends one of the day's messages** and most likely sends nothing.
- **A redirect is a refusal, and how it shows is Bun's.** The request is made with
  `redirect: 'error'`. Bun 1.4.2, asked against a local server: a 301, 302, 303, 307 or 308
  makes `fetch` reject with a `TypeError` whose `code` is `UnexpectedRedirect`, with or
  without a `Location`, and the target is never requested; a 300 and a 304 are handed back
  as ordinary answers. The adapter compares that one `code` (nothing else of an error is
  read) and calls it `failed`: something answered, and not with an acceptance. A test asks
  the runtime the same question on every run, so a Bun that words it differently fails the
  test; until someone notices, such a redirect is `unconfirmed`, the side that keeps the
  message counted.
- **The adapter does not try to tell "before any byte was sent".** A refused connection or
  a failed lookup provably sent nothing, and Bun does report codes for them
  (`ConnectionRefused`). They are `unconfirmed` all the same: those codes are not a
  contract, they differ behind a proxy (where the refusal is the proxy's, about its own
  next hop), and a wrong "nothing was sent" un-counts a message that went. The cost is
  stated: **while Twilio cannot be reached, every try spends one of the day's messages**
  and sends nothing. The per-asker and per-number limits bound how fast, and an outage
  that spends the day stops sending for the rest of it, which is the direction a ceiling
  is meant to fail in. An operator who sees `no_answer` or `server_error` lines and a spent day raises
  `sms.dailyMessageLimit` for the day (a weakening, recorded) once the cause is fixed.
- **`Sms.sendCode` treats anything that is not the port's `failed` or `not_configured` as
  unconfirmed**, an error of another class thrown by an adapter included: only a sender
  that says the message did not go gives it back. The caller's answer is the same
  `sms.unavailable` for all of them (nobody can be told a code is on its way), and the log
  line of the send path says `reason: 'unconfirmed', count: 'kept'`.
- **Nothing else branches on why a send failed.** `Verification.issue` stores a code's
  token only after its delivery returned, and rethrows any `ServiceException`; the phone
  service only passes the delivery in. So for `unconfirmed`, as for `failed`: no token is
  stored, the pending number does not change and an earlier code keeps working. A code
  that does arrive from an unconfirmed send is one nobody stored, so it confirms nothing
  and counts as a wrong guess if typed. That is kept: storing a code for a message nobody
  can vouch for would mean answering "sent" for it. The limiter's counts (the asker's
  minute and hour, the number's, the prefix's) are never given back, for any of the three.
- **Accepted is not delivered.** No status callback is asked for and none is read: a
  message a carrier drops after Twilio queued it (an unregistered sender, above all) is a
  sent message here. A callback would be a new unauthenticated route that Twilio signs with
  the auth token, and a state on a code; it is not in this step.
- **No retry.** A second request could send a second message, and every limit above counts
  one. That includes a 429 and a timeout.

**What is logged, and what is not.** The provider's own words go to the log only. On a
refusal the adapter writes one line: a fixed word (`refused`, `redirected`), the HTTP
status, Twilio's numeric `code` and Twilio's
`message`, masked (`maskProviderMessage`): every value the adapter was configured with, the
recipient and the text are taken out wherever they occur; then every identifier of Twilio's
shape; then every run of four or more digits, with up to two separators between digits, so
that a number written `(415) 555-0142` goes like one written `+14155550142`; control
characters become a space; 300 characters at most. The ticket asked for runs of four or more
digits; the rest was added because Twilio's sentence is Twilio's to write. The two fields
are logged as `twilioCode` and `twilioMessage`: the logger censors a key named `code`.
Never the request's body, the `To` number, a header of either side, or anything else of the
answer. The error that is thrown is an `SmsSendError` with one of the port's words and
carries nothing. On success
one `debug` line has Twilio's message SID, which is how an operator finds the message in
Twilio's log and names nobody by itself. The credentials live in the adapter's closure: not
a property of the sender, not in `deps.config`. A canary test answers with a body and headers
that repeat the number, the credentials and a marker, and holds all of this.

**The boot rule, and the half the boot cannot see.** "Staging and production refuse to boot
with SMS switched on and only the development adapter configured" has two parts. The
adapter is the deployment's, and `env.ts` already refused `SMS_PROVIDER=dev` in every tier
but `local` (and without a loopback `PUBLIC_URL`); that is unchanged, tested per tier, and
stricter than the ticket, since it does not wait for SMS to be switched on. "Switched on"
is an environment's setting in the database, which a boot does not read: a process must
start without its database, and a setting changes while it runs. So the other mismatch, an
environment with text messages on in a deployment with **no** sender, is said by the
diagnostics: the check `sms_sender` ([ADR 0031](0031-instance-admin-and-cli.md)). It counts,
inside the scan `master_key` makes and only where `SMS_PROVIDER` is `none`, the environments
whose settings `Settings.requireSms` would let through, and is `warn` when there is one.
*Warn, not fail*: nothing a user can reach is broken (the client configuration hides the
phone number where there is no sender); the setting simply has no effect, which is worth a
look and not an alarm. It is `fail` when one of those environments also has the texted
sign-in code on (`signIn.methods.smsCode`, TULA-27): its operator has switched on a way to
sign in that no user is offered. With a sender the check is `ok`, reads no
settings and says what it did not do: no message was sent and Twilio was not asked, so it
shows nothing about credentials, registration or delivery. Asking Twilio (a `GET` of the
account) would make it a real probe; it would also put a request with the credentials on a
route that can be asked thirty times a minute, and was left out.

**Prices.** TULA-28 left "a ceiling in money" for the step that brings a provider. It is
still not built: the adapter reads nothing of an accepted answer but its `sid`, a price per
destination is another of Twilio's APIs, and prices change. (Whether the answer to a send
ever carries a usable price was not confirmed; from memory of Twilio's reference the field
is empty until the message has gone out.) The daily limit stays a count of messages.

### Signing in with a texted code (added 2026-10-09, TULA-27)

A texted code is a first factor, `sms_code`, registered in `FIRST_FACTORS` like the others.
It is **off by default** (`signIn.methods.smsCode`). It is offered where the method is on
**and** a text message could be sent: `sms.enabled`, at least one allowed country, and a
deployment with a sender (`Factors.smsCodeAvailable`). The offer depends on the settings and
the deployment only, never on the identifier: a sign-in started with an email address is
offered it too, and a client leaves it out for an address. Every step of the strategy
checks again, before anything is counted, spent or sent (`requireSmsMethod` in the flow
service: `Settings.requireMethod('smsCode')`, `Settings.requireSms` for the number,
`Sms.requireSender`), and so does every step an attempt waits on after it
(`requireProvenMethod`): a code texted before the method, text messages or the number's
country was switched off is not honoured after, and is good again if they come back while
it lasts.

**It signs in; it does not sign up, and it is never the only way in.** There is no account
created by phone number, so the settings' "at least one sign-in method" does not count
`smsCode` (`SIGN_IN_METHODS_WITHOUT_SIGN_UP`): an environment with nothing else on could
never gain a user. For the same reason `OAuth.canStillSignIn` does not count a phone number:
removing a user's last other way in is refused whether or not they have one. A number can
lapse or gain a second holder (below) with nobody asking the user, so it is not something
to be left alone with.

**Switching it on is a weakening.** `settingsWeakenings` lists `signIn.methods.smsCode`
when a texted code can sign someone in after a change and could not before: the method
switched on where text messages are sent, or text messages switched on, or a first country
allowed, under a method that was on already. Whichever key changed, what got weaker is the
method. It lists `sms.allowedCountries` when a country is added while a texted code signs
people in. The reason is the same for both: an account that has proven a phone number can
then be entered by whoever receives that number's messages (a swapped SIM, a recycled
number, a forwarded line, a carrier's employee), with no password and no inbox. The audit
entry says `weakened: true`, the dashboard asks first and `tula apply --yes` needs
`--allow-weaker`.

**The start looks nothing up.** `POST /v1/client/sign-ins` takes an identifier that may be
a phone number, stores it in E.164 form when it parses as one and as a normalised address
otherwise, and answers with the environment's strategies. An account is looked for by
number in two places only, the `sms_code` prepare and the `sms_code` attempt
(`Phone.signInHolder`, the one caller of `users.findByPhoneNumber`); a test walks the
sources and fails for a third (`modules/phone/lookup.test.ts`). A password typed for a
number signs nobody in. **A phone number never finds an account for linking** either:
nothing in `OAuth.resolveAccount`, a sign-up or a reset reads one.

**Exactly one holder signs in.** A number is still not unique. `Phone.signInHolder` returns
a user only when exactly one account in the environment holds the number and proved it
within `PHONE_SIGN_IN_PROOF_MAX_AGE` (365 days). Two holders: nobody. Preferring the
earlier holder would give its account to whoever the number was recycled to. Preferring the
later (who did read a code from the phone, more recently) would sign the earlier owner, who
types the number they have always typed, in to **another person's account**. Neither is
acceptable, so neither is done. The costs: a user loses
this way in the moment someone else proves the same number, without being told, and a
user who holds a number can learn that another account holds it too (their own texted code
stops arriving). The second is the enumeration the non-unique number was meant to avoid; it
is limited to a number the asker can already receive messages for.

**A proof gets old.** Numbers are recycled: a carrier gives a lapsed number to a new
customer after some months. A number signs in only while its `phoneNumberVerifiedAt` is
within the last 365 days, and **each sign-in with a texted code moves that time forward**
(`users.recordPhoneNumberProof`, forward only, for the number the row still holds): a code
read from the phone is the same proof as the one that put the number on the account. So a
number in use never lapses, and one unused for a year stops signing in until its owner,
signed in another way, removes and adds it again. That write is not an audit entry and not
an event ([ADR 0012](0012-events-and-audit-log.md)): it changes nothing about who can do
what that the sign-in's own `session.created` does not say, and an entry per sign-in would
say only that. It is why an administrator sees `phoneNumberVerifiedAt` move. A new column
for "last proven" was considered and not added: the two times would have meant the same
thing. The lookup has an index (`users_environment_phone_number_idx`, partial, migration
0027); it is the only schema change.

**An unknown number is answered the same, and texted nothing.** "Unknown" is every number
that does not sign in: nobody's, two accounts', one proven too long ago, and an email
address that asks for a texted code. For it the prepare step:

- answers the same step, with the same masked destination (the last two digits of what was
  typed, which says nothing about an account);
- counts the same rows of the rate limiter in the same order (`Sms.sendCode` with a
  `DecoyMessage`: the asker's, the number's, the address's, the prefix's and the
  environment's), and is refused by them the same;
- stores a verification token whose code nobody is told and which names no user, so a guess
  that happened to match would still sign nobody in (stored after the answer, as a real
  code's is: below);
- sends no message.

**The day's count is where the two differ, and this is the argument.** A real message takes
one from the day (`SmsUsageStore.takeFromDay`); a decoy takes nothing and is refused only
when the day is already spent (`sentOn`, a read). The alternatives are worse. A decoy that
took from the day would let anyone spend an operator's whole day with made-up numbers, at
no cost to themselves and with no message ever sent: the limit exists to bound what an
attack costs, and would become the attack. A decoy that ignored the day would answer `200`
on a spent day where a real number answers `rate_limited`: a clean test of any number, for
free, all day. What is left is small: someone who can watch the day run out (their own
request refused) and who knows how many messages were sent can tell whether one request of
theirs took a slot, which is one number tested per day at the price of bringing the
environment to its limit. The day's count is also what `GET /v1/admin/sms/usage` shows, and
it stays a count of messages that were sent.

**The hourly shares are spent by decoys.** The prefix's and the environment's hourly shares
are rows of the rate limiter and are counted for every asker, so made-up numbers can use
them up and stop real codes for the rest of the hour, at no cost in money. Leaving them out
for a decoy would make a spent hour the same clean test as above. This is a denial of SMS
sign-in that the per-address limit (20 an hour) is all that slows; an operator sees it as
`rate_limited` log lines with the limit's name.

**The send does not hold the answer.** For a sign-in the message is handed to the sender
after every limit has let it through and is **not awaited** (`detached`): how long a
provider takes, and whether it took the message, would otherwise tell a real number from an
unknown one. The cost is that a person signing in is not told when their message could not
be sent; the screen says "if you can sign in with this number, we texted it a code", and
the operator's log has the failure. A message the sender refused is counted back out of the
day as before. **The day's message is taken before the answer**, not by the detached work,
so a spent day refuses a known and an unknown number in the same request, alike.

**The code is stored only once the sender took the message**
(`Verification.issueWhenTaken`, `CodeMessage.onTaken`). `Verification.issue` sends, waits
and then stores; a sign-in cannot wait, so the token is written by the detached send
itself, after the sender's answer: `failed` and `unconfirmed` store nothing. A code that
never left cannot be guessed against, and the code texted before it keeps working. A
decoy's token is written the same way, not waited for, so the request does the same work
before it answers for either kind of number. Whatever the detached work throws (a sender's
own error, a store that is down) is caught there and logged with fixed words and the
error's name, never its message; tests wait for it with `Sms.settled()`. Two costs. For a
moment after the message is on its way its code is not yet accepted (one write; a person
cannot type that fast; a script that reads a development inbox could, which is why the
inbox shows such a message only once its code is stored: "The development inbox", above).
And a real number whose send failed has no token where an unknown number
has a decoy's: its guesses are answered the same but touch one row fewer, which an
attacker could time only while the provider is failing. One difference in time remains: a real message's take from the day is a
write and a decoy's check is a read, in the same request. It was left: it is one statement
on a path that makes a dozen, and closing it means a write for every decoy, which is the
free spending of the day described above.

**The texted code is spent last, after the email it may need.** A holder whose email
address is not verified is sent a code there before the session (`needs_email_verification`).
That email is sent after the texted code and its holder were checked (a request that proved
nothing causes no email) and **before** the texted code is spent, as a password's is before
its attempt moves: an email that is refused (its cooldown, a relay that is down) leaves the
texted code unspent, and the user is not made to pay for a second message.

**Unspent is not untouched: the code is usable for the tries it has left.**
`Verification.verifyCode` counts a submission before it compares (five in all, the rule
for every code, and not changed here), so a right code whose email then fails is one try
poorer. A retry inside the emailed code's minute is refused `rate_limited` by that
cooldown and costs another; five submissions and the right code is dead, and the user does
pay for a second text. The answers say to wait (`Retry-After` on the 429) and the
documentation says why. Counting only after the email went would mean comparing before
counting, which is the thing the rule exists to rule out.

Two right submissions at once, for an unverified address: the second to ask for the email
is normally refused by its cooldown, `rate_limited` (after a right code, so it tells an
observer nothing they did not prove). Where both emails go (the newer code replaces the
older), only the request that spends the texted code moves the attempt and the other is
`auth.invalid_credentials`. For a verified address there is no email, and the loser is
always `auth.invalid_credentials`.

**Who asks.** Every other send has a signed-in user as its asker. Here anyone asks. An
asker that is the attempt's id would be minted freely (a start is one request), so the
asker is `{ type: 'sign_in', id }` with the id a keyed hash of the environment and the
identifier: the asker's rows then count per number, exactly as the number's own rows do,
and add nothing an attacker can reset. `newNumber` is false (the row for numbers new to an
asker would fire for every stranger). **What bounds someone with no account**, then, is:
the per-address limit of the route (`sign_in_prepare`) and of text messages (20 an hour);
one message a minute and five an hour to a number, whoever asks and whatever for (adding a
number and signing in share them); the prefix's and the environment's hourly shares; the
day. No limit was added. One was considered, a per-address count of *distinct* numbers,
and left out: it needs a set per address in the limiter, and the per-address count already
bounds it from above. The code is issued with `Verification.LIMITED_BY_DELIVERY`.

**The code.** A verification token of purpose `sms_sign_in`, six digits, stored as a keyed
hash that also covers the attempt's id and the number, so it proves nothing for another
attempt, another number or another purpose (a `phone_verification` code does not sign in,
and the other way round). A new code replaces the last. A guess is counted **before** the
check under the per-identifier lockout (`CREDENTIAL_LOCKOUT`), keyed by a keyed hash of the
number (`Phone.signInLockKey`): the same key a password guess for that number counts under,
and never the number. Every failure is `auth.invalid_credentials`: wrong, expired,
replaced, out of guesses, never asked for, a decoy's, a number that no longer signs in the
user the code was texted for (looked up again at the attempt), and **a locked number too**.
The password and the emailed code answer `rate_limited` while locked; here that answer
would be the only one that differs, so it is not given. A success clears the count.

**What a proven code becomes.** The session's `amr` is `sms`, a value of its own: not
`email`, not `pwd`, never `mfa`. The attempt goes through the flow service's `finish` like
every sign-in, so `before_session` is asked, the concurrent-session rule holds, and a
sign-in from a new device is announced. A second factor the account has is still asked for
after it. An account whose address was never verified is sent the emailed code next
(`needs_email_verification`), by the rule of [ADR 0024](0024-email-sign-in.md): the address
is then proven by someone who did not prove the password, and the password is removed. A
banned account answers `auth.user_banned`, after the code was proven and not before.

**A texted code is not a recent authentication.** `requireRecentAuth()` refuses a session
whose `amr` holds nothing but `sms`, however new it is, and `Mfa.stepUpMethods` does not
list SMS: such a session steps up with the password or an emailed code. What a phone number
alone can reach is therefore the account as it is; changing how the account is protected
(its password, its factors, its passkeys, its phone number) takes a second proof. An
account with no password and no verified address (a user of X or Facebook, who has no
address at all) that signs in by SMS has no way to step up until it has a passkey or an
authenticator.

**Where two-step verification is required and the account has none**, an attempt that has
proven only a phone number is not let into the enrolment: a factor enrolled there would be
the phone holder's, and from then on the account's. The attempt is refused with
`mfa.enrolment_needs_other_sign_in` (403, a new contract code) **before the code is
spent**, and stays on its first factor, where the password or an emailed code can still be
proven. An attempt that went through the emailed code first (the unverified address,
above) has proven the inbox and may enrol. `@tula/core`'s bundle budget moved by the 23
bytes the message costs.

**No number where it could travel.** The rule of "The number on a user" holds for the new
paths: the attempt's step shows the last two digits, limiter and lockout keys are keyed
hashes, log lines name the environment and a fixed word, and `session.created` says `sms`
and nothing else. A test signs in and searches every log line, event and audit entry
(`modules/flow/sms-sign-in.test.ts`).

**Old clients.** A client released before `sms_code` has no form for it. `@tula/react`
skips a strategy it does not know where another is offered and shows "This step is not
supported" where it is the only one; since `smsCode` is never the only method, a user of an
old client signs in another way and never sees a texted code offered. `@tula/core` passes
the strategy through as a string. The first field of `<SignIn>` takes a phone number only
where the client configuration lists `smsCode`.

### A texted code as the second factor (added 2026-10-09, TULA-46)

Decided in [ADR 0025](0025-mfa.md), "Addendum (step 2.4)". What it changes here:

- **A third asker.** `Sms.sendCode` takes `{ type: 'second_factor', id: the user's id }`
  for the code of a second factor (its enrolment, a sign-in's or a reset's second step, a
  step-up). Its rows of the limiter are its own; the number's, the address's, the prefix's,
  the environment's and the day's are everyone's. No limit was added and none reordered.
- **Three purposes** (`sms_factor_enrolment`, `sms_second_factor`, `sms_step_up`), each a
  keyed hash that covers what asked and the number, issued with
  `Verification.LIMITED_BY_DELIVERY`. A token is stored only after the sender took the
  message.
- **These sends are awaited and say `sms.unavailable`.** The sign-in's first factor hides
  whether a number has an account and so never says a send failed; here the caller has
  proven who the user is.
- **`users.sms_factor_enabled_at` is cleared by the two store methods that change the
  number**, in their transaction, with its own activity.
- A number that is a second factor is still contact data: not unique, and nothing about
  the factor is looked up by number.

## What this does not stop

Signing in with a texted code (TULA-27) adds these, all accepted and all reasons the method
is off by default:

- **whoever receives a number's messages enters the account**, where no second factor is
  set: a swapped SIM, a number recycled within the year, a forwarded line, a shared phone.
  They cannot change how the account is protected without a second proof, and can do
  everything else the application lets a signed-in user do;
- **anyone who knows a number can lock SMS sign-in for it**: guesses count under the
  number's lockout whoever makes them, and the number's five messages an hour can be asked
  for by anyone. The user's other ways in are not affected, except that a password typed
  for the *number* shares the lockout (a password for the address does not);
- **anyone can stop SMS sign-in for a destination or an environment for an hour** with
  made-up numbers, for free (the hourly shares, above), and for a day by having real
  messages sent to numbers that do sign in, which costs the operator the day's limit;
- a user is not told when another account proves their number and theirs stops signing in,
  nor when a number is added to or removed from their account (there is no notice yet:
  "What is not built");
- a message that could not be sent is not reported to the person signing in;
- **while the provider is failing, a number that signs in and one that does not differ in
  the work a guess does.** No token is stored for a failed or unconfirmed send (so that an
  earlier code keeps working), while an unknown number always has its decoy's. A guess for
  a number with no stored token is answered before the keyed hash and the update of the
  guess count; one for a decoy does both. The answers are the same, word for word; the
  difference is in time only. Storing a decoy-shaped token for a failed real send would
  close it and would replace the earlier, working code: not done;
- **the same is true, by one statement, when nothing fails**: a real message's take from
  the day is a write and a decoy's look at the day is a read ("Signing in with a texted
  code", above).

A number is neither unique nor proven before its first message, so a signed-in, recently
authenticated account can have codes texted to a number that is not theirs. TULA-28
narrowed this; it did not close it, and what remains is accepted:

- one account reaches three new numbers a day and one number gets five codes an hour, but
  many accounts reach many numbers, up to the prefix's and the environment's hourly shares
  and the daily limit. Those bound the total and the cost, not who is texted;
- the owner of a number gets messages they did not ask for (each names the app, and none
  can be used by the account that asked without the phone), and their own attempt to add
  the number is refused while its minute or its hour is spent, because the allowance is the
  number's;
- the `rate_limited` answer is the same for every limit, word for word, so it does not say
  which was reached; a first-time caller can still infer that somebody else asked;
- **spending the daily limit denies the service**: whoever can make an environment send
  `dailyMessageLimit` messages stops its real users from getting a code until midnight UTC.
  A fixed cost was chosen over availability under attack; the log line and the usage counts
  say that it is happening;
- the limit counts messages, and a message to one allowed country may cost many times one
  to another. Until there are prices the country list is the control;
- without Redis the limits of step 3 are per instance and forgotten on a restart. The daily
  limit is not;
- a sign-up is free, so "per account" limits bound an attacker only as far as accounts are
  costly to make. The per-address limit and the shares are what bound a farm of accounts.

## What is not built

Each is a seam left open, not a decision taken:

- **Signing up with a phone number**, and an account whose only identifier is one.
- **A texted code as a second factor** (TULA-46), **as a step-up, or for recovery.**
- **A name for a country that is the server's.** The dashboard's Text messages screen
  (TULA-54) takes the codes and prefixes from the contract and the names from the
  browser's `Intl.DisplayNames`: the contract's table has no names, and a name is shown
  beside its code, never instead of it.
- **A ceiling in money.** The daily limit counts messages. A cost needs Twilio's pricing
  API or a table an operator keeps ("Twilio", above).
- **An alert.** The operator reads the counts and the log; nothing tells them.
- **Delivery receipts.** "Sent" is "accepted by Twilio". A status callback route, signed by
  Twilio, would say what arrived.
- **A second provider, or a sender per environment.** Each is a new adapter of `SmsSender`
  and a new value of `SMS_PROVIDER`, or sealed rows per environment; nothing else changes.
- **Twilio regions other than the default.** The host is `api.twilio.com` (US1).
- **A check that Twilio accepts the credentials**, at boot or in the diagnostics.
- **Editable message text** (TULA-30). `codeText` is the one place the words are.
- **A notice to the owner** when a number is added or removed. Where a texted code signs
  people in a number is a way in, and its owner should be told as for a password or a
  passkey. It was not built with TULA-27: it needs a `notifications` setting, an email and
  its weakening, and is a decision about what is announced by default. Until then the
  protection is that adding a number needs a recent authentication that a texted code
  cannot give.
- **An administrator setting or removing a user's number.** The admin API shows it only.

## Consequences

- An environment that never touches `sms` behaves exactly as before: nothing is sent and the
  account screen shows no phone section.
- A deployment with `SMS_PROVIDER=none` whose environment switches SMS on answers
  `sms.unavailable`: the setting alone sends nothing, and `tula doctor` warns about it.
- With `SMS_PROVIDER=twilio` a user's number and the text of each message, its code
  included, leave the deployment for Twilio, which keeps them in its own log.
- A message Twilio accepted and a carrier dropped is indistinguishable, here, from one that
  arrived. Sender registration is the operator's, takes weeks, and is what decides it.
- No message has been delivered to a real handset from this code
  (`docs/plans/phase-2-unverified.md`).
- A code texted to a number can be read by whoever holds that phone. That is what the code
  proves, and all it proves.
- The development inbox is per process: with several local instances a tool reads each.
- An environment that switches SMS on sends at most 500 messages a day, 50 an hour to one
  destination, until its operator says otherwise. An application with more users than that
  must raise the limit, and is asked to confirm it.
- Every send is one short transaction that waits its environment's turn: sends of one
  environment are counted one after another, and sends of different environments do not
  wait for each other. It is reached only after every other limit let the send through.
- A user refused by a wide limit has still spent their own narrow ones (above).
- An environment that switches the texted sign-in code on accepts that a phone number is
  enough to enter an account that has proven one, and that its SMS can be denied by anyone
  ("What this does not stop"). One that leaves it off behaves exactly as before.
