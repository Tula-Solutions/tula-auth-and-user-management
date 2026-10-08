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
(TULA-27): that change adds it to `settingsWeakenings` with its reason.

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

**Send limits are simple here**: one a minute and five an hour per user, and the same per
number (keyed by a keyed hash of the number). They bound the signed-in case. What bounds
cost is TULA-28.

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

## What this does not stop yet

A number is neither unique nor proven before its first message, and the per-number limit
counts whoever asks. So any signed-in, recently authenticated account can have up to five
codes an hour texted to a number that is not theirs. Three things follow, and all three are
accepted for this step:

- the owner of that number gets messages they did not ask for (each names the app, and none
  can be used by the account that asked without the phone);
- the owner's own attempt to add the number is refused for the rest of the hour, because the
  allowance is the number's;
- the `rate_limited` answer tells the caller that somebody asked for that number lately. It
  is the same answer, word for word, as for the caller's own second try.

What bounds this is per-destination limits and the spend ceiling, which are TULA-28. Until
then the bounds are the ones above: a session, a recent authentication, five an hour per
account and five an hour per number.

## What is not built

Each is a seam left open, not a decision taken:

- **Signing in with a texted code** (TULA-27). `FIRST_FACTORS` has no SMS entry, the
  settings have no `signIn.methods.sms`, and uniqueness of a number is undecided.
- **Limits that bound cost** (TULA-28): per destination prefix, per environment, a spend
  ceiling. `Phone.request` is the one caller of `Sms.sendCode`; the limits belong before it.
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
