---
paths:
  - "apps/api/src/modules/phone/**"
  - "apps/api/src/modules/sms/**"
  - "apps/api/src/modules/flow/**"
  - "apps/api/src/adapters/sms/**"
  - "apps/api/src/adapters/sms-sender*"
  - "packages/contract/src/phone*"
  - "packages/contract/src/sms*"
  - "apps/dashboard/src/features/sms/**"
---

# Phone numbers and SMS

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## Phone numbers and SMS (`modules/phone`, `modules/sms`, see ADR 0037)

A user has one optional phone number, proven with a texted code. It is **not unique**. It
is contact data, and, only where an environment switches the texted sign-in code on
(`signIn.methods.smsCode`, off by default), a way to sign in to the one account that holds
it ("Signing in with a texted code", at the end of this section).

- **Text messages go through the `SmsSender` port and fail closed.** `SMS_PROVIDER=none` (the
  default) is an adapter whose every send throws; a message that could not be sent is
  `sms.unavailable` (503), never treated as sent, and no adapter falls back to another. A real
  provider is a new adapter and a new value of `SMS_PROVIDER`, nothing else; it runs
  `smsSenderSuite` (`adapters/sms-sender.suite.ts`), as every sender does. A sender says
  whether the deployment has one (`configured`): without one `phone.enabled` in the client
  config is `false`, and `Sms.requireSender` refuses after `Settings.requireSms` and **before
  any send limit is counted**. Keep that order.
