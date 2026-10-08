# ADR 0035: Hooks, and the hook before sign-up

- **Status:** accepted
- **Date:** 2026-10-08
- **Ticket:** TULA-45 (phase 2, step 2.3; the tracer for hooks)

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
more points (before a session is created, before a token is issued), a dashboard screen and
hooks in `tula.config.ts` are later tickets and are not built here.

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
| `email` | The address the account would be created for, normalised (the form an account is unique by). It is what a sign-up validator exists to judge. |
| `method` | `password`, `passwordless` or `oauth_<provider>`: a closed list. An operator may trust a provider's verified address more than an emailed code. |
| `client` | The kind of client the sign-up started from (`web`, `ios`, …): a closed list. |
| `ipAddress` | The address the request that would create the account came from, as the server knows it, or `null`. Fraud and abuse checks (a rate of their own, a country rule, a known-bad range) are the second thing a validator is for. |

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
| First sign-in with a provider | `OAuth.resolveAccount`, on the row "no identity, a verified provider address, no user has that address", immediately before `users.create`; once per call even when the insert loses a race | The exchange has already checked the ticket and the browser's binding, and the provider has proven the address. The rows beside this one already answer differently (`oauth.account_exists`, a link, a sign-in), so being asked or not says nothing new. A known identity, an unverified or missing address, and an address that has an account never ask. | Each call spends one provider round trip and one ticket: the `oauth` and `verify` ceilings (3,000 a minute each) and the per-IP limits of the start, the callback and the exchange. |
| An administrator creating a user | Never | It is the operator's own act; the validator is the operator's too. | — |

On top of those, **every environment has a ceiling on hook calls of its own**:
`HOOK_CALLS_PER_MINUTE`, 600, counted just before a call and only where there is a hook that
is on. The password paths were already held to 600 a minute by the email ceiling; the
provider path was not (3,000), and this is the bound that is about the operator's endpoint
whatever path led there. One attacker, then, causes at most ten calls a second to an
operator's endpoint, and for each of them must own a fresh inbox or provider account. Over
the ceiling the request is refused (`rate_limited`) and the attempt is left as it is.

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

- Hooks before a session is created and before a token is issued (and the claims answer).
- Secret rotation for a hook.
- A hook in `tula.config.ts`; `tula apply` refusing `hookWeakenings` under `--yes`.
- The dashboard screen, with its confirmation for a weakening.
- A log of calls, and a "test this hook" request.

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
