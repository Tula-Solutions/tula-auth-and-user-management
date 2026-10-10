# Conformance scenarios

Language-neutral descriptions of what a Tula server must do, as sequences of HTTP exchanges.
The same files are run:

- **in process**, by the API's own tests (`apps/api/src/conformance.test.ts`, part of
  `bun run verify`), against memory adapters and a controllable clock (the second instance is a
  second app over the same stores);
- **against a live server**, with `bun run conformance`;
- later, by each native SDK's test suite (Swift, Kotlin), so every client is checked against
  the same behaviour.

The TypeScript SDK does not run the JSON files: they describe HTTP exchanges, which
`@tula/core` exists to hide. Instead `apps/api/src/sdk-journeys.test.ts` drives the SDK's
public API against the same in-process server, and a guard there requires every scenario in
`scenarios/` to be a named journey or not applicable with the reason
([ADR 0021](../docs/adr/0021-core-sdk.md)). Which of the two, for that SDK and for every
other client, is written in one file: [`client-journeys.json`](client-journeys.json)
(["The client-journey list"](#the-client-journey-list)). **Adding a scenario means adding
its entry there and its journey.**

## Running against a live server

The server has to run with `TRUST_PROXY=true` (each scenario presents its own client address in
`X-Forwarded-For`, so per-IP limits don't couple scenarios) and has to send mail to a
[Mailpit](https://mailpit.axllent.org) the runner can read. `docker compose up -d` provides both
Postgres and Mailpit.

```bash
CONFORMANCE_PUBLISHABLE_KEY=tula_pk_dev_… \
CONFORMANCE_SECRET_KEY=tula_sk_dev_… \
bun run conformance
```

| Variable | Default | |
| --- | --- | --- |
| `CONFORMANCE_PUBLISHABLE_KEY` | required | A publishable key of the environment under test. |
| `CONFORMANCE_SECRET_KEY` | none | A secret key of the same environment. Without it, scenarios marked `needsSecretKey` are skipped. |
| `CONFORMANCE_BASE_URL` | `http://localhost:3003` | Origin of the API. |
| `CONFORMANCE_PUBLIC_URL` | `CONFORMANCE_BASE_URL` | The server's own `PUBLIC_URL`, when the run reaches it at another address. A [device-binding proof](#scenario-format) is signed for the address the server knows itself by, not the one the request was sent to. |
| `CONFORMANCE_MAILPIT_URL` | `http://localhost:8025` | Mailpit's web address. |
| `CONFORMANCE_SETTLE_MS` | `0` | For a run through one address in front of several instances ([below](#behind-one-address)): how long to wait after each step that changes the environment's settings. At most 60000. |
| `CONFORMANCE_WEBHOOK_RECEIVER_HOST` | none | An address of this machine that the server can reach, for the [webhook scenarios](#the-webhook-scenarios-need-a-receiver-the-server-can-reach): `127.0.0.1` for a server running on this machine in the `local` tier. Without it, scenarios marked `needsWebhookReceiver` are skipped. |
| `CONFORMANCE_SMS_INBOX_URLS` | none | The origins whose development SMS inbox the runner reads (`GET /v1/dev/sms/messages`), separated by commas: every instance of the deployment, each on its own address, because an instance keeps its own inbox (`http://localhost:3003,http://localhost:3004` for the packaged stack, also when the run goes through the proxy). The server needs `SMS_PROVIDER=dev`. Without it, scenarios marked `needsSmsInbox` are skipped. |
| `CONFORMANCE_SECOND_BASE_URL` | none | Origin of a second instance of the same deployment (same database, Redis and keys), e.g. `http://localhost:3004` for the packaged stack. Steps marked `"instance": "second"` go there. Without it they go to `CONFORMANCE_BASE_URL`, and the run's last line says `(one instance)`. |

Use a development environment: every run creates users (with `@example.com` addresses) and
audit entries, and leaves them there. A full run takes about ten minutes, most of
it waiting: 61 seconds for an address's email cooldown (five times), 30 for an authenticator to
move to its next code (twice), 11 for the refresh grace period, 6 for a settings change to
reach the second instance (three times), 95 for a session to reach its profile's absolute
timeout (`38-session-profile-timeouts`), 61 for a profile's step-up window to pass
(`42-step-up-window-per-profile`), and the OAuth scenarios' waits below. The runner computes authenticator codes from its own clock, so it
must agree with the server's to within a 30-second step.

The exit code is 0 when at least one scenario passed and none failed (a skipped scenario does
not fail a run; its line says why it was skipped). A failing step prints the
status, the error code and short plain values that differed. Tokens, long strings, objects and
arrays are described (`a string of 52 characters`), never quoted, and a value the scenario
generated or captured appears as its placeholder (`{{password}}`), because the output ends up
in CI logs.

## Behind one address

A real deployment is several instances behind a load balancer, and a client's requests land
on whichever instance is next. The Compose `app` profile has that arrangement: `lb`
(`docker/lb/nginx.conf`, round robin, port 3005) in front of `api` and `api-2`. To run every
scenario through it:

```bash
export TULA_MASTER_KEY=$(openssl rand -hex 32)
TRUST_PROXY=true OAUTH_MOCK_PROVIDER=true LB_CLIENT_ADDRESS=client \
API_PUBLIC_URL=http://localhost:3005 docker compose --profile app up -d --build
# seed and mint the two keys as above, then:
CONFORMANCE_BASE_URL=http://localhost:3005 CONFORMANCE_SETTLE_MS=6000 \
CONFORMANCE_PUBLISHABLE_KEY=tula_pk_dev_… CONFORMANCE_SECRET_KEY=tula_sk_dev_… \
bun run conformance
```

Three things differ from a run against one instance:

- **`CONFORMANCE_SETTLE_MS=6000`.** An instance caches the environment's settings and may serve
  the previous document for up to 5 seconds after another instance changed it (ADR 0018). The
  scenarios change settings and use them in the next step, which behind a load balancer lands
  on the other instance. With this set, the runner waits after every successful write to
  `/v1/admin/settings`. Without it, about half of the settings-changing scenarios fail with
  `auth.method_disabled` or a stale `GET /v1/client/config`: that is the documented delay, not
  a fault. It adds about six minutes to a run.
- **`LB_CLIENT_ADDRESS=client`.** The runner sends each scenario from an address of its own in
  `X-Forwarded-For`, playing the edge proxy; all scenarios from one address run into the
  per-address rate limits. By default the proxy overwrites that header with the peer it saw
  (what a real proxy must do); this setting passes the runner's header through. It lets any
  caller choose its rate-limit bucket, so it is for this run only.
- **`API_PUBLIC_URL`** is the proxy's address: it is the issuer of the tokens and where the
  mock provider's pages are reached.

The summary line ends `against http://localhost:3005 (one address, 6000 ms after each settings
change)`. That the requests really alternated is in the proxy's log, one line per request with
the instance that answered:

```bash
docker compose --profile app logs --no-log-prefix lb | grep -o 'upstream=[0-9.:]*' | sort | uniq -c
```

Steps marked `"instance": "second"` go to the one address like every other step in this mode.
The run against the two ports (`CONFORMANCE_SECOND_BASE_URL`) stays the one that proves a
particular request went to a particular instance. CI runs both (`self-host` in
`.github/workflows/ci.yml`).

## Scenario format

A scenario is one JSON file in `scenarios/`, validated against
[`scenario.schema.json`](scenario.schema.json) (generated from
`packages/conformance/src/scenario.ts`; do not edit it by hand). The JSON Schema describes the
shape only. The loader also enforces six rules it cannot express: a scenario with an
`auth: "secret"` step must set `needsSecretKey: true`, one with a `webhook` or a `hook` step must set
`needsWebhookReceiver: true`, one with an `smsCode` step must set `needsSmsInbox: true`, one with a `wait` longer than ten minutes must set `needsTestClock: true`, a request with the secret key cannot also carry an
`accessToken`, and `headers` cannot name a header the runner sets itself (`x-tula-attempt`
included: use `attempt`).

```json
{
  "name": "sign-out",
  "description": "What the scenario shows, in a sentence.",
  "variables": { "email": { "generate": "email" }, "password": { "generate": "password" } },
  "steps": [
    {
      "name": "start a sign-up",
      "request": {
        "method": "POST",
        "path": "/v1/client/sign-ups",
        "client": "ios",
        "body": { "email": "{{email}}", "password": "{{password}}" }
      },
      "expect": { "status": 200, "body": { "step": { "status": "needs_email_verification" } } },
      "capture": { "signUpId": "id", "signUpSecret": "attemptSecret" }
    },
    { "name": "read the emailed code", "emailCode": { "to": "{{email}}", "capture": "code" } },
    {
      "name": "verify the address",
      "request": {
        "method": "POST",
        "path": "/v1/client/sign-ups/{{signUpId}}/verify-email",
        "attempt": "{{signUpSecret}}",
        "body": { "code": "{{code}}" }
      },
      "expect": { "status": 200, "body": { "step": { "status": "complete" } } }
    },
    { "name": "let the grace period pass", "wait": "11s" }
  ]
}
```

- **Variables.** `{{name}}` in any string is replaced by a variable: a literal from `variables`,
  a generated value (`email`: a unique address; `password`: a long random password that passes
  every built-in policy; `uuid`: a random GUID, for an id a provider would supply;
  `snowflake`: a random decimal number in a string, for a Discord, X or Facebook user id; `phone`: a
  United States number in E.164 form that nobody has, from the `555-01XX` range kept for
  fiction), or a value an earlier step captured.
- **Request steps.** `auth` is `publishable` (the default), `secret` or `none`; `accessToken`
  adds `Authorization: Bearer …`; `client` sets `x-tula-client`; `attempt` sets
  `x-tula-attempt`, the secret of the attempt the request continues (capture `attemptSecret`
  from the step that starts the attempt and send `"attempt": "{{signInSecret}}"` on every later
  call for it; without it the server answers `flow.not_found`). `headers` adds any other
  header (`{ "If-Match": "{{etag}}" }`); the ones the runner sets itself cannot be replaced.
  `times` repeats the request.
  `instance` is `first` (the default) or `second`: which API instance of the deployment gets
  the request. A runner with only one instance sends both to it, so a scenario that uses
  `second` must also be true of a single server.
- **Expectations.** `status` must match exactly. `body` is matched as a subset: keys you leave
  out are not checked. Values compare literally, except `"$any"` (present and not null),
  `"$absent"` (missing or null), `{ "$not": value }` and `{ "$matches": "regex" }` (both need
  the value to be present). `bodyExcludes` lists strings the raw response must not contain.
  `claims` checks what a JWT in the body says: each key is the dot path of a token, each value
  is matched like `body` (a subset, with the same matchers) against the token's decoded payload:
  `"claims": { "session.accessToken": { "amr": { "$set": ["pwd", "otp", "mfa"] }, "auth_time": "$any" } }`.
  `{ "$set": [...] }` matches an array with exactly those members **in any order**: `amr` is a
  set, and its order is not part of the contract.
  The signature is not verified; an array, as everywhere, must match item by item.
  `headers` checks response headers by name (case does not matter), each matched like a `body`
  value against the header's text: `"headers": { "x-tula-can-still-sign-in": "false" }`.
- **Capture.** `capture: { "variable": "dot.path" }` stores a string from the response body;
  a path can index an array (`codes[0]`).
  `captureHeaders: { "variable": "ETag" }` stores a response header.
  `captureCookie: { "match": "tula_session_", "pair": "cookie", "value": "token" }` reads a
  cookie the response sets (the first whose name contains `match` and whose value is not
  empty): `pair` gets `name=value`, to send back in a `Cookie` header, and `value` the value
  alone. Cookie names depend on the deployment (the environment id, a `__Host-` prefix over
  https), which is why a cookie is found by part of its name. `captureJson:
  { "variable": "dot.path" }` stores any value, objects included, as JSON text; a later body
  sends it back with `{ "$json": "{{variable}}" }` in place of the value.
- **A device-binding proof.** `request.proof: { "key": "device", "nonce": "{{nonce}}",
  "capture": "usedProof" }` sends a DPoP proof (ADR 0043) in the `DPoP` header, signed by a
  software key the runner makes for that name: one key per name for the whole run of the
  scenario, a new one in every run, and **never a key in a scenario file**. The proof is for
  the step's method and for the target's public URL plus the step's path, without its
  query; every request gets a new proof, also under `times`. `nonce` is left out for a
  proof without one, and is usually a `DPoP-Nonce` header an earlier step captured with
  `captureHeaders`. `capture` stores the proof itself, so that a later step can send the
  very same one again as a plain header (`"headers": { "DPoP": "{{usedProof}}" }`); a
  request has a `proof` or a `DPoP` header of its own, never both. The public URL is the
  base URL unless `CONFORMANCE_PUBLIC_URL` says otherwise, on either instance.
- **Email steps** read the 6-digit code from the newest email to an address. `captureWrong`
  also stores a code that is guaranteed not to be the right one. Right after a resend the
  newest email can still be the previous one; no scenario resends yet.
- **SMS-code steps** (`smsCode: { to, capture, captureWrong?, not?, textContains?, textExcludes? }`) read the 6-digit code from
  the newest text message to a number, as an email step does for an address. With `not` (a
  code read earlier from the same number) the step waits, up to five seconds, for a message
  that holds another code: a sign-in code is sent after the request that asked for it has
  been answered, and until then the newest message is the earlier one. Against a live
  server the messages come from its development SMS inbox (`SMS_PROVIDER=dev`, the `local`
  tier only; ADR 0037), asked of every origin in `CONFORMANCE_SMS_INBOX_URLS` with the newest
  message across them taken; in process they are the memory sender's. The inbox lists a
  sign-in's message only once its code is stored, so a code this step reads can be presented
  by the next step at once: no step waits or tries again for that. The code is the last run
  of exactly six digits in the text: the message ends with the origin-bound line
  (`@host #123456`). A scenario with such a step sets `needsSmsInbox: true` and is skipped by
  a target without an inbox. A runner for another language needs an HTTP `GET` for it.
  `textContains` and `textExcludes` are strings the message's text must and must not hold,
  for an environment's own wording (ADR 0042); they are filled after the code is captured, so
  one can name it. A scenario holds the sentence and never the whole text: the last line
  names a host only the server knows. A failed check says which entry failed and nothing of
  the message.
- **Email-link steps** (`emailLink: { to, captureToken, captureAttempt?, url? }`) read the
  sign-in link from the newest email to an address that carries a code, and take it apart as
  the page it leads to does: the link token and the attempt id come from the URL's **fragment**
  (`#tula_link=…&tula_attempt=…`). `url`, when given, is what the link must be without its
  fragment, exactly: it shows that the link leads to the redirect URL that was asked for and
  has nothing in its query. Against a live server the link is read from Mailpit (the one
  message is fetched, since a link is not in a subject). A runner for another language needs a
  way to read an email's text to run these steps.
- **Email-message steps** (`emailMessage: { to, subjectContains, captureCode?, subject?,
  textContains?, textExcludes? }`) read one email as its reader would: the newest email to
  the address whose subject contains `subjectContains`. In this order: `captureCode` stores
  the one run of exactly six digits in the text (the step fails for none, or for two
  different ones); `subject` is what the subject must be, exactly; every entry of
  `textContains` must be in the plain-text part and none of `textExcludes`. The later checks
  can name the captured code. They exist for what a subject cannot say: an environment's own
  wording of a message ([docs/email-templates.md](../docs/email-templates.md)), where the
  code need not lead the subject, and a notice, which carries no code. The other email
  steps still find a code by a subject that leads with one, so a scenario that saves a
  template for a code message keeps the code first in its subject or reads it with this
  step. A scenario's own `{{name}}` is filled in before a request is sent: to send a
  template's placeholder, keep it in a literal variable (`"codeField": "{{code}}"`), which
  is not filled again. Against a live server the message is fetched from Mailpit; a target
  that cannot read an email's text fails these steps.
- **TOTP steps** (`totp: { secret, capture, captureWrong? }`) compute the 6-digit code an
  authenticator app shows **now** for a Base32 secret the API returned (RFC 6238: HMAC-SHA-1,
  30-second steps), e.g. `{ "name": "compute the code", "totp": { "secret": "{{secret}}",
  "capture": "code", "captureWrong": "wrongCode" } }`. "Now" is the wall clock against a live
  server and the test clock in process (the clock `wait` steps advance; a `Target` gives it as
  `now`). `captureWrong` also stores a code that is not the right one for the current step or
  the two either side. A server accepts a step's code once, the code that confirms an enrolment
  included, so a second use of the same secret needs a `wait` of `30s` before its `totp` step.
- `passkey`: play the user's authenticator in a WebAuthn ceremony (ADR 0027). The step names an
  `authenticator` (created on first use, kept for the scenario's run), takes the options a
  request step stored with `captureJson` (`create` or `get`, as `{{name}}`), the origin
  of the client data (below), and stores the browser-shaped response as JSON text in `capture`; send it with
  `{ "$json": "{{name}}" }`. A runner needs a software authenticator for it: a P-256 (ES256)
  discoverable credential, attestation format `none`, an ASN.1 DER ECDSA signature over the
  authenticator data and the SHA-256 of the client data. `userVerified: false`, `counter` and
  `synced` set the flags and the signature counter. The TypeScript runner's is
  `VirtualAuthenticator` (`packages/conformance/src/passkey.ts`, Web Crypto only). The request
  steps of a ceremony send the `Origin` header themselves (`"headers": { "Origin": "…" }`): the
  API verifies a page's response against the origin of the request that carries it.
  **The origin in the client data** is given in exactly one of two ways. `origin` is the
  string itself: a page's, or for an iOS app `https://` and the relying-party id (which the
  environment must also allow as an origin: the scenarios add it and restore the settings).
  `androidCertFingerprint` is the SHA-256 fingerprint of an Android app's signing
  certificate, and a runner writes the origin Android derives from it:
  `android:apk-key-hash:` and the fingerprint's 32 bytes as base64url without padding (the
  contract's `androidApkKeyHashOrigin`; a value that is not a fingerprint fails the step).
  The request steps of a native app's ceremony send **no** `Origin` and say
  `"client": "ios"` or `"android"`. A software authenticator can write any origin: these
  scenarios show which the server accepts, not what a phone writes.
- **ID-token steps** (`idToken: { audience, authorizedParty?, nonce?, email?, subject?,
  unverified?, givenName?, familyName?, expired?, provider?, capture }`) play a provider's
  native SDK (ADR 0045): the server's mock OAuth provider mints the ID token an app would
  have been handed, and the step stores it in `capture`, to be sent as the `idToken` of
  `POST /v1/client/sign-ins/{attemptId}/id-token`. The token says what the step says, right
  or wrong on purpose: `audience` is its `aud`, `authorizedParty` its `azp`, `nonce` the
  nonce a start step captured (leave it out for a token with none), `expired` a token past
  its time. The mock's tokens are not Google's (they are sealed by the server, not signed by
  a provider), so these scenarios show which claims the server accepts, not that Google's
  signature is checked: that is an API test with locally signed tokens. A live server needs
  `OAUTH_MOCK_PROVIDER=true`, as for the OAuth steps, and must be reached at a loopback
  address: the route that mints (`POST /v1/dev/oauth/id-token`) refuses any other `Host`
  and any request a browser's page could send. A runner in another language posts the
  step's fields, without `capture`, as JSON to that route and reads `idToken` from the
  answer. No token is ever written in a scenario file.
- **Webhook steps** (`webhook: { receiver, captureUrl }` or `webhook: { receiver, expect }`)
  play the operator's backend that receives webhooks (ADR 0034). The first form starts a named
  receiver, an HTTP listener the runner owns that answers every request `204`, and stores the
  URL to register as an endpoint's address. With `answers` (a list of HTTP statuses, 200 to
  599) the receiver answers its next deliveries with those, one each and in order, and `204`
  again after them: `"answers": [500]` is a backend that fails once and recovers. A delivery
  it failed is kept all the same, for a later step to check. The second takes the next delivery that reached it
  (`type` narrows it to one event type) and checks what a receiver must check: a `POST` of
  JSON; the Standard Webhooks headers `webhook-id`, `webhook-timestamp` (whole seconds, within
  five minutes of the server's clock) and `webhook-signature`, one of whose space-separated
  `v1,<base64>` entries is the HMAC-SHA256 of `<webhook-id>.<webhook-timestamp>.<body>` keyed
  with the base64-decoded part of `secret` (the `whsec_…` value the registration returned);
  a body that is an event of the contract with the `webhook-id` as its `id`; and `body`,
  matched as a subset like a response. `captureId` stores the event's id. Against a live
  server the step waits for the server's own worker (30 seconds at most); in process the
  target runs one round of it. A runner for another language needs an HTTP listener and
  HMAC-SHA256 for these steps. Receivers are stopped when the scenario ends. A scenario that
  needs the server's **retry** to be due uses an ordinary wait step for it (below): the first
  retry is five to six seconds after the failure, plus up to one round of the worker.
- **Wait steps** let time pass: a real sleep against a live server, a clock advance in process.
- **`cleanup`** (optional, beside `steps`) lists steps that run after the scenario's steps
  **whether or not they passed**, with whatever was captured before the failure. A scenario
  that changes the environment's settings puts them back there, so a failure half-way cannot
  break the scenarios after it. A cleanup step that fails fails the scenario.

Steps run in order and a scenario stops at its first failing step (its cleanup still runs).

## What is covered

| File | Shows |
| --- | --- |
| `01-sign-up` | The account is created only when the emailed code is verified. |
| `02-sign-in` | A wrong password and an unknown address get the same status, code and message. Timing is not compared. |
| `03-refresh-rotation-and-reuse` | Single-use refresh tokens, the grace period, reuse revoking the session. |
| `04-sign-out` | Sign-out ends the refresh token and the unexpired access token. |
| `05-password-policy` | The published policy and stable `password.*` errors. |
| `06-lockout` | Backoff after repeated wrong passwords, identical for an address with no account. |
| `07-admin-ban-and-audit` | Ban (a banned user with the right password is told so), unban, and an audit log without email addresses (needs a secret key). |
| `08-sign-up-existing-address` | Signing up with a taken address looks the same and changes nothing about the account. (That no usable code is sent for it is covered by the API's own tests; the runner cannot assert an email's absence.) |
| `09-verification-attempts` | A code dies after five wrong guesses. |
| `10-password-reset` | A forgotten password is replaced with an emailed code, and the old sessions end. |
| `11-two-instances` | Two instances behave as one server: a token from one is accepted by the other, a sign-out on one is refused by the other at once, and wrong passwords sent to either share one lockout. |
| `12-environment-settings` | Settings are replaced through the admin API, guarded by `If-Match` (428 without it, 412 when stale); the new password policy is enforced at sign-up and shown by `/v1/client/config` on both instances; the audit entry lists keys, not values (needs a secret key). |
| `13-attempt-binding` | An attempt id alone does nothing: a call without the attempt's secret, with a wrong one or with another attempt's is answered exactly like an unknown attempt and uses up nothing; the right secret then completes it, and no later response repeats the secret. |
| `14-email-code-sign-in` | With the email code enabled, a sign-in offers it whatever the address; asking for a code answers the same for an address with and without an account (and is rate limited the same); a wrong code is refused with the guesses left; a password-reset code is not a sign-in code; the right code signs in and proves the address; a user with no password gets the generic failure for any password (needs a secret key). |
| `15-email-link-sign-in` | A link leads only to an allowed redirect URL, matched exactly, with its token in the fragment; without the asking client's binding it is refused and not used up; with it, it is accepted and returns no tokens; only the client holding the attempt's secret completes; a used link is dead; an address with no account looks the same (needs a secret key). |
| `16-passwordless-sign-up` | A sign-up without a password is a validation error where one is required; where it is optional the account is created without one, signs in with an emailed code and never with a password; a sign-up that chooses a password works as before (needs a secret key). |
| `17-mfa-enrolment-and-sign-in` | A user enrols an authenticator: the secret and `otpauth://` URI are returned once, an unconfirmed enrolment counts for nothing, a wrong code does not confirm it, the right one returns ten backup codes. The password alone then yields `needs_second_factor` and no tokens; the authenticator's code completes, and the access token's `amr` is `pwd`, `otp`, `mfa`. |
| `18-mfa-lockout` | Six wrong second-factor codes are checked; after that every try is `rate_limited` with `Retry-After`, a correct backup code and a new sign-in attempt included: one count per user for both methods. |
| `19-mfa-code-replay` | An authenticator code is accepted once: the code that confirmed the enrolment does not sign in, the next step's code does, and it is refused on a second attempt. |
| `20-mfa-backup-codes` | A backup code completes a sign-in once (typed with spaces around it) and says how many are left; used again it is refused; a new set replaces the old codes. |
| `21-mfa-password-reset` | A password reset stops at `needs_second_factor` with no tokens, completes with the authenticator's code, ends the old sessions and keeps the factor. |
| `22-step-up` | A user without a factor steps up with the password (a fresh access token, no refresh token). With a factor, a token that does not say it was proven is refused on sensitive actions with `auth.step_up_required` and `params.methods`; the password alone does not step up, a backup code does, and the repeated action succeeds. |
| `23-mfa-admin-reset` | An operator removes a user's second factor: the user's access and refresh tokens are refused at once, and the next sign-in completes with the password alone (needs a secret key). |
| `24-mfa-required-policy` | Under `mfa.policy: required` a sign-in and a sign-up of a user without a factor stop at `needs_factor_enrolment`, enrol inside the attempt and complete with tokens and ten backup codes; the factor cannot be turned off (`mfa.required_by_policy`); the next sign-in asks for it (needs a secret key). |
| `25-oauth-sign-up-and-sign-in` | A sign-in through an OAuth provider: the start answers the provider's URL and a binding; the callback's state works once and hands the page a single-use, 60-second ticket in the fragment, never a token; the ticket is exchanged only with the starting browser's binding. A verified provider address creates an account and signs the same user in afterwards; an unverified one is refused (needs a secret key and the mock provider). |
| `26-oauth-account-linking` | Which account a provider identity signs in to: connected automatically only when both the provider's and the account's address are verified (`oauth.account_exists` otherwise); a signed-in user connects one from their profile unless it belongs to someone else; disconnecting the last way to sign in is refused (needs a secret key and the mock provider). |
| `27-oauth-second-factor` | A provider is a first factor: for a user with an authenticator the ticket exchange answers `needs_second_factor`, no tokens and a fresh attempt secret; the session exists only once the second factor is proven, and its `amr` names both (needs a secret key and the mock provider). |
| `28-step-up-email-code` | A user with no password and no second factor steps up with a 6-digit code emailed on request: the receipt never holds the code; asking again within a minute is `rate_limited`; a wrong code and a method the user does not have are refused; the right code returns a fresh access token (no refresh token) whose `amr` gains `email`, and works once. With a second factor, asking for a code and presenting one both answer `auth.step_up_required` naming the factor (needs a secret key and the mock provider). |
| `38-session-profile-timeouts` | A session lives by its profile as configured now: the token names it (`sp`), the absolute timeout ends an active session, and tightening the profile ends an older session at its next refresh. Waits 95 seconds. |
| `39-session-profile-selection` | `x-tula-session-profile` gets a profile only when the environment offers it (`clientSelectable`); anything else gets the client kind's built-in, never an error. |
| `40-concurrent-session-limit` | `sessions.maxPerUser`: `end_oldest` ends the oldest session at once; `refuse_newest` answers `session.limit_reached` until a place is free; an operator ends a user's sessions. |
| `41-stateful-session` | A `stateful` profile: sign-in sets one httpOnly cookie and returns no token; the cookie authenticates `/v1/client/me`; `POST /v1/admin/sessions/verify` returns the claims; another origin, a cross-site request and an unsafe request with no `Origin` are refused; ending the session is seen by the very next request, on both instances. |
| `42-step-up-window-per-profile` | A profile's `stepUpAfter` replaces the ten-minute window of routes that require recent authentication. Waits 61 seconds. |
| `47-webhook-delivered-and-signed` | An endpoint is registered with a secret key and its signing secret (`whsec_…`) is returned once, never by a read or a list; a user's creation is delivered to it with the Standard Webhooks headers, signed with that secret, as the typed event whose id is the audit entry's; the registration and a change are in the audit log by count and field name, never with the address or the secret (needs a secret key and a receiver the server can reach). |
| `49-webhook-retried-after-a-500` | A backend answers a delivery `500` and recovers: the delivery is `pending` with one attempt on record and cannot be sent again by hand meanwhile (`webhook.cannot_redeliver`, `delivery_pending`); a few seconds later the server sends it again with the same `webhook-id`, and the delivery log has both requests, a status code and a duration each. A test event arrives signed, marked `"test": true`, of a type the endpoint did not subscribe to, and is in the delivery log and not in the audit log. A delivered delivery is sent again by hand, with the same id, and is refused once the endpoint is off (`endpoint_disabled`). Waits 9 seconds (needs a secret key and a receiver the server can reach). |
| `48-webhook-refused-address` | The outbound guard at the moment an address is saved: a private address, the metadata service, a private address spelled as one number, private IPv6 and IPv4-in-IPv6 addresses, credentials and a non-http scheme are refused with `webhook.url_not_allowed` and a fixed `params.reason`, on a registration and on a change, and nothing of the address is repeated or stored (needs a secret key). |
| `43-settings-managed-by-config` | A replace that names its tool and config fingerprint (`x-tula-managed-by`, `x-tula-config-hash`) is recorded as the settings' manager; a later replace without them keeps the record and shows as `drifted`; one header without the other is refused. Cleanup restores the settings and removes the record. |
| `59-phone-number` | A signed-in user adds a phone number and proves it with a texted 6-digit code. Nothing is sent while text messages are off or no country is allowed, and only to a country on the list; the client config says only whether a number can be added. The receipt holds neither the code nor the number; asking again within the minute is rate limited; another user's code, a wrong code and a used code confirm nothing; a code asked for before its country was removed or text messages were switched off is not honoured after. Adding and removing are in the audit log without the number (needs a secret key and the development SMS inbox). |
| `70-password-history` | With `password.history` at 3, a signed-in user's change to the current password or to the one before it is refused with `password.reused` (422, `params.history`, a field error, nothing about which password matched), and so is a reset to either; the refused reset has not spent its code, and a password the user never had is accepted both ways. With the history back at 0 the first password is accepted again. Cleanup restores the settings. Waits 61 seconds (needs a secret key). |
| `71-email-wording` | A template whose body lacks the code its message needs is refused when saved (422, the field named), and so are a security notice given a code and any message, one that carries a code included, given something that reads as a link; nothing is stored. With a template saved for the verification code and one for the notice of a password set by an administrator, the sign-up's email has the environment's subject and words in the server's layout, the code read from its text completes the sign-up, and the notice has the environment's words followed by the server's own line of when it happened and its own sentence of what to do if it was not expected, with no link. Cleanup restores the settings. Reads whole emails (the `emailMessage` step), so the target must be able to (needs a secret key). |
| `72-sms-sign-in` | With the texted sign-in code on (`signIn.methods.smsCode`) and text messages on, a sign-in started with a phone number is offered `sms_code` beside the other first factors, whatever the number. Asking for the code texts it to the number exactly one account has proven; the answer holds neither the code nor the number, and asking again within the minute is `rate_limited`. A wrong code is `auth.invalid_credentials`; the right one signs the account in with `amr` of `sms` (never `email`, `pwd` or `mfa`). Such a session is not a recent authentication: a change to what protects the account answers `auth.step_up_required`, and a texted code is not among the ways to step up. Needs a secret key and the development SMS inbox (`needsSmsInbox`); the daily limit is raised while messages are sent, and cleanup restores the settings. |
| `73-sms-sign-in-unknown-number` | Asking for a texted sign-in code answers the same for every number: for one nobody holds, the step, its `prepared` part and the one-a-minute limit are those of a number that signs in, and no message goes (the usage counts hold no code for that destination). Every guess at such an attempt is `auth.invalid_credentials`. An email address that asks for a texted code is answered like an unknown number, and a number of a country the environment does not send to is refused whoever holds it. Needs a secret key and a server that can send text messages (`needsSmsInbox`); it reads no code. Not shown here, and covered by the API's tests (`modules/flow/sms-sign-in.test.ts`): the limiter's counters being the same for both kinds of number, a number two accounts hold, and one proven more than a year ago. Cleanup restores the settings. |
| `74-sms-sign-in-method-off` | A code texted while the method was on is not honoured once it is off. With `signIn.methods.smsCode` off the code is refused with `auth.method_disabled`, no new one can be asked for, and a sign-in started then is not offered the method; with text messages off, or the number's country taken off the list, the refusal is the one every text message gets. Nothing was used up by the refusals: with everything on again the same code signs the account in. Needs a secret key and the development SMS inbox (`needsSmsInbox`); cleanup restores the settings. |
| `75-native-app-identity` | An iOS app (team id, bundle id) and an Android app (package name, SHA-256 certificate fingerprints) are registered for the environment; an identifier that is not one is refused and a repeated app is a conflict. `GET /v1/environments/<id>/.well-known/apple-app-site-association` and `…/assetlinks.json` answer without a key, as cacheable JSON with no redirect, and name the registered apps only (`webcredentials`; the `get_login_creds` relation), follow a change, and are a 404 for an environment that does not exist. A fingerprint pasted in lower case without colons is served upper case with colons. The audit entry names neither the app nor a fingerprint. Expects an environment with no other native app; cleanup removes its two (needs a secret key). |
| `76-password-expiry` | With `password.expiryDays` at 1 and a day gone by, a wrong password is still `auth.invalid_credentials`, and the right one does not sign in: the step is `needs_new_password` with `reason: "expired"`, no strategies and no session. On `…/new-password` the expired password is refused as its own replacement (`password.reused`, `params.history` 1 with no history in the policy), a password the policy refuses leaves the attempt on the step, and a new one completes the sign-in; the attempt is then spent, the old password is wrong and the new one signs in without being asked for again. On the day it was set the password signs in as usual. Cleanup restores the settings. **Runs in process only** (`needsTestClock`: it waits a day). Not shown here, and covered by the API's tests: the boundary to the millisecond, a second factor or an enrolment coming first, the other sign-in methods being unaffected, and a password replaced elsewhere while the attempt waits (needs a secret key). |
| `77-sms-wording` | A text message template without its code, one that writes a code line of its own (`@host #code`) and one with something that reads as a link are refused when saved (422, the field named); nothing is stored. The preview route answers what would be sent for a draft, as text with the number of segments, refuses a draft a save would refuse (under `template.text`) and stores nothing. With a template saved for the code that proves a phone number, the texted message holds the environment's sentence, not the built-in one, and its code (the last run of six digits) confirms the number. Cleanup restores the settings. Reads a whole text message (`textContains`, `textExcludes` of the `smsCode` step), so the target needs an SMS inbox. |
| `78-sms-second-factor` | With a texted code offered as the second step (`mfa.smsCode`, off by default) and text messages on, a user with a proven number and no stronger factor enrols it under `/v1/client/me/factors/sms` with a fresh code texted to that number; a user with no number is `mfa.phone_number_required`. The token in hand does not say the step was proven until the session is refreshed, and then holds `sms` and never `mfa`. A sign-in with the password stops at `needs_second_factor` with `sms_code` as its only option and texts nothing until `second-factor/prepare` asks; the enrolment's code is not a sign-in's, asking again within the minute is `rate_limited`, a wrong code is `mfa.invalid_code`. Switched off afterwards, the step is still asked for and can be neither sent nor proven (`auth.method_disabled`): nobody is let through. Removing it leaves the number on the account. Both changes are in the audit log without the number. Needs a secret key and the development SMS inbox (`needsSmsInbox`); it waits out the one-a-minute limit of a number twice, raises the daily limit while messages are sent, and cleanup restores the settings. |
| `79-sms-second-factor-beside-authenticator` | A texted code is never used beside a stronger factor. A user with an authenticator app is not offered one (`available: false`), enrolling is `mfa.sms_not_allowed` at the start and at the confirmation, and their sign-in offers `totp` and `backup_code` only: asking for a texted code, or submitting one, is `flow.invalid_step` and sends nothing. Needs a secret key and the development SMS inbox (`needsSmsInbox`); cleanup restores the settings. |
| `80-sms-sign-in-with-sms-second-factor` | Two texted codes to one number are one factor. A user whose second step is a texted code and who starts a sign-in with the phone number is refused at the first factor with `mfa.needs_other_sign_in` (403), before a second message could be asked for: the attempt is not moved to a second step. Signing in with the password asks for the texted code as usual. Needs a secret key and the development SMS inbox (`needsSmsInbox`); it waits out the one-a-minute limit of a number twice, and cleanup restores the settings. |
| `81-device-bound-refresh` | A client that is not a browser sends a DPoP proof when it starts a sign-up: with no nonce it is asked for one (`device.nonce_required`, 400, a `DPoP-Nonce` header) and nothing starts; with it the session it ends in is bound to the key, its access token names the key (`cnf.jkt`), and a refresh with a proof rotates the token, on either instance. |
| `82-device-bound-refresh-missing-proof` | A bound session's refresh with no proof, or with something that is no proof, is `device.proof_invalid` (401): nothing is rotated, the session is alive, and the same refresh token works afterwards with a proof. |
| `83-device-bound-refresh-wrong-key` | A valid proof by another key is refused the same way, with or without a nonce, and the refresh route hands it no nonce. |
| `84-device-bound-refresh-replayed-proof` | A proof is accepted once: the same proof again, on the other instance, is refused, and a new proof with the same refresh token works. |
| `85-device-bound-refresh-stale-nonce` | A proof by the right key with a nonce the server does not accept, or with none, is asked for a fresh one and uses nothing up. (A nonce that aged out needs a clock the runner can move: the API's own tests.) |
| `86-device-bound-refresh-grace-window` | Inside the reuse grace window a rotated token gets the same next token only with a proof of the session's key; without one, or with another key's, it is refused and nothing is revoked. |
| `87-device-binding-unbound-session` | A sign-up that brings no proof ends in a session with no `cnf`, whose refresh needs no proof and ignores a `DPoP` header; a browser's start with a proof (`device.binding_not_supported`) and a start with an invalid proof are refused. |
| `88-app-link-redirect` | A registered app has no link path by default. Given exact paths (`appLinkPaths`; a wildcard, a query and a trailing slash are refused), Apple's file gains an `applinks` entry of exact components for that app and Android's the `handle_all_urls` relation, which goes again with the last path. An `https` URL the app opens is listed as a redirect URL like any other, and a provider sign-in started by a native client is redirected to exactly it, the ticket in the fragment; the ticket completes nothing without the binding. Uses the mock provider (needs a secret key); expects an environment with no other native app. |
| `89-custom-scheme-redirect` | A custom-scheme redirect URL in reverse-domain form is listed (a scheme without a full stop, `javascript:` and a query are refused; the audit entry says `weakened`). Google returns a native client's sign-in to exactly it; whoever receives the redirect completes nothing without the binding; a browser attempt is refused the scheme (`client_not_native`). Uses the mock provider (needs a secret key). |
| `90-unlisted-app-redirect` | With one app link and one custom scheme listed, eleven near misses (a trailing slash, another case, an encoded letter, a query, a longer path, two slashes for one, another app's scheme, a longer scheme) are each refused `request.redirect_not_allowed` with no reason; the two listed URLs are accepted as written. Uses the mock provider (needs a secret key). |
| `91-custom-scheme-without-pkce` | LinkedIn, which sends no PKCE, is refused a listed custom scheme (`params.reason: provider_without_pkce`) for a native client and a browser alike, before an attempt is made; it returns to a listed app link and completes; Google is accepted the same scheme. Uses the mock provider (needs a secret key). |
| `96-device-binding-required-refuses-unbound` | With `deviceBinding: "required"` on the mobile profile, a start from a native app that brings no proof is `device.binding_required` (400), for a sign-up and for a sign-in of an address with no account alike, and no attempt is made; something that is no proof is still `device.proof_invalid`. Needs a secret key; cleanup restores the settings. |
| `97-device-binding-required-bound-sign-in` | Under `required` a native app with a proof signs up as under `optional`: the nonce challenge, `cnf.jkt`, `deviceBound: true` in the session list, a refresh that needs a proof. Needs a secret key; cleanup restores the settings. |
| `98-device-binding-required-web-unaffected` | Under `required` a browser signs up with no proof, its session is not bound (`deviceBound: false`, no `cnf`), and a browser's proof is still `device.binding_not_supported`. Needs a secret key; cleanup restores the settings. |
| `99-device-binding-none-refuses-proof` | With `deviceBinding: "none"` on the mobile profile, a native start that brings a proof, or something that is no proof, is `device.binding_not_supported` before anything is judged; the same start without one ends in a session that is not bound. Needs a secret key; cleanup restores the settings. |
| `100-native-google-sign-up-and-sign-in` | A native app signs a user in with the ID token Google's SDK hands it, with no browser: the start (`POST /v1/client/sign-ins/id-token`, `ios` and `android` only, the provider and nothing else in its body) answers an attempt and a nonce the server made; the exchange (`…/{attemptId}/id-token`) takes the token and nothing else. The first exchange creates the account, verified and without a password; the next, from the other platform's app, signs the same user in. A token is accepted for the provider's own client id asked for by a listed app (`aud` and `azp`, as Android issues it) and for a listed client id alone (as iOS does). `amr` is `fed`; no cookie is set; the token, the nonce and the client ids are in no audit entry. Uses the mock provider (needs a secret key). |
| `101-native-google-account-linking` | Which account an ID token signs in to is decided as after the browser round trip: connected automatically to an existing account only when both addresses are verified; an unverified account is `oauth.account_exists`, and an address Google does not vouch for is `oauth.email_unverified` and creates no user. Uses the mock provider (needs a secret key). |
| `102-native-google-id-token-refused` | A token issued for another app (`aud`), a token for our audience that another app asked for (`azp`), a token with another nonce or none, an expired token, a token for a client id nobody listed and a string that is no token are each `auth.invalid_credentials`: the same answer whichever check failed, no account, no session. Once an administrator lists a client id on the provider, its tokens are accepted. Uses the mock provider (needs a secret key). |
| `103-native-google-id-token-used-once` | A token is judged once per attempt. Presented again on its own attempt, which is complete, it is `flow.not_found`; on a new attempt, which has another nonce, `auth.invalid_credentials`; and a right token after a wrong one for the same attempt is refused too. While the provider is switched off the exchange and the start are `auth.method_disabled`, with nothing used up: the same attempt and token complete once it is back on. An attempt started with an identifier takes no ID token (`flow.invalid_step`). Uses the mock provider (needs a secret key). |

Scenarios assume the default settings (the `recommended` password policy and the default
session profile). `12-environment-settings` changes the environment's settings while it runs
(the app name, and a 14-character minimum password that every generated password still meets)
and puts the original document back in its last steps; if it fails before that, the changed
settings stay until you restore them with `PUT /v1/admin/settings`. Scenarios 14 to 16 enable
the email methods (and, in 16, an optional sign-up password) and 24 requires two-step
verification; each restores the original document in `cleanup` steps, which run even when a
step fails. The other two-step scenarios (17 to 23) assume the default `mfa.policy`, `optional`. An environment that had
never saved settings ends the run with a saved copy of its defaults (the same behaviour, but
`PASSWORD_POLICY` and `CORS_ORIGINS` no longer apply to it). Browser delivery of the refresh cookie is not covered; apart from `41-stateful-session` (which allows its own origin, `https://app.sessions.example`, and sends it as `Origin`) scenarios use a native client
kind so tokens arrive in the response body. For the same reason the origin rule for browser
attempts (`request.origin_not_allowed`) is covered by the API's own tests, not by a scenario:
which origins a deployment allows is not something a scenario can assume. That a session older
than ten minutes is asked to step up is covered by the API's own tests, not by a scenario: a
live run would have to wait those ten minutes. `22-step-up` shows the same refusal through a
token that lacks the second factor. A backup code typed in another case or with a space for
its dash is covered there too; a scenario can only add spaces around a captured value. The email-link scenario
uses the redirect URL `https://app.conformance.example/auth/link`, which it adds to the
allow-list itself; nothing is ever fetched from it. That an address with no account is sent a
notice with no code and no link is covered by the API's own tests: the runner cannot assert
what an email does not contain.

### OAuth scenarios need the mock provider

Scenarios 25 to 28, 57, 58, 60 to 63 and 66 to 69 sign in through an OAuth provider (28 to get a user with no password; 57 and 58 through Microsoft, 60 and 61 through Discord, 62 and 63 through LinkedIn, 66 and 67 through X, 68 and 69 through Facebook). They use the server's **mock provider**:
start the server with `OAUTH_MOCK_PROVIDER=true` (accepted only with `ENVIRONMENT=local`). An
`oauth` step plays the user at the provider: it posts the consent form to the path of the
`authorizationUrl` a start answered (`email`, `subject`, `unverified`, `deny`; for Microsoft
`tenantId` and `objectId` in place of `subject`, and `unverified` leaves the verified-domain
claim out; for Discord, X and Facebook a `subject` is a decimal number in a string, and
for X and Facebook an `email` is dropped, as neither is asked for one), calls the
callback the answer redirects to, and reads the ticket (`captureTicket`, `captureAttempt`) or
the error (`expectError`) from the fragment of the URL the callback redirects to. Nothing is
followed automatically, and every request goes to the target's base URL. `captureCallback`
keeps the callback's path so a later step can replay it (`callback`). `expectRedirectTo`
is the URL the callback must redirect to, compared exactly with everything in front of the
fragment (a page, an app link or a custom scheme such as `com.example.app:/oauth`); a
failure never repeats where it went instead. The scenarios set the
`google` provider's credentials (57 and 58 the `microsoft` provider's, 60 and 61 the
`discord` provider's, 62 and 63 the `linkedin` provider's, 66 and 67 the `x` provider's,
68 and 69 the `facebook` provider's, 91 the `linkedin` provider's too) at the start and
remove them in `cleanup`: do not run them against an environment whose credentials for that
provider you want to keep. They add about 95 seconds
(a 61-second wait for a ticket to expire and a 31-second one for the next authenticator code).

### The phone number scenario needs the development SMS inbox

`59-phone-number` reads the code texted to a number. Start the server with `SMS_PROVIDER=dev`
(accepted only with `ENVIRONMENT=local` and a loopback `PUBLIC_URL`) and name every instance
in `CONFORMANCE_SMS_INBOX_URLS`. Without the variable the scenario is skipped and its line
says why. The numbers it uses are from the range kept for fiction, and nothing is sent to
them: the inbox is the server's memory. The scenario switches the environment's `sms` setting
on, to the United States only, and puts the original settings back in `cleanup`.

### The webhook scenarios need a receiver the server can reach

`47-webhook-delivered-and-signed`, `49-webhook-retried-after-a-500` and
`50-webhook-secret-rotated-with-an-overlap` each register a
listener the runner starts as a webhook endpoint, and the server has to be able to call it. The server calls an operator's address only through
its outbound guard, which refuses private and loopback addresses and plain `http`, except
loopback and `http` in the `local` tier. So against a live server they run only where
that server is in the `local` tier **on the runner's own machine** (`bun run dev`), with
`CONFORMANCE_WEBHOOK_RECEIVER_HOST=127.0.0.1`. Anywhere else they are skipped, and each line
says why (`needs a webhook receiver the server can reach`): a server in a container sees the
runner's machine at a private address, and a remote one would need a public `https` listener.
The guard is never loosened to make a scenario run. CI's `self-host` jobs run the server in
containers and therefore skip these three, **and only these three, by name**: the job compares
the set of skipped scenarios with that list and fails on any difference, in either direction.
All three run in process as part of `bun run verify`, through the real guard and a real socket on
loopback.

That a **packaged** server delivers a webhook at all is shown by another CI job,
`self-host-worker`, without a scenario and without the runner's listener: its receiver is a
container in the webhook worker's own network namespace, reached on the worker's loopback
(`docker/worker-check/compose.yml`, `scripts/worker-check/check.ts`). It runs the stack with
`WEBHOOK_WORKER=separate`. The scenarios themselves are for a deployment whose API instances
deliver (the default): `49` asks for a test event and for a delivery to be sent again, which
a deployment with a separate worker refuses (`501`, `worker_separate`).

`49` needs time to pass for the retry. In process its `wait` steps move the test's clock and
the `webhook` step runs a round of the worker; against a live server they are real sleeps and
the step waits for the server's own worker. Nothing else is needed of a target.

`51-sign-up-denied-by-a-hook` and `52-hook-that-times-out` use the same receiver through a
`hook` step ([ADR 0035](../docs/adr/0035-hooks.md)): a step with `answer` scripts how the
receiver answers every question from then on (an answer of the contract, `{ "status": 500 }`,
or `"hang"`), and a step with `expect` checks the next question that arrived (a signed `POST`
whose body is a question of the contract and not an event) or, with `{ "nothing": true }`,
that the hook was not asked. A hook is asked inside the request that causes it, so nothing is
waited for. They need a receiver the server can reach for the same reason, are skipped the
same way, and are in CI's list of skipped names with the three above (five in all). Each
registers the environment's one `before_sign_up` hook with the shortest deadline (100 ms) and
removes it in `cleanup`: while one of them runs, every sign-up in that environment is asked,
so they are not run beside other scenarios against the same environment. What a scenario
cannot show (a name re-pointed at a private address between the save and the call, an answer
after the deadline, every malformed answer, a secret that does not open) is in the API's own
tests (`apps/api/src/modules/hook/`).

`54-sign-in-denied-by-a-hook`, `55-claims-added-by-a-hook` and `56-sign-in-hook-that-times-out`
are the same for the two later points (`before_session`, `before_token`): the same `hook`
step, whose `answer` may also be a claims answer (`{ "claims": { … } }`), the same receiver,
the same skip, and three more names in CI's list (eight in all). `54` and `56` register the
environment's `before_session` hook and `55` its `before_token` hook, each removed in
`cleanup`; while one runs, every sign-in in that environment is asked. `55` reads the claim
from the access token, refreshes and reads it again, and checks the receiver was asked once.
What they cannot show (a step-up asking again, a refresh inside the grace window, an answer
that breaks a rule of the claims, stored claims that no longer pass) is in
`apps/api/src/modules/session/hook-claims.test.ts` and
`apps/api/src/modules/flow/session-hook.test.ts`.

`48-webhook-refused-address` needs no receiver and runs everywhere. It leaves out one half of
its subject on purpose: that an address which passed when it was saved is refused **when a
delivery is made** (its name was pointed at a private address meanwhile). A scenario cannot
change what a name resolves to, so that half is covered by the API's own tests
(`apps/api/src/modules/webhook/service.test.ts`, "the outbound guard at delivery time") with a
resolver the test controls. The scenario stores one endpoint, on the public address `1.1.1.1`,
switched off: nothing is ever sent to it.

### A scenario that waits longer than a run can sleep

`76-password-expiry` needs a password to be a day old, and `password.expiryDays` cannot be
less than one. Against a live server a `wait` is a real sleep, so a scenario whose `wait` is
longer than ten minutes sets `needsTestClock: true` (the loader refuses it otherwise) and
runs only where the target's `wait` moves the clock the server reads: in process, as part of
`bun run verify`. A live run skips it and says why (`needs a clock the runner can move`),
and CI's `self-host` jobs have it in their list of skipped names. No route and no setting
exists to age a password on a running server, on purpose: either would be a way to expire
every user's password at once.

### The dashboard's session is not a scenario

Scenarios 44 and 45 cover what a secret key can observe of step 1.15: a user's session list,
ending one session, the audit log's `actorType`, `from` and `to`, and the rules of a request
that says it is the dashboard's but has no session. Signing in to the dashboard and the
`/v1/instance/*` routes are **not** scenarios: they need the deployment's `TULA_ADMIN_TOKEN`
and a cookie carried from one step to the next, and the format has neither (there is no
`instance` credential). They are covered by the API's route tests
(`modules/control-plane/*.test.ts`, `admin-via-dashboard.test.ts`).

## The client-journey list

[`client-journeys.json`](client-journeys.json) says, in one place, what every client's test
suite does about every scenario and about every named client behaviour. It is validated
against [`client-journeys.schema.json`](client-journeys.schema.json) (generated from
`packages/conformance/src/client-journeys.ts`; do not edit it by hand). It is JSON so that
the Swift and Kotlin suites read the file the TypeScript one reads.

```json
{
  "clients": {
    "core": { "description": "@tula/core, the TypeScript client. …", "suite": "exists" },
    "swift": { "description": "The Swift SDK (native/swift). No suite yet.", "suite": "planned" }
  },
  "behaviours": {
    "concurrent_refresh": {
      "description": "Calls that need a token at the same moment … share one refresh request and one result.",
      "clients": { "core": { "decision": "journey" } }
    }
  },
  "scenarios": {
    "sign-up": { "core": { "decision": "journey" } },
    "two instances": {
      "core": { "decision": "not_applicable", "reason": "a property of the deployment …" }
    }
  }
}
```

- **A client** is one of a closed list: `core` (`@tula/core`), `expo`, `swift`, `kotlin`.
  Each says whether its suite `exists` or is `planned`.
- **A decision** is what one client does about one scenario or behaviour:
  - `journey`: the client's suite has a test of that name;
  - `not_applicable`, with a `reason` of at least 41 characters that neither begins nor
    ends with white space (padding is not a reason; the schema says both): nothing a client
    of that kind does can reach it. A reason may name, in double quotes, the scenario whose
    journey covers the client's side of it; that journey has to exist;
    "Nothing" means in this version or any other: it is never "not yet";
  - `not_built`, with a `ticket` (`TULA-` and a number: the issue whose work turns the
    entry into a `journey`) and a `reason` under the same rules: a client of that kind does
    reach the scenario, and this client has no call for it yet. It is a debt with a name;
  - `undecided`: nobody has decided. Leaving the client out of an entry says the same, and
    that is how the planned clients are written today: no entry at all.
- **`undecided` is allowed only while the client's suite is `planned`.** For a client whose
  suite `exists`, every scenario needs `journey`, `not_applicable` or `not_built`, every
  behaviour `journey` or `not_applicable`, and that client's guard fails otherwise. A
  planned client's missing decisions fail nobody.
- **`not_built` is for a scenario, of a client whose suite `exists`.** A behaviour cannot be
  `not_built` (the schema has no such variant for one: a behaviour is what a client does on
  its own between requests, and a client that exists either does it or has a fault). A
  planned client cannot have one either (nothing of it is built, so a ticket per scenario
  would be a guess): that is a rule of `clientJourneyListProblems`, not of the schema. A
  `not_built` scenario with a test behind it is built, and its entry is out of date: the
  guard fails. What a client has not built is counted by `notBuilt(list, client)`; each
  suite's own test holds the number, so that it shrinks on purpose and never grows
  unnoticed. Today: `core` none, `expo` 9 (TULA-48: 1, the emailed link; TULA-55: 8).
- **A scenario** is keyed by its `name` (not its file name), and the entries are in order of
  name, compared by UTF-16 code unit (upper case sorts before lower case). An entry has one
  place, so two branches that each add a scenario seldom touch the same lines.
- **A key is written once**, in every object of the file: a scenario's name, a behaviour's
  id, a client inside an entry, the keys of a decision, the top-level keys. JSON does not
  say which of two equal keys counts (`JSON.parse` keeps the last, silently; another parser
  may keep the first), so a decision written twice could be a different decision for each
  reader, and no JSON Schema can see it. `loadClientJourneys`, which every TypeScript reader
  uses, refuses such a file from its text (`duplicateJsonKeys`). **A reader in another
  language must refuse it too**: with a parser that fails on a duplicate key, or with the
  same check of the text before parsing. Keys are compared as the strings they spell, so
  `"sign-in"` is `"sign-in"`.
- **A `pattern` in the schema is an ECMAScript regular expression**, as JSON Schema says,
  and `$` there is the end of the text and nothing else. In Python's `re`, Ruby and PCRE
  without its dollar-end-only option `$` also matches before a final line break, so a
  reason that ends in one would pass the reason's pattern (`^\S[\s\S]*\S$`). A reader in
  another language validates with a JSON Schema validator that implements ECMAScript
  patterns, or checks itself that a reason neither begins nor ends with white space. The
  same holds for a `ticket` (`^TULA-[0-9]+$`): `TULA-48` followed by a line break is not
  one.
- **What a reader in another language does about `not_built`**, beside validating the file
  against the schema: refuse it for a client whose suite is `planned`; fail when its own
  suite has a test for a scenario the list says it has not built; hold a reason's quoted
  journeys to its suite as for `not_applicable`; and count its own `not_built` entries in a
  test of its suite. Never read `not_built` as `not_applicable`: the first is a promise.
- **A behaviour** is something a client does on its own, between requests, which no HTTP
  scenario can show. The ids are a closed list (`CLIENT_BEHAVIOURS` in the same source
  file), each with one sentence that says what it means for every client:

  | Id | Where `@tula/core` proves it |
  | --- | --- |
  | `concurrent_refresh` | `sdk-journeys.test.ts`: "an expired access token is refreshed before use; 10 concurrent calls share one refresh" |
  | `refresh_without_answer` | `sdk-journeys.test.ts`: "one lost response: …" and "both tries lost, then asked again inside the grace period: …" |
  | `unknown_step_not_supported` | `sdk-journeys.test.ts`: "a step from a newer server is handed on as it was sent: …". `@tula/core` draws nothing; the screen is `@tula/react`'s, tested in [`sign-in.test.tsx`](../packages/react/src/components/sign-in.test.tsx) |
  | `session_kept_through_failed_refresh_offline` | `sdk-journeys.test.ts`: "offline when the token runs out: …" |

### How a suite is held to it

Two functions of `@tula/conformance` (`packages/conformance/src/client-journeys.ts`) say
what is wrong, as sentences; a suite expects both to return nothing.

- `clientJourneyListProblems(list, scenarioNames, client)`: an entry that names no scenario,
  entries out of order, everything that is undecided for `client` when its suite exists
  (a scenario with no entry is undecided for every client), and a `not_built` entry of a
  client whose suite is only planned.
- `clientSuiteProblems(list, client, { journeys, behaviours })`, given what the suite's tests
  registered: a `journey` with no test, a test for what the list says is not applicable, is
  not built or has not decided, a reason (of either kind) that points to a journey the
  suite does not have, and a suite whose client is still `planned`.

A third, `notBuilt(list, client)`, is no check: it returns the scenarios the client has
not built, each with its ticket.

**What a suite registers is that a test is declared, not that it ran.** A journey inside a
skipped block would so count as covered. For a `bun:test` suite a third function closes
that: `testsThatMayNotRun(source)` reads the suite's own file and names every member
`skip`, `todo`, `only`, `if`, `skipIf`, `todoIf` and `failing` in it (after a dot, with any
white space or line break round the dot, or as a quoted name in brackets; called there or
only read, so an alias is found where it is made) and every `xit`, `xtest` and `xdescribe`.
It reads text, so the same spelling in a comment or a string is found too, and reworded.
It does not see a member taken out by destructuring (`const { skip } = test`), a name put
together at run time, or a comment between the dot and the name. A suite in another language
needs its own answer to the same question (registering a journey when its test finishes,
or failing the run when any test was skipped). None of this shows that a test asserted
anything; that stays the test's own business.

The journeys of the TypeScript clients are one function, `sdkJourneys(target)`
(`apps/api/src/testing/sdk-journeys.ts`): `journey('<scenario name>', '<title>', …)` and
`behaviour('<id>', '<title>', …)` register a test as it is declared, and the guard at its
end calls the three functions for the target's client. `@tula/core`'s suite is
`apps/api/src/sdk-journeys.test.ts`, which runs it for `core`; `@tula/expo`'s is
`packages/expo/src/journeys.test.ts`, which runs it for `expo` through that package's
client (kind `ios`, a stand-in for the secure store, no DOM) and adds its own journeys. A
journey that needs a browser, a provider, a passkey or a device key is declared only for a
target that has one; for the other the file says `not_built` with the ticket that adds it
(or `not_applicable`, where no client of that kind ever could), or the guard fails. A suite in another
language reads the same file and does the same from the JSON Schema and the rules above;
the fixtures in `packages/conformance/src/client-journeys.test.ts` are the cases it has to
get right.

### A new scenario

Add one entry, at its place by name, with a decision for every client whose suite exists
(a client that cannot run it yet says `not_built` with the ticket, never `not_applicable`):

```json
    "my new scenario": { "core": { "decision": "journey" } },
```

and the journey it promises. Until both are there, the guard of every such client fails.

### A new client

The change that adds a client's suite sets `clients.<client>.suite` to `"exists"`. From then
on every scenario and every behaviour needs that client's decision, so the same change
writes them all; `clientSuiteProblems` refuses a suite whose client still says `planned`.
Never set a client back to `planned` to get its suite green, and do not write decisions for
a client nobody has built a suite for.

### A new behaviour

Add the id to `CLIENT_BEHAVIOURS`, run `bun run --filter @tula/conformance schema:generate`,
describe it in the file and decide it for every client whose suite exists.

## Adding a scenario

1. Add `scenarios/NN-name.json` and list its name in `apps/api/src/conformance.test.ts`.
2. `bun test apps/api/src/conformance.test.ts` runs it in process.
3. Add its entry to [`client-journeys.json`](client-journeys.json) and the journey that
   entry promises (["A new scenario"](#a-new-scenario)).
4. If you changed the format itself, run `bun run --filter @tula/conformance schema:generate`.
