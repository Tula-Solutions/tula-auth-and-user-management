# ADR 0043: Device binding on refresh

- **Status:** accepted
- **Date:** 2026-10-09
- **Ticket:** TULA-19 (phase 2, step 2.10); the profile's option, the session lists and the
  new-device notice: TULA-34

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
`/v1/client/sign-ins`, …). **It has one spelling, and the server judges it by string
work**, with no URL parser on a client's text:

- `http` or `https`, then `://`, the host, an optional `:` and port in digits, then the
  path, which starts with `/`. Printable ASCII only. A host holds letters, digits, full
  stops, hyphens and underscores (the underscore because the URL parser keeps one, and a
  Compose service name such as `tula_api` has one), or is an IPv6 address in brackets.
- Three things are normalised before the comparison, the ones RFC 9449 §4.3 asks for: the
  scheme's case, the host's case, and a default port written out (`:443` for `https`,
  `:80` for `http`). Nothing else is: the path is compared byte for byte.
- **Refused, before anything is compared**: a backslash anywhere; a `.` or `..` path
  segment; a percent sign; a query or a fragment, an empty one included (not trimmed);
  user info (`user@`, `user:pass@`, a lone `@`); a space, a tab or a line break; fewer or
  more than two slashes after the scheme; no path.

A URL parser would repair every one of the refused forms into the route's own address, and
the first version compared what the parser made of `htu`. That accepted spellings no
client has a reason to sign, and made "what the server accepts" depend on a parser a
native SDK does not have. The server's own side of the comparison is still read by the
parser, because it is the operator's configuration and not a client's text.

**What a client without that parser has to do** is therefore more than compare strings: it
has to write the host the way the server's `PUBLIC_URL` is written once the parser has
read it. That is: lower case; an IPv6 address compressed (`[::1]`, not
`[0:0:0:0:0:0:0:1]`) and in brackets; a host with letters outside ASCII in its `xn--`
form; no dot added or taken away at the end of the host; the port without leading zeros,
and left out when it is the scheme's default; and the path exactly the route's, after the
public URL's own path prefix with no slash at its end. Of those the server forgives the
case of the scheme and of the host and a default port written out, and nothing else.
`@tula/core` gets all of it from the platform's parser (`normalizeBaseUrl`); a test puts
a table of `PUBLIC_URL` spellings through the client and the verifier and fails on any
row where the two disagree.

### A `PUBLIC_URL` no proof can name

The two sides can fail to meet. The parser percent-encodes a space, and a letter outside
ASCII, in the path of `PUBLIC_URL` (`https://example.com/my api` is read as
`/my%20api`), and a proof may hold no percent sign: on such a deployment no `htu` a
client could send would be accepted.

- **The boot is not refused.** That would stop a deployment for a feature it may not use.
- **It is decided once**, where the address is built (`DeviceBinding.available`, from the
  refresh route's address: the routes' own paths are plain ASCII, so it holds for every
  start too), and the API process says so at boot with one warning in fixed words that
  name `PUBLIC_URL` and never its value. A worker starts no attempt and says nothing.
- **Device binding is then unavailable there.** A start that brings a proof answers
  `device.binding_not_supported` (400), whatever the proof: never `device.proof_invalid`
  (nothing the client could sign would pass) and never an unbound session (it asked for a
  bound one). No nonce is handed out and no proof id is remembered. A start without a
  proof is as it always was.
- **No session is bound while it lasts, so the refresh path has no case of its own.** The
  one case it does have is a deployment that bound sessions and then had `PUBLIC_URL`
  changed to such a value: those sessions' refreshes are refused (`device.proof_invalid`,
  counted and recorded like any refused proof), because no proof can name the new address.
  They are not unbound to let them through. They work again when `PUBLIC_URL` is one a
  proof can name, and otherwise their users sign in again. This is the general rule for a
  changed `PUBLIC_URL`, not a new one: a proof names the address the API knows itself by.
