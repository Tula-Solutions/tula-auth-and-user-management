# ADR 0037: A phone number on an account, and how text messages are sent

- **Status:** accepted (started: the first of several steps; see "What is not built")
- **Date:** 2026-10-08
- **Ticket:** TULA-11 (phase 2)

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
throws `SmsSendError` with a fixed word (`not_configured`, `rejected`, `unavailable`). Three
adapters, chosen in `container.ts` by `SMS_PROVIDER`:

| `SMS_PROVIDER` | Adapter | |
| --- | --- | --- |
| `none` (the default) | `adapters/sms/unconfigured.ts` | Every send throws `not_configured`. Nothing is logged by it and nothing is kept. |
| `dev` | `adapters/sms/dev.ts` | Sends nothing. Keeps the newest 50 messages in the process's memory (the development inbox). |
| (tests) | `adapters/memory/sms-sender.ts` | `createTestDeps().sms`: an outbox a test reads, and a switch to make sends fail. |

There is no adapter that falls back to another, and no tier in which a message that could
not be sent is treated as sent: the caller gets `sms.unavailable` (503).

A sender says whether the deployment has one at all (`SmsSender.configured`; `false` only for
`none`). Without one, the client configuration's `phone.enabled` is `false` whatever the
settings say, so no screen offers a number that could not be added; and a request that
would send is refused (`Sms.requireSender`) after the settings were asked and **before any
send limit is counted**, so a try that can only fail uses up nobody's allowance. The
diagnostics do not yet warn about an environment with `sms.enabled` in such a deployment: it
would add a settings read per environment to the scan, and is left for the step that brings
a real provider (TULA-29).

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

### The number on a user

A user has one optional `phoneNumber` in E.164 form and `phoneNumberVerifiedAt`. The
database holds both or neither (`users_phone_number_whole`): **there is no unverified number
on an account**. A number is stored only by the confirmation of a code.

- Validation is strict (`parsePhoneNumber` in `@tula/contract`): spaces, hyphens and
  parentheses are taken out, and what is left must be `+` and 8 to 15 digits. A national
  number, a `00` prefix or anything else is `phone.invalid`. A country is never guessed:
  guessing is how a code reaches someone else's phone.
- **A number is not unique.** Two accounts in one environment may hold the same one. In this
  version nobody signs in with a number and nothing is looked up by one, so uniqueness would
  buy nothing and would tell whoever adds a number whether someone else has it. Signing in
  by SMS (TULA-27) has to decide this again, with enumeration in mind.
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
nothing signs in with it. It will become one when a texted code can sign someone in
(TULA-27): that change adds it to `settingsWeakenings` with its reason. **Raising
`sms.dailyMessageLimit` is a weakening** (below): it protects no account, it bounds what
abuse can cost the operator, and a change that enlarges that is asked about like the others.

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
environment to another. The asker is a user id today; a sign-in by SMS (TULA-27) brings its
attempt's id.

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
never during it. A message the sender then did not take is counted back out
(`recordNotSent`); if that write fails the count stays one too high, which errs on the side
of sending less.

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

## What this does not stop

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

- **Signing in with a texted code** (TULA-27). `FIRST_FACTORS` has no SMS entry, the
  settings have no `signIn.methods.sms`, and uniqueness of a number is undecided.
- **A ceiling in money.** The daily limit counts messages. With a provider's prices
  (TULA-29) the count becomes a cost, in `Sms.sendCode` and the usage store.
- **An alert.** The operator reads the counts and the log; nothing tells them.
- **A real provider** (TULA-29). A new adapter of `SmsSender` and a new value of
  `SMS_PROVIDER`; nothing else changes.
- **Editable message text** (TULA-30). `codeText` is the one place the words are.
- **A notice to the owner** when a number is added or removed. A number is not a way in, so
  nothing is announced yet; it belongs with TULA-27, when it becomes one.
- **An administrator setting or removing a user's number.** The admin API shows it only.

## Consequences

- An environment that never touches `sms` behaves exactly as before: nothing is sent and the
  account screen shows no phone section.
- A deployment with `SMS_PROVIDER=none` whose environment switches SMS on answers
  `sms.unavailable`: the setting alone sends nothing.
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
