# ADR 0043: Device binding on refresh

- **Status:** accepted
- **Date:** 2026-10-09
- **Ticket:** TULA-19 (phase 2, step 2.10)

## Context

A refresh token is a bearer credential: whoever holds it is the session
([ADR 0008](0008-sessions.md)). Rotation and reuse detection bound the damage of a copied
token (one of the two holders is caught at the next refresh, and the session ends), but
they do not stop the copy from working until then, and a thief who refreshes first and
keeps refreshing is only caught if the owner's app comes back.

A phone can hold a private key that cannot be copied off it (the Secure Enclave, StrongBox).
A session whose refresh needs a signature by such a key is worth nothing without the
device. This ADR is that: the shape of the proof, when a session is bound, what a refresh
of a bound session requires and in which order, what is remembered and where, and what the
feature does not show. The native SDKs that hold a hardware key are later tickets
(TULA-31 to TULA-35); this step is the server, the contract, the headless TypeScript client
with a software key, and the conformance suite.

## Decision

### The proof is RFC 9449's DPoP proof, with one algorithm

A proof is a JWT in the `DPoP` request header, made for one request and signed by the
device's key:

- header: `typ: "dpop+jwt"`, `alg: "ES256"`, and `jwk`, the **public** half of the key;
- payload: `htm` (the request's method), `htu` (the address, below), `iat` (seconds),
  `jti` (a unique id) and `nonce` (the server's, below).

The server's verifier is its own (`apps/api/src/lib/dpop.ts`, on `jose`), not a library's
DPoP module: it is 190 lines, it answers one question (is this string a proof for this
request, signed by the key it carries, and which key is that), and every rule in it is one
this document states. It accepts:

- **`ES256` only** (`DPOP_ALGORITHMS`, a closed list in the contract). ECDSA over P-256 with
  SHA-256 is what the Secure Enclave and StrongBox sign with, so there is no device this
  feature is for that needs another. An algorithm is added to the list on purpose, never
  accepted because a proof names it; `none`, `HS256`, `RS256` and `EdDSA` are tested as
  refused.
- **a `jwk` that is a public P-256 key and nothing else**: exactly `kty`, `crv`, `x`, `y`,
  each coordinate 32 bytes in its one canonical base64url spelling (a second spelling of
  the same bytes would be a second thumbprint for the same key). A key with a private member (`d`) is refused, as is one with a
  `kid` or any other field. Coordinates that are no point on the curve fail at import.
- a compact JWS of at most 2,048 characters (`MAX_DPOP_PROOF_LENGTH`; a real proof is about
  500), a `jti` of 16 to 128 unreserved characters, an `iat` within five minutes of the
  server's clock either way (`DPOP_IAT_TOLERANCE_MS`), and a `nonce` of at most 128
  characters when present.

The key is named by its **RFC 7638 thumbprint** (SHA-256, base64url, 43 characters),
computed by the contract's `jwkThumbprint` from the four required members in the RFC's
order. The contract's test holds the thumbprint RFC 9449 gives for its example key.

**One answer, one word in the log.** Every way a proof can be wrong (ten in the verifier,
plus a missing proof, another key's and a replay) is the same `device.proof_invalid` to a
client. The verifier returns a fixed word (`ProofFailure`) that goes to the log line and
nowhere else; nothing of a proof, valid or not, is logged, stored or echoed.

What makes a proof and what names its parts is shared: `@tula/contract/device-binding` is a
Zod-free entry point on web platform APIs only (`DPOP_HEADER`, `DPOP_NONCE_HEADER`,
`createDpopProof`, `jwkThumbprint`, `isDevicePublicJwk`, the `DeviceKey` interface and
`generateSoftwareDeviceKey`), used by the server's tests, `@tula/core` and the conformance
runner.

### What a client signs: the API's own address

`htu` must equal `PUBLIC_URL` + the route's path (`/v1/client/sessions/refresh`,
`/v1/client/sign-ins`, …), compared after the URL parser's normalisation, with no query and
no fragment (a proof that carries either is refused, not trimmed). The server builds that
address from its configuration and the matched route. It never reads `Host`,
`X-Forwarded-Host`, `X-Forwarded-Proto` or anything else a request or a proxy says: a
header a client or an intermediary controls must not decide what a signature is good for. A
test sends a proof for the right address with a hostile `Host` (accepted) and a proof for
the `Host`'s address (refused).

So **a client signs the address the API knows itself by**, which for a native app is the
address it calls. It is not the address of a proxy in front of the API under another name,
and not an application's own route handler.

That is why **sessions that reach the API through the Next.js route handler are not bound
in this ticket**, and why a browser's session is not bound at all:

- the handler ([ADR 0029](0029-nextjs-sdk.md)) forwards `/v1/client/*` from the app's
  origin with an allow-list of request headers that `DPoP` is not on, so a proof would not
  arrive, and one that did would name the app's origin and be refused;
- a browser has no place to keep a key that outlives whatever steals its tokens. A
  non-extractable WebCrypto key in IndexedDB cannot be read by a script, but the script that
  can read the refresh token can also ask the key to sign: binding would prove "the same
  origin", which the cookie's own rules already do. A `stateful` session is a cookie and
  has no refresh at all.

A start that brings a proof with `x-tula-client: web` is refused
(`device.binding_not_supported`, 400). `@tula/core` refuses the `deviceKey` option for a `web` client when it is
constructed.

### A session is bound when its attempt starts, and never afterwards

Binding is the client's choice. The five routes that start an attempt (`POST
/v1/client/sign-ups`, `/sign-ins`, `/password-resets`, `/sign-ins/passkey`,
`/sign-ins/oauth`) read the `DPoP` header through `DeviceBinding.atStart`:

| The start brings | Answer |
| --- | --- |
| no proof | The attempt starts; its session will not be bound. Exactly as before. |
| a proof, from a `web` client | `device.binding_not_supported` (400). Nothing started. |
| something that is not a valid proof for this request | `device.proof_invalid` (401). Nothing started. **Never read as "not bound"**: a client that asked for a bound session must not be handed an unbound one. |
| a valid proof without the server's current nonce | `device.nonce_required` (400) and a nonce in `DPoP-Nonce`. Nothing started; the client repeats the start. |
| a valid proof with the nonce | The attempt starts with the key's thumbprint in its state. The answer carries the next nonce. |

The thumbprint is fixed in the attempt's state at the start, as the client kind is. No
later step of the attempt reads the header, and nothing adds, changes or removes a key:
the session the attempt ends in (`Sessions.create`, from the flow service's `finish`) is
created with that thumbprint in the same insert, or with none.

**Nothing rebinds, and nothing unbinds.** There is no route that binds an existing session,
moves one to another key or takes a binding off, and the database refuses the write
whoever sends it (below). A client that has lost its key signs in again. The alternative, a
rebind after a step-up, was not taken: it is the path a thief with a copied token would
use, and "the key is the session's for its whole life" is the property worth having.

`Sessions.create` refuses a thumbprint for a `web` client or a `stateful` profile before
the claims hook is asked and before anything is stored (`device.binding_not_supported`).
Neither is reachable from a start today: a browser's proof is refused at the start, and a
client that is not a browser never gets a `stateful` profile, whatever it asks for
(`resolveSessionProfile` gives it its built-in; [ADR 0028](0028-session-profiles.md)). The
check is the rule held where the session is made, for whatever calls `create` next.

Start refusals are not audited and not counted per anything but the route's own per-address
limit: there is no session and no account yet to record them against, and the start of an
attempt looks nothing up.

### A refresh of a bound session: the order of the checks

`Sessions.refresh` does, in this order:

1. find the token by its hash (`session.invalid_token` if there is none, or its session is
   `stateful`);
2. see that the session is alive (`session.revoked`, `session.expired`);
3. **if the session has a thumbprint, require a valid proof by that key**
   (`DeviceBinding.atRefresh`);
4. act on a ban (which revokes the session);
5. judge reuse: a token that was already rotated is answered from the grace window or
   revokes the family;
6. check the token's own expiry, and rotate.

The proof is judged at step 3 in a fixed order of its own: it is a proof for this request
signed by the key it carries; that key is the session's (thumbprints compared in constant
time); its nonce is the server's; its id was not used before.

Everything that writes is after step 3. A refresh refused for its proof therefore **changes
nothing**: the presented token is neither used nor replaced, the session is alive, and the
same token works a moment later with a proof. In particular:

- **No family revocation without a proof.** A rotated token replayed without a valid proof
  never reaches reuse detection, inside the grace window or outside it. The holder of a
  copied token cannot end the owner's session by presenting it: for a bound session reuse
  detection is something only the device can trigger.
- **The grace window requires a proof.** A rotated token presented again within
  `refresh.reuseGracePeriod` gets the same next token only with a proof by the session's
  key; without one it gets `device.proof_invalid` and the next token is not handed out.
- **With a valid proof everything is as it was**, reuse detection included: a rotated token
  replayed past the grace window by the device itself still ends the session.
- A proof is judged once per call. When a concurrent refresh wins the rotation and the loop
  takes its second pass, the proof is not asked again (its id is spent by then).
- A banned user's bound session is revoked for the ban only by a request that proves the
  key. Without a proof the answer is `device.proof_invalid` and the ban is acted on at the
  next proven refresh, or by the session's own limits. Access tokens are unaffected by this
  order: a banned user's are refused wherever the ban is checked today.

**Sign-out needs no proof.** `POST /v1/client/sessions/sign-out` ends a bound session on
its refresh token alone, as it ends any session. That is kept, and pinned by a test. A
sign-out must work for the client that has lost its key (the one way left to end that
session from the device), and requiring a proof there would turn a lost key into a session
nobody on the device can end. What it leaves open: the holder of a copied token can sign
the owner out. They gain nothing by it (it destroys the token they copied) and the owner
loses a sign-in, which is also all that reuse detection ever cost. So "a copied token
cannot end the owner's session" is true of the refresh route and not of sign-out.

**What the holder of a copied refresh token learns.** Presenting it without the key answers
`session.invalid_token` for a token that does not exist, `session.revoked` or
`session.expired` for a dead session (as for any session), and `device.proof_invalid` for a
live bound one. So they learn that the token is real, that its session is alive and that
it is bound. They do not learn the key, whether the token was already rotated, whether the
user is banned, or the server's nonce: the nonce challenge is answered only to a proof that
is valid **and** by the session's key, so a wrong key with or without a nonce is the same
`device.proof_invalid` with no `DPoP-Nonce` header. That the session is alive and bound is
not hidden on purpose: hiding it would mean answering a live bound session like a missing
token, and a legitimate client whose key store failed would then discard a session it
could have recovered.

**A session that is not bound behaves exactly as before.** Its refresh never reads the
`DPoP` header (a test sends garbage in it), its answers carry no `DPoP-Nonce`, its tokens
have the claim set of before (a snapshot test), and its code path makes no call to the
store of used proofs or to the refusal count.

### The server's nonce

A proof must carry a nonce the server made, so that a proof cannot be prepared in advance
(by something that can use the key once, briefly) and kept for later.

- **Stateless.** The nonce is `HMAC(key, environment id + ":" + period number)`, with a key
  derived from `TULA_MASTER_KEY` for the purpose `dpop-nonces` alone, where a period is five
  minutes of the server's clock (`DPOP_NONCE_PERIOD_MS`). Every instance computes the same
  value with no table and no shared store, and nobody without the key can compute the next.
  It is per environment, not per session or per key: it is a freshness value, not a secret
  between two parties, and a per-session nonce would be state.
- **The current and the previous period are accepted**, both computed and compared in
  constant time whichever matches. A nonce therefore works for five to ten minutes after
  the server first handed it out.
- **A proof without an accepted nonce is `device.nonce_required` (400)** with a fresh nonce
  in the `DPoP-Nonce` response header, which CORS exposes. It is RFC 9449's `use_dpop_nonce`
  step under this API's error envelope. It is not a refusal: it is not counted, not
  audited, and changes nothing. It is given only to a proof that passed every earlier check.
- **Every answer to a proven request hands out the nonce for the next one**: a successful
  refresh of a bound session, a start that bound, and the completion that creates a bound
  session. A client that keeps the newest value needs a second request only when it has
  none (its first call after a cold start) or has been idle for more than five to ten
  minutes.
- **`iat`** is the second, coarser bound: within five minutes of the server's clock either
  way. Wide enough for a phone whose clock is a little off; the nonce is what ties a proof
  to the present.

The status is 400, not 401, on purpose: `@tula/core` and the Next.js handler treat a 401
from a refresh as a statement about the session. `device.proof_invalid` is 401 and still
does not end the session in `@tula/core`, by its code (below).

### A proof is accepted once

The id of every accepted proof is remembered until its nonce stops being accepted (at most
ten minutes), in the `ProofReplayGuard` port: `remember(id, until)` answers whether the id
was new. The stored id is `SHA-256(environment id : thumbprint : jti)`, never the client's
own string: keys in shared state hold ids and hashes ([ADR 0016](0016-redis-and-multiple-instances.md)).
It is asked last, so only a proof that is otherwise good is ever remembered, and a flood of
bad proofs writes nothing.

- **Redis** (`SET key 1 NX PX <ms>`, one command) when `REDIS_URL` is set, so every
  instance refuses a proof any instance accepted. **It fails closed**: when Redis cannot
  answer, the adapter throws `service.unavailable` (503) and the proof is not accepted on a
  guess. This is new for refresh: until now "refreshing a token needs only the database".
  A bound session's refresh now also needs the shared store; an unbound session's does not.
  The session is not ended by the 503 and the same token works when Redis is back.
- **Memory** without Redis, per process. With one instance that is the same guarantee. With
  several instances and no Redis (which `staging` and `prod` refuse to boot as), a proof
  accepted by one instance is unknown to the others for its remaining life. What that is
  worth to an attacker is small: a replayed proof is only useful together with a refresh
  token, the token it was first sent with has been rotated, and replaying both lands in the
  grace window (the same next token the device already has) or in reuse detection. It is
  still not the stated guarantee, so the diagnostics say it: the `redis` check of
  `tula doctor`, which already said that rate limits, lockout and revoked sessions are per
  process without Redis, now names the used proofs of device-bound sessions too. No new
  check was added: the fact is the same fact ("shared state is per process"), and a second
  check that always agrees with the first says nothing.

### A refused proof is counted and recorded, and ends nothing

A refresh of a bound session that is refused for its proof (missing, invalid, another
key's, replayed):

- is **counted per session** in the shared rate limiter. Past ten in a minute
  (`PROOF_REFUSALS_PER_MINUTE`) the answer is `rate_limited` and nothing more is logged or
  recorded until the minute is over. Only refusals are counted: the device's own valid
  refresh is never held up by someone else's refused ones. A limiter that cannot count
  answers `service.unavailable`; the refresh was going to be refused either way, and an
  audit row per refusal with nothing counting them is what the count exists to prevent.
- is **recorded at most once a minute per session** as `session.refresh_proof_refused`
  (actor `system`, target the session, the request's origin kept): the first refusal of a
  minute writes the entry with its `reason` (`missing`, `invalid`, `wrong_key`, `replayed`)
  and `suppressedInPreviousMinute`, how many refusals of the minute before were not written
  one by one. That number is "at least this many", as for failed dashboard sign-ins
  ([ADR 0032](0032-dashboard.md)): a burst nothing follows is not reported afterwards. The
  audit log is append-only and a copied token can be presented as often as the limits
  allow, so one entry per refusal would let its holder grow the table.
- is logged with the environment, the session, the user and the verifier's fixed word.
- **never ends the session and never revokes the family.**

The event is delivered to webhooks like any other. Its payload is ids, the closed `reason`
and a number: nothing of the proof, the key or the token.

**The owner is not told in this ticket.** A refused proof on a bound session is the
clearest sign there is that a refresh token left its device, and a security notice
([ADR 0023](0023-security-notices.md)) is the obvious next step. It is TULA-34's, with the
native SDKs: until a hardware-backed client exists, the realistic cause of a refused proof
is a developer's software key that was not persisted, and a notice for that would train
people to ignore it. An operator can act on the event today.

### The access token says which key, and the server asks nothing more of it

The access token of a bound session carries `cnf: { "jkt": "<thumbprint>" }` (RFC 7800,
RFC 9449 §6.1), read from the session row at every issue. `cnf` was already a reserved
claim name ([ADR 0036](0036-jwt-templates.md)) so that no template or hook could set it;
the test "the claims a server sets are all reserved" now signs a bound session's token and
covers it. An unbound session's token has no `cnf` key at all.

**No resource-side proof.** The API's own routes accept a bound session's access token as
they accept any: `sessionAuth()` does not ask for a proof, and neither does `@tula/nextjs`
or `POST /v1/admin/sessions/verify`. The claim is there so that an application's own
backend can require a proof of the same key for an operation it cares about, when it wants
to. Requiring one on every API call would put a signature and a shared-store write on
every request for a token that lives 60 seconds, and is a different feature.

`@tula/nextjs` is unchanged: its `SessionClaims` already passes unknown claims through as
`unknown`, and typing `cnf` there means validating it there, for sessions that cannot reach
that SDK bound (above). It was not trivial, so it was left.

### Storage

`sessions.device_thumbprint`: nullable text, null for every existing session.

- A check (`sessions_device_thumbprint_shape`): null, or a 43-character base64url string on
  a `hybrid` session.
- **A trigger refuses every update that would change it**
  (`sessions_device_thumbprint_immutable`), whichever role sends it. The runtime role has
  `UPDATE` on the whole table and a column cannot be carved out of a table-level grant, so
  "written when the session is created and never again" is held by the database and not
  only by there being no store method. The memory adapter has no method that could.
- It is written by `SessionStore.create` only. `reportRefusedProof` is the store's one new
  method: it writes the audit entry and nothing of the session.

The migration is `0030_device_binding` on this branch (it is renumbered when it meets the
other branches' migrations at merge).

### Events and hooks

- `session.created` gains the optional `deviceBound: true`. Nothing of the key: not the
  thumbprint, not a prefix. A thumbprint is public, and it is still an identifier of a
  device that would then travel to every subscribed webhook endpoint.
- `session.refresh_proof_refused` is new (above).
- **The hook questions hold no thumbprint.** `before_session` and `before_token`
  ([ADR 0035](0035-hooks.md)) are asked as before. Whether a session is bound could be a
  useful input to a hook that decides (a `deviceBound` boolean); it is not added here
  because a new input to `before_token` needs a place that asks again when it changes
  (it cannot change) and a decision of its own, and nobody has asked for it.

### The TypeScript client

`createTulaClient({ …, deviceKey })` binds the sessions of a client that is not `web`.

- A `DeviceKey` is `{ publicJwk, sign(data) }`: a public P-256 key and a function that
  signs with the private half and never hands it out. A native wrapper backs it with
  hardware; `generateSoftwareDeviceKey()` backs it with a non-extractable WebCrypto key,
  for tests, the conformance runner and platforms with nothing better. A software key
  proves no more than "the same process that made the key".
- **Proofs are made in the transport**, for the six operations of a closed set (the five
  starts and `refreshSession`) and nothing else. A new proof for every request.
- **The nonce** is kept in the transport's closure (memory only, never storage): the newest
  `DPoP-Nonce` of any answer. On `device.nonce_required` the transport makes a new proof
  and repeats the request **once**, inside the same call: for a refresh that is inside the
  session manager's single flight, so parallel callers still share one refresh, and under
  the same deadline, so a refresh still gives up within `REFRESH_TIMEOUT_MS` (8 seconds,
  below the smallest grace window) whether or not it was challenged. A second challenge is
  returned as the error it is.
- **`device.*` codes never end the local session.** `device.proof_invalid` is a 401 from
  the refresh route, and a 401 there otherwise means the session is gone. The client
  treats the three codes as "the request failed": the tokens stay, the state stays signed
  in, and the next refresh tries again.
- A key whose `sign` throws surfaces as the client-side code `device.key_failed`, with
  nothing of the cause in it.
- `baseUrl` is what the proof names, so it must be the API's public address. The option's
  documentation says so.
- **Bundle.** `@tula/core`'s budget moved from 15,851 to 16,449 bytes (gzip). Measured:
  15,809 before, 16,407 after: +113 bytes for the three server codes and their messages,
  +485 for making a proof, the transport's loop, the client's own `device.key_failed` and
  the refusal of a key for a `web` client. `generateSoftwareDeviceKey` is exported and not
  in that number: an application that brings its own key does not pay for it. The package
  stays Zod-free and free of Node and Bun APIs (`typecheck:portable`).

### The conformance suite

A scenario's request may carry `proof: { key, nonce?, capture? }`. The runner makes a
software key per name per run (kept in memory for the run; **no key is ever in a scenario
file**), signs a proof for the step's method and for the target's public URL plus the
step's path, and sends it as `DPoP`. `capture` stores the proof so a later step can replay
it as a plain header. A step has a `proof` or a `DPoP` header of its own, not both.

A target's public URL is its base URL unless told otherwise (`CONFORMANCE_PUBLIC_URL`; in
process, the configured `PUBLIC_URL`). That is right for a live server reached at its own
address, for the packaged stack's two ports (both instances share the first one's
`PUBLIC_URL`, and the runner signs for the first whichever instance a step goes to), and
through the proxy when the stack is started with `API_PUBLIC_URL` set to it, as CI does. So
**the seven scenarios need no `needs…` flag and no entry in CI's skipped set**: they need
nothing a live server lacks. The packaged stack has Redis, so "a proof is accepted once"
replays its proof on the second instance.

| Scenario | Shows |
| --- | --- |
| a session bound to a device key is refreshed with a proof | The nonce challenge at the start, the bound session, `cnf.jkt`, two refreshes (the second on the other instance). |
| a bound session's refresh without a proof is refused and changes nothing | No header, and a header that is no proof: `device.proof_invalid`, the session alive, the same token still good. |
| a bound session's refresh with a proof of another key is refused | With and without a nonce; never handed a nonce. |
| a proof is accepted once | The same proof again, on the other instance. |
| a proof with a stale nonce is asked for a fresh one | An unknown nonce and no nonce: `device.nonce_required`, a fresh one in the header, then success. |
| the reuse grace window still requires a proof | The rotated token without a proof, with another key's, and with the right one (the same next token). |
| a session that is not bound behaves as before | No `cnf`, no nonce, a `DPoP` header ignored; a browser's proof and an invalid proof refused at the start. |

Over HTTP a run cannot wait ten minutes, so "stale" in the scenario is a nonce the server
never made. A nonce that was the server's and has aged out (still accepted in the period
after the one it was made in, refused in the one after that) is an API test on the test
clock. Each scenario has an SDK journey in `sdk-journeys.test.ts`.

## What binding proves, and what it does not

**It proves** that whoever refreshed a bound session could, at that moment, make the key
that was presented when the sign-in started sign a fresh value the server chose. With a
hardware key that cannot be exported, that is "the same physical device, still unlocked
enough to sign". A refresh token copied out of a backup, a log, a proxy, a compromised
keychain export or another process is useless without it.

**It does not prove:**

- **Anything about the key's quality.** The server sees a public key. It cannot tell a
  Secure Enclave key from one generated in JavaScript and written to a file next to the
  refresh token. There is no attestation in this step; binding is as strong as the place
  the client keeps the key, and with `generateSoftwareDeviceKey()` in a process that also
  holds the token, it adds little against whoever can read that process.
- **Who is holding the device.** Malware on the device, or a person with the unlocked
  phone, asks the key to sign like the app does. Binding is about a credential leaving the
  device, not about the device being in the right hands.
- **Anything about access tokens.** A bound session's access token is a bearer token for
  its 60 seconds, accepted without a proof. `cnf.jkt` lets an application ask for a proof;
  the API does not.
- **That the sign-in was the user's.** The key is whichever key started the attempt. An
  attacker who signs in with a stolen password binds the session to the attacker's key.
  Binding protects a session, not an account.
- **That the device is the same one as last time.** A key is not an identity the server
  tracks: two sessions bound to one key are not linked by anything the server exposes, and
  a new sign-in may bring a new key. "A new device" in a security notice is still what
  [ADR 0023](0023-security-notices.md) says it is.

**A device does not outlive its session.** The thumbprint is a column of the session row.
When the session ends (sign-out, expiry, revocation, the retention job's delete 30 days
later) the binding ends with it and nothing of the key remains: there is no table of
devices, no "trusted device", no key that skips a factor at the next sign-in, and no way to
revoke "a device" other than ending its sessions. Remembering a device across sessions is a
different feature with a different threat model (it turns a key into a credential), and it
is not built here.

**What it costs.** One signature per refresh on the client and one verification on the
server (well under a millisecond for P-256), one Redis command per accepted proof, a second
request when the client has no current nonce, and a dependency of a bound session's refresh
on the shared store. A client that loses its key loses its sessions.

## Departures from the brief

- **The codes are `device.*`, not `session.*`.** Every `session.*` answer to a refresh
  means "this session is over" to `@tula/core`, to `@tula/nextjs` (which clears cookies on
  it) and to applications written against them. A refused proof means the opposite. A
  namespace of its own is what lets every existing client fail safe without knowing the
  codes.
- **The nonce is challenged only for a valid proof by the right key.** The brief asked for
  a dedicated error with a fresh nonce; it is that, and it is withheld from a proof by
  another key so that the challenge is not a way to test a token without the key.
- **The nonce is also handed out when a bound session is created**, not only on refresh,
  so that the first refresh needs one request.
- **A trigger holds the column fixed**, beyond the check the brief named.
- **`@tula/nextjs` is untouched** (not trivial, above).
- **No new diagnostics check**; the existing `redis` check's sentence names the proofs.

## Not decided here

- **A proof is not bound to the refresh token it travels with.** RFC 9449 binds a proof to
  an access token with `ath`; there is no such claim for a refresh request, and none was
  invented. A proof captured in transit could be presented with a different refresh token
  of the same session, once, before the device's own request arrives. That needs the TLS
  connection broken, in which case the refresh token is captured too. Adding a hash of the
  token to the proof is cheap and is a contract every native SDK must then implement:
  a question for the product owner before those SDKs are written.
- An owner's notice for a refused proof (TULA-34).
- Attestation of a key (App Attest, Play Integrity key attestation).
- A `deviceBound` input to the hooks.
- An environment setting that **requires** binding for a client kind. Today binding is the
  client's choice, and a client that does not send a proof gets an unbound session.

## Consequences

- A copied refresh token of a bound session cannot be refreshed without the device, and
  presenting it to the refresh route cannot end the owner's session. Its holder can still
  sign the session out.
- Refresh of a bound session depends on Redis where Redis is configured, and fails closed.
- Two new answers to a start and to a refresh, one new event type, one new claim, one new
  column. Nothing changes for a client that sends no proof.
- **Not shown by this step**: any hardware key (every key in the tests is software), and
  the seven scenarios against a live server, on two ports or through the proxy (they run in
  process; CI's `self-host` jobs run them live).