- **Twilio is the one sender that really sends** (`SMS_PROVIDER=twilio`,
  `adapters/sms/twilio.ts`; ADR 0037, "Twilio"). Its variables (`TWILIO_ACCOUNT_SID`; an API
  key's SID and secret **or** the auth token; a Messaging Service **or** one number) are
  judged by `env.ts` **only when it is chosen**, and are ignored otherwise: with it, both of
  a pair, neither, or a value that is not of Twilio's shape stops the boot with a message
  that names the variable and never a value. `container.ts` asks again. The credentials
  live in the adapter's closure: never a property, `deps.config`, a log line or an error,
  and the Compose `worker` service is not given them (`compose.test.ts`'s `API_ONLY`).
  - **One request per message, to a host that is a constant** (`TWILIO_API_ORIGIN`), with
    `To`, the sender and `Body` and nothing else: no option that alters content or routing,
    no Twilio SDK. It is not an operator's address, so it uses `fetch` like the OAuth
    adapters and not `~/lib/outbound`: one deadline (`PROVIDER_TIMEOUT_MS`, as a signal and
    as a timer), `redirect: 'error'`, `tls: { rejectUnauthorized: true }` (the credentials
    are in every request; keep it, `NODE_TLS_REJECT_UNAUTHORIZED=0` would otherwise apply),
    and at most `TWILIO_MAX_RESPONSE_BYTES` of the answer read. Never make the host or the
    path configurable.
  - **Sent means accepted: any 2xx.** The body is read for the log only (a `sid`, taken
    leniently); a 2xx whose body is missing, cut off, too large or unexpected is a warning,
    never a failed send. **Failed means Twilio answered and refused: any 4xx** (429 and 408
    included), a 3xx handed back, or a redirect. **Any 5xx is `unconfirmed`, whatever its
    body** (`server_error`, logged with its status: a server's own failure, a gateway's 502
    or 504 above all, does not say the message was not taken), and so is everything else (a
    timeout, a connection that died, any other rejection of `fetch`, a status that is no
    final answer). The status alone decides, in one function (`notAccepted`): never move a
    5xx to `failed` to spare the day's count during an outage, and never read a body to
    decide. Never make the `sid`'s shape, or
    anything else of a 2xx's body, decide the outcome, and never guess that "nothing was
    sent" from an error's code or text: the one code read is Bun's `UnexpectedRedirect`
    (a test asks the runtime on every run). **Nothing is retried**, a timeout and a 429
    included: a retry could send twice and the limits count one. There is no delivery
    receipt; never word a message Twilio accepted as delivered.
  - **Twilio's own words go to the log only, masked** (`maskProviderMessage`: the configured
    values, the recipient and the text, any Twilio identifier, every run of four or more
    digits however it is spaced (up to three characters that are not ASCII letters or digits
    between two of them: the gap is "anything but", never a list of separators), control
    characters, a cap), under `twilioCode` and
    `twilioMessage` (the logger censors `code`). Never the request's body, the `To` number
    or a header, and nothing of an answer in the error. A new field of the log line, and a
    new pattern in the mask (linear: no quantifier inside another), keeps the canary test in
    `adapters/sms/twilio.test.ts` and the "work is bounded" one.
  - **No test makes a request to Twilio**: `fetch` is a stub in every test that builds the
    adapter.
- **A send whose outcome is unknown stays counted.** The port's error has three words
  (`SmsFailureReason`): `not_configured`, `failed` (the provider answered and refused) and
  `unconfirmed` (no answer says it refused, a 5xx included: the message may have gone and
  be billed).
  `Sms.sendCode` takes the message back out of the day's count and of `sent` **only** for
  `failed`; for `unconfirmed`, and for anything an adapter throws that is not the port's
  error, the count is kept (`count: 'kept'` in the log) and the caller gets the same
  `sms.unavailable`. An adapter that cannot tell says `unconfirmed`, never `failed`: the
  ceiling errs towards sending less, also when that spends a day during an outage (ADR
  0037, "What counts as sent, and which way the count errs"). No token is stored for
  either, so an earlier code keeps working. `smsSenderSuite` holds the word for every
  adapter that can lose an answer.
- **The diagnostics say when an environment has text messages on and the deployment has no
  sender** (`sms_sender`, ADR 0031): a count, read inside the one bounded scan
  `master_key` makes (never a second scan), only where there is no sender: `warn`, and
  `fail` when one of those environments also has `signIn.methods.smsCode` on (a way to
  sign in that is offered to nobody). With a sender it is `ok` and says that nothing was sent
  and the provider was not asked: never reword it to claim the credentials work. A boot
  never reads an environment's settings.
- **The development inbox hands every code to whoever asks, and is gated like the mock OAuth
  provider.** `SMS_PROVIDER=dev` needs `ENVIRONMENT=local` **and** a loopback `PUBLIC_URL`
  (`env.ts` refuses to boot otherwise), `container.ts` builds the inbox in that tier only and
  warns on every boot, and `/v1/dev/sms/messages` is mounted only there and checks again in
  the handler. It refuses a request with an `Origin` or a cross-site `Sec-Fetch-Site`, and one
  whose `Host` header is not a loopback name (`isLoopbackHost` in `env.ts`, the same rule as
  for `PUBLIC_URL`: a DNS-rebinding page is same-origin with itself and only its `Host` gives
  it away), and is not in the OpenAPI document. Never loosen its guards. The inbox is per process.
  **A code the inbox shows is one that can be used.** A sign-in's message is handed over
  before its token is stored, so `Sms.sendCode` tells the sender when the code is usable
  (`SmsSendContext.usable` in the port: `true` once `onTaken` finished, `false` when the
  token was not stored) and the inbox keeps such a message out of what it answers until
  then, and for good on `false` (a reader waits and gives up; the log says "texted code not
  stored"). A tool that polls would otherwise present the right code in the gap and be
  answered `auth.invalid_credentials` (TULA-71). A sender that really sends ignores the
  context and never waits for it (`smsSenderSuite` holds that for every adapter, and
  `twilio.test.ts` that the request is the same): never make a real sender, the request or
  the token's write depend on it, and never show a held message early to make a test pass.
  The e2e fixture's `/__test/sms` waits for `Sms.settled()` for the same reason.
- **`Settings.requireSms` is the one place the `sms` settings are checked**, and every step
  that sends a code by SMS or accepts one calls it first, before anything is counted, spent
  or sent: a code asked for before SMS was switched off, or its country removed, is not
  honoured after. Off and "on with no country" are the same answer; **an empty
  `sms.allowedCountries` never means every country**. A number's country comes from the
  contract's `COUNTRY_CALLING_PREFIXES` (`packages/contract/src/phone.ts`, plain data); a calling code it
  does not know is refused.
- **A phone number is personal data.** It is returned to its owner and by the admin user
  routes, and nowhere else: never in a log line, an audit entry, an event payload, an error,
  a rate-limit or lockout key (a keyed hash there) or an `@tula-tech/mcp` projection. The two
  activity types (`user.phone_number_added`, `user.phone_number_removed`) have an empty
  payload. The event-canary test taps the SMS outbox and holds this.
- **There is no unverified number on an account.** A number is stored only by confirming a
  code (`users.setPhoneNumber`, with its `Activity`); the database holds the number and its
  verified-at together or neither (`users_phone_number_whole`). The pending number lives on
  the code's verification token (`destination`), which is stored only after the message was
  sent.
- **A phone code is a verification token of purpose `phone_verification`**, a keyed hash that
  also covers the user's id and the number. Guesses are counted before the check under
  `Phone.codeLockKey` (`CREDENTIAL_LOCKOUT`), a per-user key **of its own**: never
  `Mfa.stepUpLockKey`, because a success clears the key and anyone with a session can succeed
  here with their own phone.
- **The three routes (`/v1/client/me/phone`) are behind `requireRecentAuth()`.** Removing
  needs no SMS and works with SMS off.
- **A message is made in `modules/sms/templates.ts` and nowhere else**: the built-in
  sentence of each kind, the rendering of an environment's own (`renderCodeText`), the app
  name through `smsAppName`, and the origin-bound last line (`@host #code`) whose host is
  the environment's first allowed origin, never a request's. The code is the last run of
  six digits (the conformance runner and the tests read it so).
- **What an environment may write is the contract's, and it is one sentence**
  ([ADR 0042](../../docs/adr/0042-message-wording-editor.md)): `sms.templates.<kind>.text`,
  kinds `SMS_TEMPLATE_KINDS`, judged only by `smsTemplateProblems`
  (`packages/contract/src/sms-template.ts`, Zod-free) at save, on the tolerant read
  (`readStoredSmsTemplates`) and again before every send. **The last line is the server's
  and a template has no field for it.** Never loosen what keeps a second code or a second
  such line out: `{{code}}` exactly once, no placeholder twice, nothing but a space or
  punctuation beside a placeholder (no letter, digit or combining mark, judged with the
  invisible characters removed), no run of four digits, no word that starts with `@` or
  `#` (compared after NFKC), nothing that `readsAsLink`, a text that starts with a letter
  of its own. A new placeholder or kind is a decision in ADR 0042, with the cap's sum.
- **The cap is `MAX_SMS_TEMPLATE_LENGTH` (140) and its sum is written beside it**: with the
  longest app name and host a message is at most 457 characters, three GSM 7-bit segments.
  Raise it, or let a placeholder repeat, only with that sum done again, in the constant's
  comment, ADR 0042 and `docs/phone-numbers.md`. The daily limit still counts messages.
- **The code is checked again on the finished message.** `renderCodeText` takes the last
  run of exactly six digits of what it made and, if that is not the code (the app's name
  is a value and may hold six digits, and an environment with no allowed origin has no
  last line), sends the **built-in text** and logs the kind and the fixed word
  (`code_not_last`; `invalid` for a template that no longer passes), never the text. A
  template that cannot be used is never a failed send. Keep both tests in
  `modules/sms/wording.test.ts`.
- **`Sms.sendCode`'s caller names the kind, which chooses words and nothing else**: no
  limit, order or count reads a template. A change is the key `sms.templates.<kind>.text`
  in the audit entry and the event, never the words; it is not a weakening (a test pins
  it); `@tula-tech/mcp`'s settings projection does not name `templates` (a test holds it).
- **Switching SMS on, or a wider country list, is a weakening exactly where it lets a
  texted code sign someone in** (`settingsWeakenings`): `signIn.methods.smsCode` when a
  texted code can sign in after the change and could not before (the method switched on
  where text messages are sent; or text messages switched on, or a first country allowed,
  under the method), `sms.allowedCountries` when a country is added while one does. **And
  where it opens what the required second step can be** (`smsSecondStepWeakenings`, ADR
  0025): with `mfa.smsCode` on and `mfa.policy` `required` after the change, text messages
  switched on or a first country allowed is `mfa.smsCode`, and a country added where a
  texted code could already be that step is `sms.allowedCountries` (listed once when both
  rules name it). Never widen that to `optional` or `off`: there a texted code is only a
  step where there was none. Where no texted code signs anyone in and none can be a
  required second step neither is one: the number is contact data. **Raising `sms.dailyMessageLimit` is one** (`settingsWeakenings`: `sms.dailyMessageLimit`),
  shared by the audit entry, the dashboard's confirmation and `tula apply --yes`.
- **A text message leaves the server through `Sms.sendCode` and nowhere else, and every
  limit is in it.** A caller says who asks (`asker`: an id the server made), from which
  address, and whether the number is new to them; it brings no limit of its own, and a
  texted code is issued with `Verification.LIMITED_BY_DELIVERY` (never for an email). The
  order is fixed and a message refused at one step is counted by none of the later ones:
  `Settings.requireSms`, `Sms.requireSender`, the rate limiter's limits **narrowest first**
  (asker, asker's new numbers, number, address, destination prefix, environment), the daily
  limit, the send. The asker of a sign-in is `Sms.signInAsker` (a keyed hash of the
  environment and the identifier, never the attempt's id, which anyone mints); a new limit is a row of `enforceLimits` at its place in that order, with a test
  that fails when it is taken out and a row in the tables of ADR 0037 and
  `docs/phone-numbers.md`.
- **Every limit on that path fails closed, and answers alike.** A limiter that cannot count,
  and a count that cannot be taken (the database unreachable, its turn not had in time) are
  `service.unavailable` and nothing is sent: never `whenUnavailable: 'allow'` here. Every
  refusal is the one `rate_limited`; which limit it was is a fixed word in the log
  (`limit`), never in the answer, and the log line holds the environment and that word
  only. Limiter keys hold the environment, an id or a keyed hash (`sms-send-limits`,
  covering the environment) of the number, the address and the prefix: never one of the
  three itself.
- **The daily limit is counted in the database, not in the rate limiter**
  (`sms.dailyMessageLimit`, per environment and UTC day, in messages; there is no value
  that switches it off). The day's count is the day's rows of `sms_code_counts`, read and
  added to by **one store method, `SmsUsageStore.takeFromDay`**, **before** the send and
  never during it; a message the sender **said** it did not take is counted back out
  (`recordNotSent`), and one whose outcome is unknown is not.
  Never move it into the limiter (per instance without Redis, forgotten on a restart),
  never read the count and add to it in two calls, never add a second way to count a sent
  code, and never let a count that failed be a message that goes.
- **A take is one transaction on one connection, and never under `deps.environmentLock`.**
  In Postgres: `pg_advisory_xact_lock(SMS_DAY_LOCK_NAMESPACE, hashtext(environment id))`
  inside the tenant transaction, the sum, the insert-or-increment, the commit, with a
  `lock_timeout` of the transaction's own (`SMS_DAY_LOCK_WAIT_MS`). The environment lock's
  holder keeps a pool connection while its work needs another: fine for an administrator's
  write, and on a path every signed-in user reaches a way for sends at once to leave every
  connection waiting for one. Never put a lock that holds a connection around work on
  another on a user's request path. The key's first integer is not
  `ADVISORY_LOCK_NAMESPACE`, which every session-level lock's is (one number space: a test
  holds the two apart); a new transaction-level lock gets a first integer of its own beside
  them in `packages/db/src/advisory-lock.ts`. What a real server shows of it (takes at once
  on a pool of two, the wait, the other namespace) is `sms-usage.integration.ts`.
- **Narrow limits are counted before wide ones, and that is kept.** A send the prefix's
  hour, the environment's hour or a spent day refuses has still used the asker's minute,
  hourly try and new-number try. Never reorder to spare them, and never give a narrow
  count back when a wide limit refuses: the wide limits first would let one asker's refused
  tries spend what everyone shares. The tests named "narrow limits are counted before wide
  ones" pin it; ADR 0037 and `docs/phone-numbers.md` say it. Its safety does not rest on the settings cache: the count is shared
  and only the bound it is held to can be stale, for the cache's 5 to 30 seconds. The
  hourly limits per prefix and per environment are shares of it, never settings of their
  own: the shares and the function that applies them are the contract's (`smsCostLimits`
  in `packages/contract/src/phone.ts`), `Sms.limitsOf` calls it, and the dashboard shows
  an operator the same numbers. Never a second copy of that arithmetic.
- **A destination prefix is the contract's `phoneNumberPrefix`**: the entry of
  `COUNTRY_CALLING_PREFIXES` the country list matched, at most four digits
  (`sms_code_counts_prefix_shape`, `SMS_PREFIX_PATTERN`). Never a longer part of a number,
  in a count, a key, a log line or an answer. `GET /v1/admin/sms/usage` (behind
  `secretKey()`) returns counts by prefix and nothing about who asked; `sms_code_counts`
  has no column for a number or a user and must not get one, the runtime role updates only
  its two counters, and its rows go by `SmsUsageStore.deleteBefore` from the retention job
  (`SMS_COUNT_RETENTION`).
- **The database keeps the last seven days of `sms_code_counts` whatever a delete asks**
  (`sms_code_counts_retention_floor`, restrictive, `FOR DELETE`, in UTC days;
  `SMS_COUNT_RETENTION_FLOOR_DAYS`). Today's rows are what the daily limit is held against:
  a delete of them reopens a spent day. Never loosen the policy, never grant the role
  `UPDATE` on `day` (a row could be made old to get past it), and add no second policy
  that is not restrictive. A test that needs an empty day takes a fresh tenant: it cannot
  clear one.
- **Over HTTP, in one run, the daily limit's hourly shares refuse before the day does.** The
  scenario "text messages past the daily limit" says so; that the day's own count refuses
  is `modules/sms/service.test.ts` and an SDK journey. A scenario that sends a text message
  raises `sms.dailyMessageLimit` while it does (and restores it), so that repeated runs
  against one server are not stopped by a destination's hour.
- The `smsCode` conformance step reads the development inbox; a scenario with one sets
  `needsSmsInbox`. CI's `self-host` job runs both conformance runs with `SMS_PROVIDER=dev`,
  names both instances in `CONFORMANCE_SMS_INBOX_URLS`, and checks that each such scenario **passed**, by name,
  not only that it was not skipped: a new one is added to those lines of
  `.github/workflows/ci.yml`. A message a sign-in asked for is sent after the request was
  answered: a step that reads its code names the number's earlier code in `not`, and waits
  for another.
- **Signing in with a texted code** (`sms_code`, ADR 0037, "Signing in with a texted
  code"). It is offered only where `Factors.smsCodeAvailable` says so (the method on, SMS
  on with a country, a sender), whatever the identifier, and every step calls the flow
  service's `requireSmsMethod` first (`Settings.requireMethod('smsCode')`,
  `Settings.requireSms` for the number, `Sms.requireSender`); `requireProvenMethod` does
  for the steps after it. `smsCode` is never the only sign-in method
  (`SIGN_IN_METHODS_WITHOUT_SIGN_UP`: nothing signs up by phone) and a phone number is not
  counted by `OAuth.canStillSignIn`.
- **An account is looked for by number in one function, `Phone.signInHolder`, called from
  the `sms_code` prepare and attempt and nowhere else** (`modules/phone/lookup.test.ts`
  walks the sources). The start looks nothing up. It returns a user only when **exactly one**
  account holds the number and proved it within `PHONE_SIGN_IN_PROOF_MAX_AGE` (365 days;
  a sign-in with a texted code moves that time forward through
  `users.recordPhoneNumberProof`, the one unrecorded write of a number's row). Never prefer
  one of two holders, and never let a phone number find an account for linking, a sign-up
  or a reset.
- **A number that does not sign in is answered and limited like one that does, and is
  texted nothing.** The same: the answer, the step, the masked destination, the limiter
  rows and their order (`Sms.sendCode` takes a `DecoyMessage`), and a token stored after
  the answer (a decoy's names no user). **Not the same, and said in ADR 0037: the work
  differs by one statement** (a real message's take from the day is a write, a decoy's
  look at it a read), and while the provider fails a real number has no token where a
  decoy has one. Never call the two "timed alike". **A decoy takes nothing from the day and is refused when the day is
  spent** (`requireDayNotSpent`, a read): taking would let made-up numbers spend an
  operator's day for free, ignoring the day would make a spent day a test of any number.
  Never change either half without ADR 0037's argument. A sign-in's real message is
  `detached` (handed to the sender after the limits **and the day's take**, not awaited),
  so a provider's time and its failure say nothing; tests wait with `Sms.settled()`, and
  **so does a process that is stopping**: `closeApi` (`apps/api/src/server-close.ts`, all
  `server.ts` calls on a signal) awaits it after the listener stops and before the pool
  closes, because what follows the sender's answer is a write. A new piece of work that
  outlives its request gets a `settled()` and a line there.
  **Its token is stored by the detached work, only once the sender took the message**
  (`Verification.issueWhenTaken`, `onTaken`): `failed` and `unconfirmed` store none, so a
  code that never left cannot be guessed against and the earlier one keeps working. Never
  store a sign-in's token before the sender's answer, and never wait for that answer.
  Nothing the detached work throws leaves it: it is logged with fixed words and an
  error's name, never its message (a store's or a sender's own text can quote the
  number).
- **A texted sign-in code is a token of purpose `sms_sign_in`** whose keyed hash covers the
  attempt's id and the number. A guess is counted before the check under
  `Phone.signInLockKey` (a keyed hash of the number; `CREDENTIAL_LOCKOUT`), and **every
  failure is `auth.invalid_credentials`**: wrong, expired, a decoy's, a holder that
  changed since the code was texted, a locked number (never `rate_limited` here: for uniformity only, it
  hides nothing, and its cost is that nobody is told to wait: ADR 0011), and the request that
  loses the spending of a code two right submissions presented at once. The code is spent
  only when the attempt can go on, and **after** the email an unverified address needs.
  Two things follow, both in ADR 0037: an email that is refused leaves the texted code
  **usable for the tries it has left** (every submission is one of five, counted before
  the comparison, right code or not: never change that to spare one); and for an
  unverified address the second of two right submissions at once is normally
  `rate_limited` by the emailed code's cooldown, before it reaches the spending.
- **A session proven by a phone number alone says `amr: ['sms']`, is never a recent
  authentication and never satisfies `mfa`** (`Mfa.requireRecentAuthentication`), and SMS
  is not a step-up method. Where `mfa.policy` is `required` and the account has no factor,
  such an attempt is refused `mfa.enrolment_needs_other_sign_in` before the code is spent
  and never reaches the enrolment (`loadEnrolment` refuses too): a factor enrolled by
  whoever holds the phone would be the account's.

## What to test

The failure paths a change here is held to (moved from the checklist of `security.md`; the
rules themselves are above and are not repeated).

- **A phone number on an account:** SMS off, on with no country, a country not listed, a
  country removed and SMS switched off between the send and the confirmation, another user's
  code, a code for a number that was replaced, a wrong, used and expired code, the lockout, a
  failed send leaving the earlier code working, no recent authentication, and the inbox route
  in every other tier. The inbox is checked in `env.ts`, `container.ts`, `createApp` and the
  handler: keep all four.
- **The send limits:** each limit alone, a refused send counted by no wider limit, the
  limiter failing at each key, the day's take failing, two sends at once for the day's last
  message, a wide refusal still costing the asker, a delete of today's count deleting
  nothing, a failed send counted back out, and no number, prefix or address in a key, a log
  line or the usage answer.
- **The Twilio sender** (stubbed `fetch`, never a request to Twilio): which of the three
  outcomes each kind of answer and each way of getting none is; that an unconfirmed send
  leaves the day's count one higher and spends the day's last message while a failed one does
  not; the timeout; both credential forms; both senders; the text arriving unchanged; and the
  canary (an answer that repeats the number and the credentials: none in the error, none
  unmasked in the log).
- **Signing in with a texted code:** a known and an unknown number side by side (the answer,
  the limiter's counters, the outbox), two holders, a stale proof, a code for another attempt
  and another purpose, the lockout's key and order, the method, SMS, the country and the
  sender each taken away mid-attempt, a banned holder, required two-step verification, the
  step-up refusal, and no number in a log line, an event or an audit entry.