- The code is the one a browser gets, and its message ("a session of this kind of client
  cannot be bound") is worded for that case. A second code was not added: `@tula/core`'s
  table has every contract code and its bundle budget is exact. The operator's notice is
  the boot warning; `docs/device-binding.md` lists both causes under the code.

The server builds that address from its configuration and the matched route. It never
reads `Host`,
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

Binding is the client's choice where the session's profile leaves it one ("The profile
says whether a native sign-in may, or must, bring a key", below). The six routes that start an attempt (`POST
/v1/client/sign-ups`, `/sign-ins`, `/password-resets`, `/sign-ins/passkey`,
`/sign-ins/oauth` and, since [ADR 0045](0045-native-id-token-exchange.md),
`/sign-ins/id-token`) read the `DPoP` header through `DeviceBinding.atStart`:

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

### The profile says whether a native sign-in may, or must, bring a key (TULA-34)

Until this step binding was the client's choice alone. A session profile
([ADR 0028](0028-session-profiles.md)) now has `deviceBinding`:

| Value | A native start with no proof | A native start with a proof |
| --- | --- | --- |
| `none` | starts; the session is not bound | `device.binding_not_supported` (400) |
| `optional` | starts; the session is not bound | the table above: the session is bound |
| `required` | **`device.binding_required` (400)** | the table above: the session is bound |

**The default is `none` for the built-in `web` profile and `optional` for every other
profile**, `mobile` and the ones an operator adds (`defaultDeviceBinding(name)` in the
contract). `optional` is what every native client had before the option existed, so a
stored document that says nothing behaves as it did. `web` says `none` because that is what
is true of it: only browsers get that profile.

**A browser is unaffected by every value.** A `web` client's start with no proof starts,
and with one is `device.binding_not_supported`, whatever its profile says: decided before
the settings are read. A request with no `x-tula-client` is a `web` client. The same holds
for a `stateful` profile, which only a browser can get. The option can be written on those
profiles and changes nothing there. A browser has nowhere to keep a key that outlives what
steals its tokens; saying `required` cannot make it have one.

**One rule, held in three places.** `DeviceBinding.hold(profile, client, bound)` is the
whole rule. It is applied to the profile `resolveSessionProfile` gives, the same function
`Sessions.create` chooses a profile with, so the profile that is judged is the profile the
session would get (the built-in of the client's kind, or the one named in
`x-tula-session-profile` when the environment marks it `clientSelectable`; a name that is
not offered falls back, as it always did, and cannot be used to reach a looser option).

1. **At the start** (`DeviceBinding.atStart`, from the flow router's `clientContext`), for
   all six routes that start an attempt: after the route's validators and its per-address
   limit, before the flow service is called and before the proof is judged. Nothing has
   been created, looked up, counted against an identifier or sent. The refusal depends on
   the client kind, the profile asked for and the settings, **never on the identifier**: a
   start for an address with an account and one for an address with none answer alike (a
   side-by-side test holds it). It costs one read of the settings, which are cached.
2. **At completion** (`Sessions.requireBinding`, the first thing `finish` does), before the
   attempt is moved to `complete` and before a hook is asked: for an attempt that started
   before the option was changed. The attempt stays on its step, no hook is called and no
   session is made. **What it costs is what the attempt had already spent**: the emailed
   code, the time step or the backup code that brought it to `finish` is gone, and the
   attempt cannot complete while the option stands. The user starts again, with a client
   that brings a key.
3. **In `Sessions.create`**, for whatever calls it next.

**`device.binding_required` is a code of its own.** A client must be able to tell "this
environment needs a key and I have none" (show "update the app") from a refused proof
(`device.proof_invalid`) and from "do not send one" (`device.binding_not_supported`). It is
in `device.*` for the reason the other codes are: no client reads it as "the session is
over". It is the first code added since the bundle budget of `@tula/core` was made exact:
its entry in the message table took the bundle from 16,685 to 16,699 bytes gzipped, under
the budget of 16,727, which was not raised.

**A change applies to new sign-ins only. A session that exists is left as it is.** Two
decisions, both the same way:

- *A profile moved to `none` while it has bound sessions.* They stay bound and every
  refresh still needs a proof. Nothing unbinds a session (above), and an option must not
  be the way round that.
- *A profile moved to `required` while it has sessions that are not bound.* They go on
  being refreshed until they end by their own limits or are revoked.

The alternative for the second, refusing the refresh of an unbound session under
`required`, was not built. A refresh cannot bind (the key is fixed at the start), so the
only thing a refused refresh could do is end the session: saving the option would sign out
every native user at once, on every instance within the settings cache's seconds, with no
way for an operator to stage it, and a client would have to learn a new answer to a
refresh that is neither "session over" nor "bad proof". An operator who wants the old
sessions gone ends them (`DELETE /v1/admin/users/:userId/sessions`), or shortens the
profile's absolute timeout, which does apply to existing sessions. So after a move to
`required`, **"every native session is bound" is true only once the sessions made before
it have ended**; the dashboard and `docs/device-binding.md` say so where the option is set.

**Asking less is a weakening** (`settingsWeakenings`, the one definition the audit entry,
the dashboard's confirmation and `tula apply --yes` share), under
`sessions.profiles.<name>.deviceBinding`: `required` to `optional` or `none`, `optional` to
`none`. Asking more is not. A removed profile is compared with the `mobile` profile its
clients fall back to. A new profile clients may ask for is one only when `mobile` is
`required` and it asks less (it would be a way round `mobile`). The rule makes no exception
for the `web` profile or a stateful one, where the option does nothing: a question too
many, not one too few. A config file that leaves the option out says the default, so a
file with no `deviceBinding` loosens a server that has `required`, and is flagged.

**A deployment whose `PUBLIC_URL` no proof can name cannot bind a session** (above), so
there `required` refuses every native sign-in: the start with a proof is
`device.binding_not_supported` and the one without is `device.binding_required`. Nothing
checks for the combination when the option is saved, and no diagnostic reports it yet.

### What is said about a bound session, and in which words

- **The session lists say `deviceBound`, a boolean**: `GET /v1/client/sessions` and the
  admin list of a user's sessions. Never the thumbprint, a prefix or a count of keys: the
  reasons are the event's (below). `<UserProfile>` and the dashboard's user screen say it
  in words. `@tula/mcp` names the boolean in `list_user_sessions`, and the profile's
  option in the settings projection (a closed word): the boolean is the whole of what the
  API says of a key, so there is nothing of a key for a tool to return.
- **The words are "bound to a device key".** The server knows that a refresh was signed by
  a key, and nothing about the device the key is on or whose hands it is in ("What binding
  proves", below). No text of the product calls this "device verification", calls a
  device "verified" or "trusted": a harness test
  (`.claude/hooks/wording.test.ts`) fails for those phrases in the docs, the READMEs, the
  React SDK's strings, the contract's error messages and the dashboard's sources. Its
  allow-list is this paragraph, the sentence about remembered devices below, and the
  plan's own statement of the rule.

### The new-device notice knows a bound session by its key

[ADR 0023](0023-security-notices.md) announces a sign-in whose device family the account
has not been seen on. A family is a kind of device (every iPhone app is one family), which
is all an unbound session can be known by. A bound session can be known by more:

> A sign-in that created a **bound** session is from a new device when no session of the
> same user that began before it, and is still in the session table, is bound to the same
> key. A sign-in that created an unbound session is judged by its family, as before.

The horizon is unchanged (sessions that ended stay for 30 days and count), a user's first
session is still not announced, and the email is the same one: it names the family, never
a key. `SessionStore.hasBoundSessionBefore` answers a boolean; no thumbprint leaves the
store for it. This is the one place a thumbprint decides anything besides a refresh.

What follows from it, and is accepted:

- **A reinstalled app is a new device.** Its key went with the old install. So is a phone
  restored from a backup that did not carry the key, which is the point of a key that
  cannot be copied.
- **An app's first release that sends a key announces each user's first sign-in with it**
  (where they have an earlier session and the notice is on): the key has not been seen.
  Once, per device.
- **A second phone of the same kind is now announced.** Under the family rule it was not.
- A bound session never makes a later *unbound* sign-in of the same family unknown, and
  the other way round a family seen only on unbound sessions does not make a key known.

**Signing out other sessions needs no recent authentication, and that is kept.**
`POST /v1/client/sessions/revoke-others` and `DELETE /v1/client/sessions/:sessionId` are
behind `sessionAuth()` and nothing more, for a bound session and an unbound one alike, and
neither needs a proof. Ending sessions is what an owner does when they suspect something:
it must not wait for a factor they may not have to hand, and an attacker who holds a
session and uses it to end the others gains no access by it (the owner signs in again, and
is told about nothing they cannot see in their list). The step-up is for changes that give
access or take away protection. A test pins both routes an hour after the sign-in, with no
`DPoP` header.

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
it is bound. They do not learn the key, whether the token was already rotated or whether
the user is banned. **The refresh route does not hand its challenge to a wrong key**: it is
answered only to a proof that is valid **and** by the session's key, so a wrong key with or
without a nonce is the same `device.proof_invalid` with no `DPoP-Nonce` header, and the
challenge cannot be used to tell "wrong key" from "right key, old nonce". That is all it
is: **the nonce itself is not a secret and nothing rests on its being one.** It is a
freshness value, the same for every client of the environment in a period, and any valid
`ES256` proof at a non-browser start is given it (a test starts a sign-in with a key the
server has never seen and reads it from the 400). Whoever holds a copied token can
therefore have the current nonce; what they cannot have is a signature by the session's
key over it. That the session is alive and bound is
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
- is **still a refusal when its record could not be written.** If the store refuses the
  minute's entry the answer is `device.proof_invalid` as always, never a 5xx: a 5xx would
  tell whoever holds a copied token that the store is down, and a client that it may
  simply send the request again. The tally has already moved, so **that minute has no
  entry** and the next refusal of the minute writes none either; an error line with fixed
  words, the environment, the session and the error's name (never its message, which is
  the store's own text) is its only trace. The limiter's own failure is different and
  stays `service.unavailable`: there nothing was counted.
- is logged with the environment, the session, the user and the verifier's fixed word.
- **never ends the session and never revokes the family.**

The event is delivered to webhooks like any other. Its payload is ids, the closed `reason`
and a number: nothing of the proof, the key or the token.

**The owner is not told in this ticket.** A refused proof on a bound session is the
clearest sign there is that a refresh token left its device, and a security notice
([ADR 0023](0023-security-notices.md)) is the obvious next step. It waits for the
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

The migration is `0031_device_binding`: the generated column and its check, then the
function and the trigger, written by hand below them because Drizzle declares no triggers.

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
  nothing of the cause in it: not in the message and not as the error's `cause`, which is
  left unset. A key store's error text is the platform's, and an application logs what it
  catches.
- `baseUrl` is what the proof names, so it must be the API's public address. The option's
  documentation says so.
- **Bundle.** `@tula/core`'s budget is 16,727 bytes (gzip), set from the measurement and
  the 42 bytes of room it has always had. Measured on the tree that also has the texted
  second factor: 16,099 before, 16,685 after, so 586 bytes for the three server codes and
  their messages, making a proof, the transport's loop, the client's own
  `device.key_failed` and the refusal of a key for a `web` client. `@tula/react`'s bundle,
  which holds the client, went from 52,272 to 52,835 (its budget: 53,271).
  `generateSoftwareDeviceKey` is exported and not
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
**the eleven scenarios need no `needs…` flag and no entry in CI's skipped set**: they need
nothing a live server lacks. The packaged stack has Redis, so "a proof is accepted once"
replays its proof on the second instance.

| Scenario | Shows |
| --- | --- |
| a session bound to a device key is refreshed with a proof | The nonce challenge at the start, the bound session, `cnf.jkt`, two refreshes (the second on the other instance). |
| a bound session's refresh without a proof is refused and changes nothing | No header, and a header that is no proof: `device.proof_invalid`, the session alive, the same token still good. |
| a bound session's refresh with a proof of another key is refused | With and without a nonce; the refresh route hands it none. |
| a proof is accepted once | The same proof again, on the other instance. |
| a proof with a stale nonce is asked for a fresh one | An unknown nonce and no nonce: `device.nonce_required`, a fresh one in the header, then success. |
| the reuse grace window still requires a proof | The rotated token without a proof, with another key's, and with the right one (the same next token). |
| a session that is not bound behaves as before | No `cnf`, no nonce, a `DPoP` header ignored; a browser's proof and an invalid proof refused at the start. |
| a profile that requires a device key refuses a native sign-in without one | `device.binding_required` for a sign-up and a sign-in alike, no attempt made; something that is no proof is still `device.proof_invalid`. |
| a profile that requires a device key lets a bound native sign-in through | The nonce challenge, `cnf.jkt`, `deviceBound: true` in the session list, a refresh that needs a proof. |
| a profile that requires a device key leaves a browser alone | A browser's sign-up with no proof, `deviceBound: false`; a browser's proof still refused. |
| a profile with no device binding refuses a proof | A proof, and something that is no proof, refused before anything is judged; the same start without one, unbound. |

The last four change the environment's settings (they need a secret key) and put them back
in `cleanup`. What a scenario cannot show is in the API's tests
(`modules/session/device-binding.policy.test.ts`): the option against every client kind,
with and without a key, for both session types; an attempt whose option changed between
its start and its completion; and what a change leaves alone on sessions that exist.

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
  a new sign-in may bring a new key. The one use of a key beyond a refresh is the
  new-device notice, which asks whether an earlier session of the user had the same key
  ("The new-device notice knows a bound session by its key", above): a yes or no, kept
  nowhere.

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
- **At a refresh the nonce is challenged only for a valid proof by the right key.** The
  brief asked for a dedicated error with a fresh nonce; it is that, and the refresh route
  does not answer it to a proof by another key, so that the challenge is not a way to test
  a token without the key. The value is not withheld from anyone: a start gives it to any
  valid proof ("What the holder of a copied refresh token learns", above).
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
- An owner's notice for a refused proof. The first version of this record gave it to
  TULA-34; that ticket changed what the new-device notice means for a bound session and
  did not add this one. The reason to wait is unchanged (no hardware-backed client yet).
- Attestation of a key (App Attest, Play Integrity key attestation).
- A `deviceBound` input to the hooks. With `required` a hook has less to ask (the profile
  refuses first); under `optional` a `before_session` hook that wants to refuse unbound
  sign-ins for some users still cannot see whether one is bound.
- Refusing the refresh of an unbound session under `required` (the alternative above), and
  a diagnostic for `required` on a deployment that cannot bind.
- A way to stage `required`: a date from which it applies, or a count of the sessions a
  profile has that are not bound.

## Consequences

- A copied refresh token of a bound session cannot be refreshed without the device, and
  presenting it to the refresh route cannot end the owner's session. Its holder can still
  sign the session out.
- Refresh of a bound session depends on Redis where Redis is configured, and fails closed.
- Two new answers to a start and to a refresh, one new event type, one new claim, one new
  column. Nothing changes for a client that sends no proof, unless its profile is set to
  `required`: then its sign-in is refused (`device.binding_required`), and that is the
  operator's decision, asked for by name.
- A profile's `deviceBinding` is one more field of the settings document, with a default
  that keeps what a stored document did. No migration.
- Where a session is bound, "a new device" in the sign-in notice is a new key.
- **Not shown by this step**: any hardware key (every key in the tests is software), and
  the eleven scenarios against a live server, on two ports or through the proxy (they run in
  process; CI's `self-host` jobs run them live).
