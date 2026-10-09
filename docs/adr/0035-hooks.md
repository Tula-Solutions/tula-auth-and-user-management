# ADR 0035: Hooks, and the hook before sign-up

- **Status:** accepted
- **Date:** 2026-10-08
- **Ticket:** TULA-45 (phase 2, step 2.3; the tracer for hooks); TULA-53 (the hooks before a
  session and before a token: the dated section at the end)

## Context

An operator wants a say in who may sign up: no disposable addresses, only an allow-listed
domain, a fraud check. The business plan calls it a "custom validator hook". Phase 2 settled
that such logic runs **outside** the API, over HTTP (decision D11): the self-hosted product is
one image that holds the master key, and loading an operator's code into that process removes
the boundary between tenant logic and key material.

A **hook** is a signed question, sent to an operator's endpoint, whose answer decides what
happens next ([GLOSSARY.md](../../GLOSSARY.md)). It is not a webhook: a webhook is a notice of
something that has already happened, and its answer changes nothing. The two share an outbound
client, a signature and a secret format ([ADR 0034](0034-webhooks.md)), and nothing else.

This ADR decides the first point, `before_sign_up`, and what every later point inherits. Two
more points (before a session is created, before a token is issued) were added by TULA-53
and are decided in [the dated section at the end](#2026-10-08-hooks-before-a-session-and-before-a-token-tula-53);
a dashboard screen and hooks in `tula.config.ts` are later tickets and are not built here.

## Decision

### Data

One table, `tula.hooks` (migration `0021`): tenant columns, forced row-level security, the
composite foreign key every tenant table has. **One hook per point per environment**
(`hooks_environment_point_key`); the point is a closed list in the contract (`HOOK_POINTS`,
one member today), so a second point is an added value and a second row.

| Column | What |
| --- | --- |
| `point` | `before_sign_up`. |
| `url` | Where the question is posted. |
| `secret` | The signing secret, sealed. |
| `enabled` | A hook that is off is not asked. |
| `deadline_ms` | How long the server waits: 2000 by default, 100 to 5000. |
| `failure_mode` | `deny` (default) or `allow`. |
| `last_failed_at`, `last_failure_reason` | When a call last failed, and a fixed word for why. Set together. |

The deadline's bounds are held three times: by the contract's schema (the API answers
`validation.failed` for 5001), by a check of the table's own (`hooks_deadline_bounds`), and by
the service, which never passes the outbound guard more than `HOOK_MAX_DEADLINE_MS` whatever
the row says. A hook is on the path of a person who is waiting; no write of any kind may make
that wait longer than five seconds.

There is no column for anything an endpoint answered, and there is no call log in this step.

### The secret and the signature

Exactly a webhook endpoint's: 32 bytes from the CSPRNG as `whsec_` + base64, made by the
server, returned once by the registration (`Cache-Control: no-store`), never a request field
and never returned again, sealed with `~/lib/secret-box`. Its purpose is its own
(`hook-secrets`, bound to environment and hook id), so a ciphertext copied from a webhook
endpoint's row, another hook's or another environment's does not open.

The question is signed in the one place a webhook delivery is. That place moved out of the
webhook service into `~/lib/signing-secret` (`newSigningSecret`, `openSigningSecret`,
`signedHeaders`), and both modules call it: the contract's `signWebhook`, the three Standard
Webhooks headers. There is still exactly one function that writes `webhook-signature`.

**No rotation in this step.** A hook has one secret; replacing it means removing the hook and
registering it again, which leaves a window with no hook at all (a recorded weakening). The
later ticket can take TULA-43's design as it is: `signedHeaders` already signs with a previous
key during an overlap, and `verifyHook` already accepts a list of two secrets.

### The question

A `POST` of JSON with the envelope of an event (`id`, `type`, `schemaVersion`, `occurredAt`,
`data`), so that one verifier and one mental model serve both. It is **not** an event: it has
no `actor` and no `target`, its type (`hook.before_sign_up`) is no activity type, and
`TulaEventSchema` refuses it. The contract has its schema (`HOOK_QUESTION_SCHEMAS`, strict at
every level) and an example (`HOOK_QUESTION_FIXTURES`).

`data` is an allow-list of four fields:

| Field | Why it is there |
| --- | --- |
| `email` | The address the account would be created for, normalised (the form an account is unique by). It is what a sign-up validator exists to judge. **`null` for a first sign-in with X or Facebook** (added 2026-10-09, TULA-14, below). |
| `method` | `password`, `passwordless` or `oauth_<provider>`: a closed list. An operator may trust a provider's verified address more than an emailed code. |
| `client` | The kind of client the sign-up started from (`web`, `ios`, …): a closed list. |
| `ipAddress` | The address the request that would create the account came from, as the server knows it, or `null`. Fraud and abuse checks (a rate of their own, a country rule, a known-bad range) are the second thing a validator is for. |

**A sign-up with no address (added 2026-10-09, TULA-14).** X and Facebook are asked for no
email address ([ADR 0026](0026-oauth.md), "X and Facebook: providers without an address"),
and their first sign-in creates an account with none. The hook is still asked, at the same
point, because an operator's validator is also for the IP address, the client and the
method. The question's `email` is then `null`. The alternatives were to leave the key out
(a receiver that reads `data.email` then gets `undefined`, which a strict schema of its own
refuses, and the field's absence would mean two things), to invent a placeholder (a lie a
receiver would store), or to pass an address the provider was never asked for (there is
none). So the schema's `email` became `string | null`, the key always present: the smallest
change that says what is true. **It is a change to what a receiver may be sent**: one that
calls a string method on `email` without a check fails for these sign-ups, and by the rule
above a failed hook is `hook.unavailable` under `deny`, so with such a receiver nobody
signs up through X or Facebook until it is fixed. It fails closed. `verifyHook`'s examples
and `docs/hooks.md` show the check. Nothing else of the question changed, and the two later
points never held an address.

**Why an email address and an IP address here, when an event payload never holds either**
([ADR 0012](0012-events-and-audit-log.md)). The rule about event payloads exists because an
event is stored in the outbox for weeks, fans out to every subscribed endpoint (up to ten),
and is sent to endpoints that subscribed for unrelated reasons. A hook's question goes to
**one** endpoint, registered for exactly this purpose by an operator who already reads both
values through the admin API (the user list has the address; the audit log has the IP
address). It is built for the request and never stored: not in the outbox, not in the audit
log, not in a log line. So nothing reaches anyone who could not already read it, and the rule
about events stands unchanged (the event canary test still holds every payload to it).

**Left out, deliberately:** the user agent (free-form, written by the client, long, and of
little use to a decision an operator must be able to explain; only its family ever leaves the
server anywhere else), the names typed at sign-up, the provider's subject and everything else
of its profile, the attempt's id, and of course the password, its hash, the emailed code and
every token. The schema is strict, and the service names the four fields one by one when it
builds the body, so an object with more on it sends no more.

### The answer

A `200` (any 2xx) whose body is exactly `{ "decision": "allow" }` or
`{ "decision": "deny", "code": "<code>" }`. `code` is optional and is the operator's own
message code: lower-case letters, digits and underscores, at most 64 (`HOOK_DENIAL_CODE_PATTERN`).
Narrow enough to be put in an error's `params`, shown and logged without being markup, a
sentence or a secret.

**Everything else is a failure**, handled by the failure mode, and is never read as an allow
or as a denial:

- a status that is not 2xx, whatever its body says (a `403` with `{"decision":"deny"}` is a
  failure: a proxy in front of the endpoint can produce one);
- a redirect (never followed);
- a body over 1 KiB (`HOOK_MAX_RESPONSE_BYTES`), whatever its status;
- a body that is not UTF-8, not JSON, not an object, another `decision`, a `code` beside an
  `allow`, a code outside the pattern;
- **any unknown key**;
- no answer inside the deadline, a connection that fails, a refusal by the outbound guard;
- a secret the server cannot open (nothing is sent).

**Unknown keys are a failure, not ignored.** This is the opposite of what a webhook receiver
is told about events, on purpose. A later version will give new keys meaning (claims to add at
token issuance). An older server that ignored a key it did not know would act on half of an
answer: it would allow, and drop what the operator attached to the allow. Failing is the only
reading under which an operator's endpoint and the server always agree on what was decided.

Of an answer, the server keeps the decision and the code. Nothing else is read into a
variable that outlives the function that made the request (`call` returns a verdict of two
members, or a fixed failure word): not a header, not the status, not the body.

### A hook is not an authority

It can allow or deny. It cannot mark an address verified, skip a second factor, choose a user
or add anything to an account. This is structural, not a filter:

- `Hooks.beforeSignUp` returns `'clear'` or `'bypassed'` and throws otherwise. The flow gets
  one of two words and nothing of the answer.
- The parsed answer never leaves `call`; the verdict is rebuilt field by field from what the
  contract's strict schema accepted.
- An answer carrying anything more is not an answer at all (above).

The tests create an account with the hook in `allow` mode while the endpoint answers
`emailVerified`, `userId`, `amr`, `claims` and the like, and compare the account and its
session with those of a sign-up made with no hook: identical. With `mfa.policy: required` an
allowed sign-up still stops at `needs_factor_enrolment` with no session.

### Where the hook is asked: the enumeration rule

**The rule.** Someone who can start sign-ups must not be able to tell, from whether the hook
was asked, from its answer or from how long the request took, whether an address already has
an account. A sign-up's start answers the same for every address (ADR 0009); a hook asked
there, or at any step both kinds of address reach, would be an oracle with the operator's
endpoint as the measuring instrument.

**So the hook is asked only where a new account is about to be created for an address the
caller has proven**, which is where the flow already answers differently.

| Path | Where exactly | Why that place holds the rule | What bounds the calls |
| --- | --- | --- | --- |
| Sign-up with a password | `Flows.verifyEmail`, after `Verification.verifyCode` accepted the emailed code and after the decoy check, immediately before `users.create` | An attempt for an existing address is a decoy: its code is one nobody knows, so no request for it ever gets past `verifyCode`. Whoever gets here holds the inbox, and the inbox of an existing address was already told "you have an account". A wrong code, a missing attempt secret, a foreign origin and a switched-off method are all refused earlier, identically for both kinds of address, with nothing asked. | Each call spends one emailed code: the `signUp` ceiling (600 emails a minute per environment), the per-address send limits and cooldown, the per-IP limit of the route, the `verify` ceiling (3,000 a minute). |
| Sign-up without a password | The same statement: it is the same step | The same. | The same. |
| First sign-in with a provider | `OAuth.resolveAccount`, on the row "no identity, a verified provider address, no user has that address" (for X and Facebook, which give no address: the row "the identity is nobody's"), immediately before `users.create`; once per call even when the insert loses a race | The exchange has already checked the ticket and the browser's binding, and the provider has proven the address. The rows beside this one already answer differently (`oauth.account_exists`, a link, a sign-in), so being asked or not says nothing new. A known identity, an unverified or missing address, and an address that has an account never ask. | Each call spends one provider round trip and one ticket: the `oauth` and `verify` ceilings (3,000 a minute each) and the per-IP limits of the start, the callback and the exchange. |
| An administrator creating a user | Never | It is the operator's own act; the validator is the operator's too. | — |

On top of those, **every environment has a ceiling on hook calls of its own**:
`HOOK_CALLS_PER_MINUTE`, 600, counted just before a call and only where there is a hook that
is on. The password paths were already held to 600 a minute by the email ceiling; the
provider path was not (3,000), and this is the bound that is about the operator's endpoint
whatever path led there. One attacker, then, causes at most ten calls a second to an
operator's endpoint, and for each of them must own a fresh inbox or provider account. Over
the ceiling the request is refused (`rate_limited`) and the attempt is left as it is.

**The ceiling is counted after the code is spent, and that costs a resend.** A request
refused by it (or by a limiter that cannot count) has already used its emailed code up, so
retrying the same code after `Retry-After` answers `verification.invalid_code`; the user asks
for a new code on the same attempt and submits that. Counting before the code is checked was
considered and refused: the ceiling would then be reachable with an attempt's secret and any
six digits, so anyone could start a sign-up for an address they do not own and use up an
environment's whole allowance (ten calls a second) with wrong codes, refusing every real
sign-up; and since a decoy attempt must behave like a real one, it would have to count for
existing addresses too. Behind the code, each unit of the ceiling costs a proven inbox. A
test pins both halves (the same code refused after the cap, a new one accepted; a wrong code
never reaching the counter).

**It cannot be made to call on demand.** The call is behind everything the step checks first:
the attempt's secret and origin (`load`), the method's switch, the ceilings, and a code or a
ticket that was spent. There is no route that asks a hook for its own sake (no "test this
hook" request in this step).

**What is not claimed about timing.** A request that asks the hook takes longer than one that
does not, by up to the deadline. That difference is only between requests that already answer
differently (a proven new address against everything else). The tests assert on responses and
on whether the receiver was called, for existing and new addresses side by side; they do not
measure time, and nothing here equalises it.

### What a refusal leaves behind

Nothing: no user, no identity, no credential, no session, no `user.created`.

**The attempt ends.** By the time the hook is asked the emailed code is spent. An attempt left
open could only be continued by asking for another code, with the user none the wiser about
why the last one "did not work". So `Flows.verifyEmail` deletes the attempt (and the password
hash it holds) on `hook.denied` and on `hook.unavailable`, and the client is told which:

| Code | Status | Meaning for the app |
| --- | --- | --- |
| `hook.denied` | 403 | The operator's endpoint said no. `params.code` is its message code, when it gave one. |
| `hook.unavailable` | 503 | The endpoint could not be asked or gave no usable answer, and the hook refuses on failure. Not a refusal of this person: try again later. |

Two codes, because an app must not tell someone "you are not allowed" when the truth is "our
check is down". For a provider sign-in the ticket is spent and the attempt's secret was
rotated at the exchange, so that attempt is over too, as for every other refusal there.

Any other error (the ceiling on hook calls, a store that is down) leaves the attempt alone.
If deleting the attempt itself fails, that is logged and the hook's error is still what the
client gets; the attempt, its code spent, expires by itself.

A denied sign-up is **not** recorded as an event: nothing changed, and there is no user to be
about. It is logged with ids and the code.

### Failure modes, and what is recorded as a weakening

`deny` is the default: a fraud check that is down must not wave everyone in. `allow` is a
choice per hook.

`hookWeakenings(was, is)` in the contract is the definition, as `settingsWeakenings` is for
settings, so the later `tula apply --yes` and the dashboard's confirmation use the same one:

- `failureMode` set to `allow` (at registration or by an update);
- `enabled` set to `false`;
- the removal of a hook that is on.

Each is recorded with `weakened: true` on its audit entry and event (`hook.created`,
`hook.updated`, `hook.deleted`). Disabling counts because it removes the check exactly as
`allow` does when the endpoint is down, only always. `hook.updated` names the fields that
changed (`changed`, a closed list) and never a value; no entry holds the address or the
secret.

The write is a compare-and-set on what the weakening was judged against (`enabled` and
`failure_mode` as read), so the record is about the change that was made; a hook that changed
meanwhile answers `resource.conflict`.

**Each account let through because the hook failed says so**: `hookBypassed: true` in the
`data` of its `user.created` event and audit entry (an optional field, added to a public
payload within `EVENT_SCHEMA_VERSION` 1). "Which accounts were created while the check was
down" is the question an operator asks afterwards, and it is answered by filtering the audit
log, or by a webhook subscriber as it happens. A line is logged as well, with ids only.

**Changing or removing a hook takes the secret key and nothing more.** A hook is a security
control an attacker who holds the key could switch off, but the key can already create users
directly, change every setting and read every account. A second factor for this one write
would protect nothing the key does not already give away. What the design does instead is
make the act loud: recorded, flagged as a weakening, delivered to webhook subscribers.

### What the operator sees of a failing hook

`lastFailedAt` and `lastFailureReason` on the hook's read answer: the time of the last failed
call and one of `HOOK_FAILURE_REASONS` (the outbound guard's eight words, `status_not_ok`,
`answer_invalid`, `secret_unreadable`). Written by `HookStore.noteFailure`, a method of its
own that takes no activity (bookkeeping; a line in ADR 0012), and failing to write it changes
no decision. It is never cleared: it says when a call last failed, whenever that was. A
denial is not a failure and writes nothing.

### The admin API

`/v1/admin/hooks`, behind `secretKey()` like every admin route: `POST` (201 with the secret),
`GET`, `GET /:id`, `PATCH /:id` (address, switch, deadline, failure mode; never the point or
the secret), `DELETE /:id`. The address is judged by the outbound guard when it is saved
(`hook.url_not_allowed`, with the guard's fixed word) and again at every call.

### The receiving side: `verifyHook` in `@tula/admin`

`verifyHook(body, headers, secret)` returns a `TulaHookQuestion`, typed from the OpenAPI
document like `verifyWebhook`'s event; `TulaHookAnswer` types what to send back. Both
verifiers now sit on one function (`verifySigned`: the secret's form, the headers, the
timestamp, the signature in constant time) and differ only in what the body must be:

- `verifyHook` requires a type from a **closed** list (`HOOK_QUESTION_TYPE_NAMES`), no
  `actor`, no `target`, no `test`. An event is refused, including `hook.created`, whose type
  also begins with `hook.`. The list is closed because a hook must never allow something it
  does not understand: an unknown question fails, and failing refuses.
- `verifyWebhook` requires an `actor` and a `target`, which a question does not have.

Neither accepts the other's body, whatever secret signed it.

### Conformance

A `hook` step, on the `webhook` step's receiver (a receiver of one name is one listener): it
scripts how the endpoint answers (an answer of the contract, a bare status, or `hang`), and
checks the next question that arrived (signature, timestamp, a strict question of the
contract that is not also an event) or that none did. Scenarios `sign-up denied by a hook`
and `hook that times out` (the hook's deadline at its minimum, 100 ms). Both need a receiver
the server can reach, are marked `needsWebhookReceiver`, and are skipped by name by CI's
containerised target, as the webhook scenarios are; both run in process, and each has an SDK
journey through `@tula/core`.

## Consequences

- A sign-up now can take up to the hook's deadline longer, and depends on the operator's
  endpoint being up unless they chose `allow`. That is the feature; the read answer and the
  logs are where a broken endpoint shows.
- A transient failure costs the user a whole new sign-up (a new code), not a retry of the
  last step. Simple and safe; see the alternatives.
- `@tula/core` carries three more error codes. Its bundle budget moved by the 50 bytes they
  cost (15,458 to 15,508 bytes gzipped; budget 15,500 to 15,550).
- `@tula/react` shows `hook.denied` and `hook.unavailable` with their default messages on the
  code screen, which keeps its "start again" control. An app that wants its own words for an
  operator's code reads `error.params.code`. No component changed.
- The webhook service lost its private signing functions to a shared library; its behaviour
  and its tests are unchanged.

## Not built yet

- Secret rotation for a hook.
- A log of calls, counts of outcomes, and a "test this hook" request.

Built since: a hook in `tula.config.ts`, `tula apply` refusing `hookWeakenings` under
`--yes`, and the dashboard screen with its confirmation for a weakening (TULA-59, the last
section of this record).

## Alternatives considered

- **Ask at the start of a sign-up.** Earlier feedback for the user, and an oracle: a decoy
  attempt would not ask, a real one would. Refused by the rule.
- **Ask at the start for every address, decoys included.** No oracle, but the operator's
  endpoint is then called for any address anyone types, with no proof and at the cost of one
  request: a way to make the server send requests on demand, and to hand an operator's fraud
  vendor a list of addresses that never signed up.
- **Ask before the code is spent** (check the code, ask, then spend it). A failure would then
  be retryable with the same code. It needs a way to check a code without spending it, in the
  verification module, where "a guess is counted and a code is used in one step" is the
  property everything else relies on. Not for this.
- **Keep the attempt open after a failure and accept any code on a retry.** A step that
  accepts any code, even only on an attempt that has proven its address, is a sentence nobody
  should have to reason about twice.
- **Ignore unknown keys in the answer.** See "The answer".
- **A counter on the hook instead of `hookBypassed` on the account.** Says how often, not
  which accounts.
- **Reuse `webhook.url_not_allowed` for a hook's refused address.** One code less in every
  bundle, and the wrong word in an operator's logs.

## 2026-10-08: Hooks before a session and before a token (TULA-53)

Two more points, built on everything above. What `before_sign_up` established holds for all
three and is not repeated: one hook per point per environment, the shared secret and
signature, `Outbound.request`, the deadline held three times, "anything but a 2xx whose body
is exactly an answer is a failure", the failure mode with `deny` as the default, weakenings,
the fixed failure word on the hook, a count per environment, no route that asks on demand,
and a question that is an allow-list, named field by field and never stored. The point enum
is text in the database (`hooks.point`), so the two new points need no migration; the claims
do (`0022`, below).

### The points and their answers

| Point | Asked by | Answer |
| --- | --- | --- |
| `before_sign_up` | `Flows.verifyEmail`, `OAuth.resolveAccount` | a decision |
| `before_session` | the flow engine's `finish` | a decision |
| `before_token` | `Sessions.create`, `Sessions.recordAuthentication` | claims |

`HOOK_ANSWER_KINDS` in the contract says which point reads which kind. A deciding point's
answer is the existing `HookAnswerSchema`. A claims point's is `{ "claims": { … } }`
(`HookClaimsAnswerSchema`, strict). **A claims hook cannot deny**: its answer has no
`decision`, and a decision sent to it is not an answer. One hook that both decided and added
claims would have made a missing `claims` ambiguous and given the refusal of a sign-in two
places to come from; an operator who wants both registers both.

`Hooks.beforeSession` returns the same two words `beforeSignUp` does (`'clear'`,
`'bypassed'`) and throws otherwise. `Hooks.beforeToken` returns
`{ claims, asked, bypassed }`: checked claims or `null`, and nothing else of the answer. In
both, the parsed body never leaves `call`.

### The questions

`before_session`: `userId`, `client`, `profile`, `amr`, `signUp`, `ipAddress`.
`before_token`: `userId`, `sessionId`, `client`, `profile`, `amr`. Strict schemas, fixtures,
and members of the union `verifyHook` accepts.

- **No email address in either.** The account exists and its id names it; the operator has
  the admin API to look it up. An address would add a copy of personal data to every sign-in
  for the operators who do not need it. `before_sign_up` carries one because no id exists.
- **No IP address in `before_token`.** Its answer is stored on the session and issued with
  every later token. A claim computed from one request's address would be signed into tokens
  used from other addresses, and would invite exactly that mistake. A decision about an
  address belongs to `before_session`, which has it.
- `signUp` is `true` when the sign-in created the account: an attempt of kind `sign_up`, or
  an OAuth sign-in whose exchange created the user (kept on the attempt as `accountCreated`,
  so it survives a wait on an enrolment). A password reset's session is `false`.
- `amr` is sent in the canonical order and is a set; the docs say so.
- Never a password, a code, a token, an attempt id or a user agent.

### Where `before_session` is asked

In `finish`, and nowhere else: after the attempt's compare-and-set to `complete`, and
immediately before `Sessions.create`. `finish` is the only caller of `Sessions.create` in
the server (checked: `modules/flow/service.ts` is the one non-test call site), so the rule
"asked before every session a sign-in creates" has one place to hold. It is reached only
when every factor is proven, including a second factor and an enrolment the environment
requires. It is not asked at a refresh, a step-up, or for anything an administrator does:
none of them goes through `finish`.

**The enumeration argument.** A wrong password and an unknown address end before `finish`,
with `auth.invalid_credentials`, and the receiver is not called for either. `hook.denied` is
therefore seen only by someone who proved every factor, and tells them nothing they could
not learn by signing in. The side-by-side test holds it.

**Lockout.** The password step counts its guess and clears the count on a correct password
before `finish` runs, as without a hook. A denial adds no count and no clear: it is not a
failed guess (an operator's "no" must not lock a user out, nor be a way for one user's
denials to trip another's limit), and it clears nothing an attacker could not already clear
by knowing the password.

**Order with `before_sign_up`.** A sign-up asks `before_sign_up` before the account exists
and `before_session` after it was created. A denial or failure at `before_session` leaves
the account (verified) and no session. Rolling the account back was rejected: the account's
creation is committed, recorded (`user.created`) and may already have been delivered to a
webhook, and "deny the account" already has a hook of its own. `docs/hooks.md` says so.

### What a refusal at `before_session` leaves, and the attempt

No session, no tokens, no cookie, no `session.created`, no new-device notice, no sign-in
time: the hook throws before `Sessions.create`. The same two codes as a sign-up
(`hook.denied` with `params.code`, `hook.unavailable`); no new error code. Their default
messages were reworded to fit all three points ("This was not allowed." / "This is
unavailable right now. Try again later."), which made them shorter: `@tula/core`'s bundle
did not grow and its budget is unchanged.

**The attempt ends, for a denial and for a failure alike.** It is already `complete` when
the hook is asked: `finish` spends the attempt first, on purpose (two racing requests must
not make two sessions from one proof), and every error past that point, `session.limit_reached`
among them, already leaves it spent. The cost is stated in the docs: the last proof is used
up (an emailed code, a time step, **a backup code**), and after `hook.unavailable` the user
starts a new sign-in rather than repeating one step.

Rejected: asking before the compare-and-set and leaving the attempt open on a failure. The
steps that lead to `finish` are not repeatable once their proof is accepted (the code is
spent, the time step is used, a sign-up's account exists, an in-flow enrolment is
confirmed), so "open" would have meant a new kind of step that completes an attempt with no
proof presented. And two racing requests would each ask the hook.

### `before_token`: not an authority

The answer is judged on the body **as parsed**, not on a schema's output, by one Zod-free
function in the contract (`readHookClaimsAnswer`, over `checkCustomClaims`): exactly one own
key, `claims`, holding a plain object whose every key passes `isCustomClaimKey` (so no
reserved name: `sub`, `amr`, `auth_time`, `ext`, …, and not `__proto__`, `constructor` or
`prototype`) and whose every value is one string, number or boolean, within
`MAX_CUSTOM_CLAIMS_BYTES`. (Zod's record type drops a `__proto__` key silently, which is why
the raw value is what is judged.) The result is a copy built with `Object.fromEntries`.

**A rule-breaking answer is a failed call, whole.** `claims_invalid` or `claims_too_large`
is noted on the hook and the failure mode decides; none of the answer's claims is used, its
good ones included. Dropping only the bad claim was rejected: an application that authorizes
on two claims must not receive a token where one survived.

The claims reach a token only through `CustomClaims.build(template, facts, [hookClaims])`,
inside `ext`. A hook therefore cannot set a claim Tula issues, cannot change what the
session has proven, its user, its profile or its lifetime, and cannot touch the user record.
A test answers `sub`, `amr`, `emailVerified`, `userId` and `__proto__` and compares the
session and the token with ones made without a hook.

**Which side wins a key both set: the hook.** A template is the profile's default for every
user; a hook's claim is a statement about this user at this sign-in, which is the more
specific. It also lets an operator write a least-privilege default as a template constant
(`plan: free`) that a hook raises, and that remains when the hook fails under `allow`.
Rejected: the template winning (a constant would then silently mask the hook, with no
failure to see), and treating a collision as a failure (a template edit could then break
every sign-in).

**The cap is on the merged claims.** When the hook answers, the service measures its claims
together with the template's as configured at that moment (`CustomClaims.fits`): over the
cap is `claims_too_large`, a failed call. A refresh is never failed for the cap.

**Later, the hook's claims are kept and the template's are left out** (review round 1,
2026-10-08; this replaces "the whole namespace is dropped", which was wrong). A template
alone cannot exceed the cap and a hook's claims alone cannot, but the two together can: an
operator saves a larger template, or the user's address grows, after the hook answered.
Dropping all of `ext` then, as the first version did, removed the hook's claims from every
existing session until its next step-up, and an application that reads a restriction as a
present claim (`restricted: true`, a tenant id) failed open. So at issue, over the cap,
`CustomClaims.build` issues the hook's stored claims alone and leaves out **all** of the
template's (not the keys that did not fit: which of a template's claims a token carries
must not depend on their sizes), and logs the environment, the template's name and the two
byte counts, once per issue, with no key and no value. The row is not rewritten: when the
template shrinks, both are issued again. Only when a source alone is over the cap (which
the rules above exclude: a stored value that fails its own check is dropped by
`CustomClaims.stored` before any merge) does everything go.

The two moments differ on purpose. **When the hook answers**, claims that do not fit beside
the template are still the hook's failure (`claims_too_large`): there is someone to tell,
the failure shows on the hook where the operator looks, nothing is stored, and the hook's
`failureMode` decides. **When a template outgrows claims already stored** there is no call
to fail and nobody at the request to tell, so the more specific source is kept. Rejected:
"hook kept, template dropped" at answer time too (an operator would never learn that their
hook and their template do not fit together, and under `deny` they chose to be told), and
refusing a template at save because some session's stored claims would not fit beside it
(a save would then depend on every session's row).

### `before_token`: when it is asked, and what "inputs" means

**A session's inputs are what the question names**: the user, the session, the client kind,
the profile name, and `amr`. Of these only `amr` changes during a session's life, and only
through `Sessions.recordAuthentication` (a step-up; the enrolling session after an
authenticator is confirmed). So the hook is asked:

1. in `Sessions.create`, after the signing key is loaded and before anything is stored. The
   claims go on the row in the same insert (`sessions.hook_claims`) and into the first
   token. A session never exists without the answer its hook gave;
2. in `Sessions.recordAuthentication`, **every time**, before the write. The stored claims
   are **replaced** by what the hook says now: its claims, or none when there is no hook any
   more, it is off, or it failed under `allow`. Never merged, never kept.

**Not inputs**, and so no call: a refresh, the grace-window replay, a stateful session's
check (none reads `deps.hooks` at all; a test spies on it), a change of the JWT template
(its claims are read at every issue anyway), a change of the profile's configuration, a
change of the user, and a change, switch-off or removal of the hook itself. A session keeps
the claims it was given until it ends or steps up. The remedy for "this user's claims must
change now" is to end their sessions, which the docs say. Asking at a refresh was rejected
by the ticket and by arithmetic: every session refreshes about once a minute.

**Replace, not keep, at a step-up.** Keeping the old claims when the hook has gone or failed
would issue, with a fresh `auth_time` and a larger `amr`, an answer that was given about a
session that had proven less. An absent claim is read as "no" (ADR 0036); a stale one is
read as "yes".

**A concurrent step-up.** The hook is asked about `amr` as the service read it. The store's
write is a compare-and-set on those methods (`ifAuthMethods`, set equality, under the row's
lock in Postgres), so claims asked about one set of methods are never stored beside another.
On a miss the service reads the session again and asks again, three passes at most, then
`service.unavailable`.

### `before_token`: failure

- **At a sign-in, `deny`**: `hook.unavailable`, and nothing is created. The attempt is spent
  (it was before `before_session`).
- **At a sign-in, `allow`**: the session is created with no hook claims; the template's
  remain. `session.created` carries `claimsHookBypassed: true`.
- **At a step-up, `deny`**: the step-up fails with `hook.unavailable` and nothing about the
  session changes: not `amr`, not `auth_time`, not the claims, no `session.stepped_up`. The
  cost: what proved the step-up (a time step, an emailed code) is spent, and the user proves
  again. Rejected: stepping up anyway and keeping the old claims (stale, see above), and
  stepping up without claims (that is `allow`, which the operator did not choose: a session
  whose claims silently vanish under `deny` is the failure mode ignored).
- **At a step-up, `allow`**: stepped up, claims cleared, `claimsHookBypassed: true` on
  `session.stepped_up`.
- The one caller that swallows the error is the confirmation of an authenticator from a
  signed-in session (`Mfa.confirmTotp`): marking the enrolling session as stepped up is
  bookkeeping there, and its failure was already logged and ignored before hooks existed.
  The factor is on, the session is not stepped up, its claims are as they were.

Over the environment's ceiling the answer is `rate_limited` whatever the failure mode, as
for a sign-up.

### Stored on the session

Migration `0022_session_hook_claims`: `sessions.hook_claims jsonb null`, with the check
`sessions_hook_claims_bounds` (an object, at most 4,096 bytes as text: a backstop, the
contract's cap is 1,024). The row holds only the hook's own claims, never the merged ones:
the template's are read at every issue. Both adapters, the shared store suite and the
PGlite tests cover it.

**Read back, they are judged again** (`CustomClaims.stored`, the same `checkCustomClaims`):
a row is not trusted for having been written by this server. A value that breaks a rule is
dropped whole, with a warning that names the session and not the content, and the token is
issued without hook claims. Never a 500: this runs on every refresh.

A stateful session is asked for at creation like any other; its check
(`Sessions.authenticate`) and `POST /v1/admin/sessions/verify` answer with the stored claims
merged with the template's, so `auth()` of `@tula/nextjs` returns them for both session
types.

### Order, bounds and cost

`finish`: the attempt is spent; `before_session`; `Sessions.create`, which loads the signing
key, asks `before_token`, and only then stores the session. Both hooks are asked before any
session exists, so neither can leave a live session behind a refusal. The claims hook is not
asked when the session hook refused.

Each call ends at the hook's deadline (5 s at most), nothing is retried, and a sign-in asks
two hooks at most: 10 s at the most, 4 s at the defaults. A sign-up that completes in one
request can ask three (15 s, 6 s). A timeout sets `lastFailedAt` and
`lastFailureReason: 'timeout'` on the hook; a scenario shows it.

Two things are asked about and may then not happen. Under `sessions.onLimit: refuse_newest`
the store refuses the session after both hooks were asked (the limit is decided atomically
in the insert, which must come last). And the late check in `finish` for a second factor
confirmed during the attempt revokes the session it just created. In both, the endpoint was
told of a session that does not exist; a receiver must not treat a question as a record.

Counts: each point has its own bucket per environment. `before_sign_up` keeps 600 a minute
and its key. `before_session` and `before_token` have 3,000 each, the flow engine's ceiling
for steps that check a secret, because a call of either needs a sign-in or a step-up whose
every factor was proven.

Response caps: 1 KiB for a decision, 4 KiB for a claims answer (the claims are at most
1,024 bytes compact; the rest is room for the key and for JSON written with spaces).

### Events and the audit log

Booleans only, added as optional fields, so `EVENT_SCHEMA_VERSION` is unchanged:
`session.created.data.hookBypassed` and `.claimsHookBypassed`,
`session.stepped_up.data.claimsHookBypassed`. Present only when true. Not named for a
"token": anything that flags by key name (`secret`, `token`, `key`) would take it for a
credential. Nothing an operator typed is in an event or an audit entry: not the denial's
code (it goes to the client and to a log line), not a claim's key or value. The event canary
test runs the three new scenarios unmodified.

### SDKs

- `@tula/admin`: `TulaHookQuestion` is the union of three; `TulaHookClaimsAnswer` is new;
  `HOOK_QUESTION_TYPE_NAMES` has three members. A receiver narrows on `type`.
- `@tula/nextjs`: nothing changed. `auth().customClaims` already reads `ext`; a real-API
  test proves it returns a hook's claim, for a token session (through a refresh) and a
  stateful one.
- `@tula/core`: no code changed; it stays Zod-free and within its bundle budget.

### What a refusal costs that is easy to miss (review round 1, 2026-10-08)

**Single-use proofs are spent before the hook is asked**: a backup code, an authenticator's
time step, an emailed code, a passkey's counter. The order is not changed: asking before the
proof is what the design rules out (whether a hook was asked would then say something to
someone who cannot sign in), and giving a spent proof back invites its replay. The sharp
case is the default `deny` during an outage of the operator's endpoint: every sign-in with
a backup code burns one of ten and signs nobody in. `docs/hooks.md` says so, with the
advice that follows (an operator who cannot keep the endpoint up should weigh `allow`; a
refused user should not retry with backup codes). A test pins it (a refused sign-in with a
backup code leaves nine), so that a change is a decision.

**A refusal while a user enrols an authenticator inside a sign-in ends their other
sessions and undoes the enrolment. That order is kept.** Where the environment requires
two-step verification, `Mfa.confirmTotp` ends every other session of the user before it
turns the factor on (ADR 0025: the sessions that did not prove a factor end before anything
else); `finish` then asks `before_session`, and `Sessions.create` asks `before_token`. A
denial, or a failure under `deny`, removes the factor and its backup codes again, and the
sessions are already gone: the user is signed out on their other devices and enrols afresh
at the next sign-in. The concurrent-session rule could cause the same before this ticket; a
hook makes it reachable whenever the operator's endpoint refuses or is down. It is
accepted: it is safe (nothing is left that should not be), it happens at most once per
user (an enrolment inside a sign-in), and `docs/hooks.md` says it. Tests pin it for a
denial, a `before_session` that hangs and a `before_token` that hangs: the factor absent,
no backup code, no new session, the earlier session ended and denylisted.

Rejected (built in review round 1 and taken out again the same day): ending the other
sessions only once the attempt's session exists, after `finish`. It kept the user's sessions
through a refused sign-in, and cost a weaker guarantee in the place that guards it:

- a process that dies, or a sweep that fails, between `finish` and the sweep leaves the
  factor on beside sessions that never proved it, silently and until they expire;
- for the length of `finish` (up to the two hooks' deadlines) the factor is on beside such
  sessions, where before they were ended first so that a failure left nothing changed;
- under a concurrent-session rule that refuses the newest session, a user at the limit
  could no longer complete an enrolling sign-in, which today works because the enrolment
  has made room (a test now pins that it does).

Also rejected: asking `before_session` before the sweep, inside the confirmation. The hook
would be asked before the factor is proven, or from a callback between the proof and the
sweep with the attempt spent before the factor is confirmed; and the claims hook, asked as
the session is created, would still fail after the sweep.

### Conformance

The `hook` step's `answer` also takes a claims answer. Three scenarios, each with a
receiver (`needsWebhookReceiver`, skipped by name by CI's containerised targets, eight
names now) and an SDK journey: `sign-in denied by a hook`, `claims added by a hook` (the
claims asserted on the token, and a refresh that does not ask), `sign-in hook that times
out`.

### Not in this ticket

The dashboard's screen for hooks and hooks in `tula.config.ts` (TULA-59). Secret rotation
for a hook, a call log and a test question remain as listed below.

## 2026-10-08: Hooks in the dashboard and in the config file (TULA-59)

No route, schema, table or event changed. The config file's side is in
[ADR 0030](0030-config-and-apply.md) ("Hooks in the file"); this section is the screen.

### The screen is the points, not a list

`/w/…/e/<id>/hooks` draws one section per point of `HOOK_POINTS`, in that order, each with
its hook or the words that nothing is asked there. A list of hooks would leave a point
without one absent, and "no check at sign-up" is the thing an operator most needs to see.
A hook whose point this build does not know (a later server's) gets a section after the
three, with the point as text: it can be switched and removed, never edited, because the
form would send fields under rules the build cannot know.

### What weakens is the contract's rule, asked first

The dashboard calls `hookWeakenings(was, is)` with what the form would send and asks before
sending whenever it returns anything: `failureMode: 'allow'` (at creation or by a change),
switching a hook off, removing one that is on. The question says what is let through at
that point (a sign-up, a sign-in, a session without the hook's claims), and in a production
environment the point's name is typed. No second definition of which changes weaken: the
screen has two sentences per point (the check is gone, for `enabled`; a failed call is let
through, for anything else), so a rule the contract gains is asked about without a change
here, and gets words of its own when it is neither. A failure mode the build does not know is read as `deny` for the comparison,
so that a change to `allow` from it is still asked about.

Two things are confirmed although they weaken nothing: switching a hook **on** (from that
moment its receiver decides; never typed) and removing a hook that is **off** (its secret
is deleted for good; typed in production like any removal).

*Alternative:* a second dialog over the form for the question. The question is a stage of
the same dialog instead: one `<dialog>`, one focus trap, and for a creation the dialog that
asks is the one that must not be closed while the request that returns the secret runs.

The add and edit forms have no "enabled" field. A hook is created on; the switch is an act
of its own with its own confirmation. One form that could both loosen the failure mode and
switch the hook off would need a question about two things at once.

### The secret

Shown once by the dialog that created the hook, held in that dialog's state, under the
rules of every such dialog (`busy` while the request runs, `SecretRequestActions`,
`gcTime: 0`, `reset()` when the dialog lets go, the list refreshed from the hook-level
`onSuccess`, started and not awaited). There is no "show again" and no rotation: the screen
says to remove the hook and add it again.

### "Recent outcomes": what is shown, and what is not there to show

The ticket asks for recent outcomes as allowed, denied, failed and timed out. The server
keeps one fact per hook: `lastFailedAt` and `lastFailureReason` ("What the operator sees of
a failing hook", above), never cleared, written only for a failure. An allowed call and a
denied call leave nothing on the hook. So the screen shows **the last call that failed**:
when, the reason in words, and *Timed out* (`timeout`) told apart from *Failed* (every other
reason). It says, in the same row, that calls that were answered are not recorded. It does
not say "failing": a failure from last month is still the last failure.

*Alternative:* derive outcomes from the outbox (`hook.denied` and the `hookBypassed` flags
are events). Rejected: those are events of what happened to a user, kept 30 days after
they are settled, absent for an allowed call, and reading them would make a list endpoint
scan the outbox. It would also draw numbers that look like a call log and are not one.

*What a fuller version needs* (proposed, not built): additive columns on `hooks`, written
by a method beside `noteFailure` with no activity (bookkeeping, ADR 0012): the time and
outcome of the last call (`allowed`, `denied`, `failed`), and counters of each since the
hook was last changed. That is a write per sign-in on a row every sign-in reads, so it
wants a decision about contention (a counter in the rate limiter's store, flushed, is the
other shape). A list of recent calls is a table with retention, like
`webhook_delivery_attempts`, and must hold nothing of the question (it carries an email
and an IP address) and nothing of the answer but the decision.

### Tests

`apps/dashboard/src/hooks.test.tsx` (the screen against the fake API),
`secret-dialogs.test.tsx` and `environment-switch.test.tsx` (the secret, a typed address
and an open confirmation do not follow a switch; a registration held back in one
environment is never made in another), `features/hooks/words.test.ts` (every reason, point
and refusal has words; no file of the feature says "webhook" of a hook), and
`e2e/tests/dashboard/hooks.spec.ts`: a hook registered in the browser with `allow` (asked
about first) at a receiver that answers 500, a real sign-up in the example app that asks
it, the failed call then shown on the screen, the hook edited, switched off and removed,
with axe on every state and dialog.
