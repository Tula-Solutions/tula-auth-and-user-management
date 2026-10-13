---
paths:
  - "apps/api/src/modules/passkey/**"
  - "apps/api/src/lib/webauthn*"
  - "apps/api/src/modules/flow/**"
---

# Passkeys (WebAuthn)

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## Security rules (non-negotiable)

- **A WebAuthn response is verified against origins the request's own headers and the
  environment's rows decide, in one function.** `Passkeys.relyingParty` takes the `Origin`
  header and the declared client kind and returns the relying-party id and the **set** of
  origins a response may carry; nothing in a body chooses the origin or the relying party.
  **A request with an `Origin` is judged by that header alone, whatever kind it declares**
  (an empty one and `null` included): accepted only when the environment allows it **and**
  it belongs to `passkeys.rpId`, and the set is that one origin. **A request with no
  `Origin` is accepted only for the kind `ios` or `android`, compared whole, and only for
  the origins of that platform's registered apps, an iOS app's only where the environment
  allows it as a page's** ("Native apps" above); with no such app or origin,
  and for `web`, `server`, no kind or an unknown one, it is `request.origin_not_allowed`,
  as a request with no `Origin` always was. Never add a third way to an origin, never let
  one platform's origins be accepted under the other's name, and never fall through from a
  refused `Origin` to the native rule. **The client kind is the caller's claim**: it picks
  the set, the response must still match it, and the server never says a request came from
  an app (ADR 0027 has what a false claim gains; keep that argument true when touching the
  rule). Call `relyingParty` on every passkey step, before anything is counted, spent or
  stored (it is also the "passkeys still on" and the "app still registered" check).
  **`~/lib/webauthn` compares the response's origin with the set by exact string
  equality**: never normalise an origin on either side (case, padding, a trailing slash, a
  port), and an empty set verifies nothing. Responses are checked only through
  `~/lib/webauthn` (user verification always required; every failure the same `null`) and assertions only
  through `Passkeys.assert`, which enforces the owner, the user handle, the signature counter
  (a counter that does not grow is refused and audited; zero both sides is fine) and records
  the use with a compare-and-set.
- **A WebAuthn challenge is 32 random bytes, used once, for five minutes, and is taken before
  the response is judged.** A sign-in's lives on its attempt and is taken with a
  compare-and-set on its value; a registration's and a step-up's live in `passkey_challenges`,
  bound to the session that asked. Never accept a challenge from a client beyond matching it.
  Everything that can refuse a request without looking at the response comes **before** the
  challenge is taken and before a guess is counted: the relying party, then the environment's
  ceiling. The unauthenticated start is counted under its own ceiling (`passkeyStart`), never
  `verify`: every open sign-in page asks for one.
- **A failed passkey sign-in is always `auth.invalid_credentials`,** whatever the reason
  (an app that is not registered and a certificate that is not a registered fingerprint
  among them: the same status, body and headers as an unknown passkey, and no error code
  of their own), and its options are the same for every caller (no `allowCredentials`). There is no lockout for it
  (no identifier, nothing guessable): the per-IP and per-environment limits bound it.
- **Removing the last way to sign in is refused in the store's transaction**
  (`OAuth.canStillSignIn`, which counts a password, an emailed code, providers and passkeys):
  for an identity and for a passkey alike. The admin factor reset is the one exception (it
  removes every passkey, on purpose), and it reports the outcome by the same rule: the
  `x-tula-can-still-sign-in` response header and `canStillSignIn` on the audit entry.

## What to test

The failure paths a change here is held to (moved from the checklist of `security.md`; the
rules themselves are above and are not repeated).

- **Responses,** for registration and for every place an assertion is accepted (sign-in,
  second factor, step-up): client data for another origin, another allowed origin than the
  request's, **for a native request an origin that is not exactly a registered app's**
  (another certificate's, the other platform's, standard base64, padding, hex, another case,
  a trailing slash, a port: `modules/passkey/native.test.ts` has the table; a new spelling
  gets a row), an RP ID hash for another relying party, no user verification, another user's
  credential, another environment's, a wrong or missing user handle. A failed sign-in
  creates no session and sets no cookie.
- **Challenges:** a replayed response (on its own attempt and on a new one), a right response
  after a wrong one for the same challenge, an expired challenge, two concurrent requests
  with one response (one session), a challenge of another session and of another purpose
  (`registration` and `step_up`).
- **Origin and method:** no `Origin` from `web`, a disallowed one, an allowed one outside
  `passkeys.rpId` and a look-alike host are `request.origin_not_allowed`. Test a response
  made on `https://<rpId>` and sent with no `Origin` where that origin is off the list, as
  `ios` and as `android`, for a sign-in, a registration and a step-up, and that the start
  answers as with no iOS app. An app or a fingerprint removed mid-ceremony refuses the finish
  (and leaves the challenge unused when no app of the platform is left). The generated table
  in `native.test.ts` (apps × switches × origins × client kinds, against an oracle) holds the
  rule: a new input to `relyingParty` is a new column of it.
- **Nothing used up by a refusal:** passkeys switched off mid-attempt is
  `auth.method_disabled` and the same response completes once it is back on. "Nothing"
  includes the second-factor guess budget (sign-in second factor **and** step-up: assert
  `deps.lockout.attempt` was not called with `Mfa.secondFactorLockKey`) and the challenge: a
  `rate_limited` or `service.unavailable` from the environment's ceiling leaves it usable.
- **Signature counter:** growing is accepted; equal or lower is refused and recorded
  (`user.passkey_counter_regressed`, never the credential id); zero both sides is fine; the
  stored counter does not move on a refusal.
- **Passkey and two-step verification:** a sign-in by passkey never answers
  `needs_second_factor` or `needs_factor_enrolment` (test with TOTP enrolled and with
  `mfa.policy: required`), and its `amr` has `mfa`. After a password, `passkey` is among the
  options only for a user with an authenticator app or under a `required` policy; with
  passkeys off it never is.
- **Management:** register, rename and remove need `requireRecentAuth()`; the limit is
  enforced in the insert's transaction; the last way to sign in cannot be removed (test with
  every other method off, and that a remaining one allows it); the admin reset ends every
  session and reports `canStillSignIn` `false` for a passkey-only user; no response, audit
  entry, email or log line holds a public key or a credential id.
