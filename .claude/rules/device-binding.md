---
paths:
  - "apps/api/src/modules/session/**"
  - "apps/api/src/lib/dpop*"
  - "apps/api/src/adapters/proof-replay*"
  - "packages/contract/src/device-binding*"
  - "packages/core/src/transport*"
---

# Device binding

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## Device binding (`modules/session/device-binding.ts`, `lib/dpop.ts`, see ADR 0043)

A session of a client that is not a browser can be **bound to a device key** when its
sign-in starts; every refresh of it then needs a DPoP proof (RFC 9449) signed by that key.
A session that is not bound behaves as it always did and never reads the header. Whether
a native sign-in may, or must, bring a key is the session profile's `deviceBinding`.

- **A proof is checked in one function, `verifyProof` (`~/lib/dpop`), and judged in one,
  `judge` (`modules/session/device-binding.ts`).** `ES256` only (`DPOP_ALGORITHMS`, the
  contract's closed list: never accept an algorithm because a proof names it); a `jwk` that
  is a public P-256 key **and nothing else** (`isDevicePublicJwk`: a `d`, a `kid` or any
  other member is refused); `typ`, `htm`, `htu`, `iat` within `DPOP_IAT_TOLERANCE_MS`, a
  `jti`. The verifier never throws and never logs; it returns a fixed word (`ProofFailure`)
  that goes to a log line and nowhere else. **Every refusal is the one
  `device.proof_invalid`**: never a code or a parameter per reason.
- **`htu` is compared with `deps.config.publicUrl` + the route's path.** Never with `Host`,
  a forwarding header or the request's own URL. A new route that reads a proof passes its
  own path; keep the test that sends a hostile `Host`.
- **`htu` has one spelling, judged by string work and never by a URL parser** (`address`
  in `~/lib/dpop`): only the scheme's case, the host's case and a default port are
  normalised; a backslash, a `.` or `..` segment, a percent sign, a query, a fragment,
  user info and whitespace are refused before anything is compared. A host holds letters,
  digits, dots, hyphens and underscores (`new URL` keeps an underscore, and a Compose
  service name has one). A native SDK has to
  be able to hold itself to the rule. Never pass a client's `htu` to `new URL`, and never
  add a normalisation without a line in ADR 0043, `docs/device-binding.md` and the JSDoc
  of the contract's `DpopProofInput.url`. A new refused form gets a row in the table of
  `lib/dpop.test.ts`; the rows that must still pass stay.
- **A deployment whose own address no proof can name binds nothing, and says so**
  (`DeviceBinding.available`, decided once from `canBeNamed` in `~/lib/dpop`: the parser
  percent-encodes a space or a non-ASCII letter in `PUBLIC_URL`'s path, and a proof may
  hold no percent sign). There a start that brings a proof is
  `device.binding_not_supported`, never `device.proof_invalid` and never an unbound
  session, and the API warns once at boot in fixed words that name `PUBLIC_URL` and never
  its value. Never refuse the boot for it, and never unbind a session bound before
  `PUBLIC_URL` was changed to such a value (its refresh is refused: ADR 0043). **The two
  sides of the address must always meet**: `device-binding.public-url.test.ts` puts a
  table of `PUBLIC_URL` spellings through `@tula/core` and the verifier and fails on a row
  where a deployment that says it can bind refuses what the client signs. A change to
  `HTU`, to `own` or to `@tula/core`'s `normalizeBaseUrl` keeps that table, and a new
  spelling gets a row.
- **A session is bound at the start of an attempt or never.** The six routes that start
  one call `DeviceBinding.atStart` (through the flow router's `clientContext`); the
  thumbprint lives in the attempt's state and reaches `Sessions.create` from `finish`. No
  later step reads the `DPoP` header, and nothing adds, changes or removes a key: there is
  no rebind and no unbind, and the database refuses the write
  (`sessions_device_thumbprint_immutable`). A new way to start an attempt calls
  `clientContext` with its headers and gets a row in `device-binding.router.test.ts`.
- **A profile's `deviceBinding` is `none`, `optional` or `required`, and one function holds
  the rule** (`DeviceBinding.hold(profile, client, bound)`; ADR 0043, "The profile says
  whether a native sign-in may, or must, bring a key"). `none` refuses a proof
  (`device.binding_not_supported`), `required` refuses a native start without one
  (`device.binding_required`), `optional` is what binding was before the option. The
  default is the contract's `defaultDeviceBinding(name)`: `none` for `web`, `optional` for
  every other profile; never a second default. **A `web` client, and a `stateful` profile,
  are unaffected by every value**, decided before the settings are read: never make
  `required` refuse a browser. The profile judged is the one `resolveSessionProfile`
  gives (the function `Sessions.create` uses): never a second way to pick it. The rule is
  applied in three places and stays in all three: `atStart` (after the route's validators
  and per-address limit, before the proof is judged and before the flow service: nothing
  created, looked up or sent, and **never dependent on the identifier**; keep the
  side-by-side test), `Sessions.requireBinding` as the first thing `finish` does (before
  the attempt's move to `complete` and before a hook: an attempt started before a change
  is refused with its proof already spent, which is the stated cost), and `Sessions.create`.
  `modules/session/device-binding.policy.test.ts` has the table (option, client kind, key,
  session type): a new client kind or session type is a row there.
- **The option decides new sign-ins and nothing about a session that exists.** A bound
  session under `none` still needs its proof; a session that is not bound is refreshed
  under `required`. Never make a refresh read `deviceBinding`: refusing an unbound
  session's refresh would sign out every native user when the option is saved (ADR 0043
  has the alternative and why it was not built). Docs and the dashboard say "new sign-ins
  only" wherever the option is set.
- **Asking less for a key is a weakening** (`settingsWeakenings`:
  `sessions.profiles.<name>.deviceBinding`), with no exception for the `web` or a stateful
  profile; a removed profile is compared with `mobile`; a new `clientSelectable` profile
  is one only when `mobile` is `required` and it asks less. `@tula/config` leaves a
  default `deviceBinding` out of the fingerprint (`withoutUnusedDefaults`), so a file that
  says nothing loosens a server that has `required`, and is flagged. The dashboard's new
  profile takes `mobile`'s value, not the copied `web` profile's `none`.
- **A proof that is not valid is a refusal, never "not bound".** A start with a bad proof
  starts nothing. A proof from a `web` client, and a thumbprint for a `stateful` profile,
  are `device.binding_not_supported`: `Sessions.create` checks again, before the claims
  hook and before anything is stored.
- **`Sessions.refresh` judges the proof right after `rejectEnded` and before everything
  else**: before `rejectBanned` (which revokes), before reuse is judged, before the
  rotation. Never move it later, and never add a write above it: a refresh refused for its
  proof changes nothing (the token is not used, not replaced; the session is alive), **a
  rotated token presented without a proof revokes nothing**, and the grace window hands
  the next token out only with a proof. The proof is judged once per call (`proven`), not
  again on the second pass of a lost rotation: its id is spent by then. The order tests
  in `modules/session/device-binding.test.ts` run every kind of bad proof against a fresh
  token, one inside the grace window and one past it.
- **Sign-out needs no proof, on purpose** (`Sessions.signOut`): a client that lost its key
  must still be able to end its session, so the holder of a copied token can sign the
  owner out and nothing more. A test pins it; gating it is a decision (ADR 0043).
- **The nonce is stateless and per environment** (`DeviceBinding.nonce`: a keyed hash,
  purpose `dpop-nonces`, of the environment and the five-minute period,
  `DPOP_NONCE_PERIOD_MS`). The current and the previous period are accepted, both computed
  and compared in constant time. Never store one, never make it per session, and never
  derive it from anything a request says.
- **The nonce challenge (`device.nonce_required`, 400, `NonceRequiredError`) is given only
  to a proof that is valid and, at a refresh, by the session's key.** A wrong key gets
  `device.proof_invalid` and no `DPoP-Nonce` header, with or without a nonce. **The nonce
  is a freshness value and not a secret**: it is the same for every client of the
  environment, a start gives it to any valid proof, and nothing may be built on a key not
  knowing it; what the refresh route withholds from a wrong key is the challenge. It is not a
  refusal: never count it, audit it or let it change anything. Its status is 400 on
  purpose: a 401 from a refresh means "the session is over" to clients.
- **Every answer to a proven request hands out the next nonce** in `DPoP-Nonce`
  (`proofNonce` of `IssuedSession`: a refresh, the grace path, the completion that creates
  a bound session; and a start that bound). The header is on the CORS expose list and
  `DPoP` on the allow list (`~/middleware/cors`).
- **A proof's id is remembered in shared state, last, and fails closed**
  (`deps.proofReplay`, the `ProofReplayGuard` port: memory, or Redis `SET NX PX` when
  `REDIS_URL` is set). It is asked only for a proof that passed every other check, the
  stored id is `SHA-256(environment : thumbprint : jti)` (never the client's string), and
  it is kept until the proof's nonce stops being accepted. When the store cannot answer the
  answer is `service.unavailable`: never accept a proof on a guess, and never fall back to
  process memory. Both adapters run `adapters/proof-replay.suite.ts`.
- **A refused proof is counted per session and recorded at most once a minute, and ends
  nothing** (`refuse`): the shared limiter's minute key (ids only), `rate_limited` past
  `PROOF_REFUSALS_PER_MINUTE`, and the minute's first refusal written as
  `session.refresh_proof_refused` through `sessions.reportRefusedProof` (actor `system`,
  the closed `reason`, `suppressedInPreviousMinute`). Only refusals are counted: never
  count a valid proof, and never write one audit entry per refusal (the log is append-only
  and a copied token can be presented for ever). A limiter that cannot count is
  `service.unavailable` and no entry. **A refusal whose entry could not be written is
  still `device.proof_invalid`**, never a 5xx: that minute's entry is lost (the tally has
  moved) and an error line with fixed words, the environment, the session and the error's
  name, never its message, is its trace. **Never revoke a session, or a token family, for
  a refused proof.**
- **Nothing of a key or a proof travels.** `session.created` says `deviceBound: true` and
  nothing else; no event, audit entry, log line, error or hook question holds a
  thumbprint, a `jwk`, a `jti` or a proof. The thumbprint is in the session row and in the
  access token's `cnf.jkt` (`cnf` is a reserved claim name), and nowhere else.
- **The API asks for no proof with an access token.** `sessionAuth()`, the admin verify
  route and `@tula/nextjs` accept a bound session's token as any other. `cnf.jkt` is for
  an application's own backend; a resource-side check is a decision, not an addition.
- **A device does not outlive its session.** There is no table of devices and no key that
  earns anything at the next sign-in. Never read `device_thumbprint` to recognise a device
  across sessions or to skip a factor. **The one use beyond a refresh is the new-device
  notice** (`Notices.newSignIn`, ADR 0043 and ADR 0023): a bound session's sign-in is from
  a new device when `SessionStore.hasBoundSessionBefore` says no earlier session of the
  user, in the notice's unchanged horizon, has the same key; an unbound session is judged
  by its family as before. That method answers a boolean and no thumbprint leaves the
  store for it; the email is the same one and names the family. A reinstalled app is a
  new device, and that is said in the docs. A second use of the thumbprint is a decision.
- **What is said of a bound session is the boolean `deviceBound`, in the words "bound to a
  device key".** The session lists (`toSession`: the user's and the admin's), the React
  SDK, the dashboard and `@tula/mcp` say it; none returns a thumbprint.
  `.claude/hooks/wording.test.ts` fails for "device verification", "verified device" and
  "trusted device" in the docs, the READMEs, `localization.ts`, the contract's error
  messages and the dashboard's sources: the server knows a key signed, not whose hands a
  device is in. Its allow-list is exact sentences that deny the term; never a file.
- **Signing out other sessions, and one session, needs no recent authentication and no
  proof**, bound or not (`POST /v1/client/sessions/revoke-others`,
  `DELETE /v1/client/sessions/:sessionId`): ending sessions is what an owner does when
  something looks wrong. Never put `requireRecentAuth()` or a proof on either; a test pins
  both.
- **The codes are `device.*`, never `session.*`**, and `@tula/core` never ends its local
  session for one (`session.ts`): a `session.*` answer to a refresh means the session is
  gone, to the SDKs and to applications. A new code for a proof goes in that namespace and
  in the client's "does not end the session" test.
- **`@tula/core` makes proofs in the transport, for a closed set of operations** (`PROVEN`
  in `transport.ts`: the six starts and `refreshSession`), keeps the nonce in the
  transport's closure (never storage), and repeats a request **once** after
  `device.nonce_required`, inside the same call and the same deadline (a refresh still
  gives up within `REFRESH_TIMEOUT_MS`, and stays inside the single flight). A `web`
  client is refused a `deviceKey` at construction. The package stays Zod-free and
  portable: what makes a proof is `@tula/contract/device-binding`, web platform APIs only.
  **The transport asks for the key before each such request** (`Environment.deviceKey`, a
  `DeviceKeySource`; [ADR 0052](../../docs/adr/0052-expo-native-providers-and-device-keys.md)):
  it is handed the operation and answers a key, or `undefined` for "send this one without
  a proof". The option `deviceKey` is such a source that always answers the same key. A
  source that throws is `device.key_failed`, with nothing of the cause, exactly as a key
  that fails to sign; a `DeviceKey` may bring `proofId()` for an engine with no
  `crypto.getRandomValues`. **The lookup and the signing are inside the call's one
  deadline** (`prove` in `transport.ts`: one promise the call's abort rejects): a key
  store call that never settles is `network.timeout` with nothing sent, never a refresh
  that holds the single flight for ever, and what it answers late is dropped without an
  unhandled rejection. Never await a source or a signature outside that; keep the four
  tests of "a key store that never answers". Never let a source decide anything but which key: no retry,
  no session logic.
- **The conformance runner signs with software keys it makes per run** (`request.proof`):
  never a key, a thumbprint or a proof in a scenario file. A proof names
  `target.publicUrl ?? target.baseUrl`, on either instance. The device-binding scenarios
  need no `needs…` flag: nothing they use is missing from a live server.
- Not built, each a decision of its own (ADR 0043, "Not decided here"): a proof bound to
  the refresh token it travels with, an owner's notice for a refused proof,
  attestation, a `deviceBound` input to a hook, refusing an unbound session's refresh
  under `required`.
- **A profile that requires a key on a deployment that cannot bind is said by the
  diagnostics, never stopped and never skipped** (`device_binding`, ADR 0043, "A deployment
  that cannot bind, and a profile that requires a key"; ADR 0031). There no native client
  signs in under that profile (`device.binding_required` without a proof,
  `device.binding_not_supported` with one: `hold` runs before `available()`, a test pins
  both, keep that order); a sign-in that gets another profile is not held to it. Never refuse the save for it (a settings document stays valid on
  every deployment) and never skip `required` where binding is unavailable. The check
  counts, inside the one bounded scan `master_key` makes (never a second scan; an
  environment's settings are read once a run and shared with `sms_sender` and the native
  checks), only where `DeviceBinding.available` is false, **two kinds of environment
  apart**: `fail` with a count where the profile a native client gets by default requires
  a key; `warn` with a count where only a profile a sign-in has to ask for does ("a native
  sign-in that asks for such a profile cannot succeed": never "no native app can sign in"
  of that state, an app that names no profile does); `warn` with neither (the deployment
  still binds nothing); `ok` and nothing read where it can bind.
  **Which profiles count, and as which, is `DeviceBinding.nativeKeyRequirement`**, which
  asks `resolveSessionProfile` and `hold`: never a second statement of who is held. **A
  scan that did not read every environment says so first**, through the native checks'
  `whole` (never a second copy of that sentence, never at the end). Fixed text
  that names `PUBLIC_URL` and never its value, no environment's id and no profile's name,
  **and no cause**: `available` is `canBeNamed`, and a path is only the usual reason it is
  false (a host with a `~` is another `env.ts` accepts), so the words are "not an address
  a device-binding proof can name", in the check and in the boot warning, and the fix
  describes an address that is one (`device-binding.public-url.test.ts` has the rows).
  Its `ok` says that no proof was made or checked, so never reword it to claim a client's
  proof is accepted. A new sentence is added to the test that holds every one to 512
  characters.
