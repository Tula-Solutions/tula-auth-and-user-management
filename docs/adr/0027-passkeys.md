# ADR 0027 — Passkeys (WebAuthn)

- Status: accepted
- Date: 2026-10-03
- Builds on [ADR 0018](0018-environment-settings.md) (settings, `urls.allowedOrigins`),
  [ADR 0019](0019-flow-engine-v2.md) (bound attempts, the origin rule, `FIRST_FACTORS`, the
  second-factor hook), [ADR 0025](0025-mfa.md) (second factors, step-up, `amr`, the admin
  reset), [ADR 0026](0026-oauth.md) (an attempt of its own for a method with no identifier, the
  "last way to sign in" rule), [ADR 0023](0023-security-notices.md) (notices) and
  [ADR 0017](0017-retention.md) (the retention job).

## Context

Phase 1 step 1.10: a user can register passkeys and sign in with one. A passkey is the only
method here that cannot be phished (the browser binds every response to the page's origin) and
the only one that is two factors in one gesture. It also brings the largest piece of third-party
cryptographic input the API has taken so far: attestation objects, COSE keys and signatures
made by devices we do not control.

## Decision

### What a passkey is here

A **discoverable** WebAuthn credential with **user verification**: `residentKey: 'required'`,
`userVerification: 'required'`, attestation `none`, algorithms ES256, EdDSA and RS256
(`PASSKEY_ALGORITHMS`). A response without the user-verified flag is never accepted, at
registration or afterwards. Attestation is not asked for: we do not restrict which
authenticators users may own, and `none` avoids collecting a device identifier.

### Library

`@simplewebauthn/server` verifies attestation and assertion responses, behind
`apps/api/src/lib/webauthn.ts` (`verifyRegistration`, `verifyAssertion`): every reason a
response does not verify is the same `null`, so nothing about *why* reaches a client or a log.
Options are built by the API itself (plain JSON; nothing in them needs the library).

**The clients take no WebAuthn dependency** (the plan named `@simplewebauthn/browser`; this
replaces it). `@tula/core` calls `navigator.credentials` itself: it uses
`PublicKeyCredential.parseCreationOptionsFromJSON`, `parseRequestOptionsFromJSON` and `toJSON`
where the browser has them and its own base64url ↔ `ArrayBuffer` conversion otherwise
(`packages/core/src/passkey.ts`, about 2.3 kB gzipped; the bundle budget moved to 15.5 kB).
It stays portable: no Node API, and a runtime without WebAuthn simply answers
`passkey.unsupported`.

### Relying party and origin

- New setting `passkeys.rpId` (nullable, default `null`): a registrable-domain-shaped host or
  `localhost`; never a scheme, port, path or IP address. New method switch
  `signIn.methods.passkey` (default off). **Switching the method on needs an `rpId`** (both
  schemas refuse the document otherwise). There is no derived default: guessing the relying
  party from an allowed origin would silently bind every passkey to the wrong domain.
- **Changing `rpId` orphans every existing passkey**: an authenticator only offers a credential
  to the id it was made for. The rows stay (users can still remove them).
- The origin a response is verified against is **the request's own `Origin` header**, and only
  when that origin is in `urls.allowedOrigins` **and** its host is the `rpId` or a subdomain of
  it (`originMatchesRelyingParty`). Nothing in a request body chooses it. `Passkeys.relyingParty`
  is the one place this is decided, and every passkey step calls it before anything is counted,
  spent or stored; it is also the "method still on" check (`Settings.requireMethod`'s role), so
  an attempt started before passkeys were switched off cannot finish with one.
- A request with no `Origin` (a native app, a server) cannot use passkeys yet. Native apps prove
  a different kind of origin (`android:apk-key-hash:…`, associated domains); that arrives with
  the native SDKs in Phase 2.

### Challenges

32 bytes from the CSPRNG (`randomToken`), honoured **once** and for **five minutes**, kept only
on the server:

- **Sign-in and second factor:** on the flow attempt (`passkeyChallenge` in its state), which
  binds it to the attempt's secret and, for a browser, the origin rule of `load`. It is taken
  with a compare-and-set on its own value (`StateGuard`) **before** the response is looked at:
  the first response presented uses it up, right or wrong, and of two concurrent requests one
  gets it. What is checked before the response is looked at comes before the challenge is
  taken too: the relying party, then the environment's ceiling. A request refused by either
  (`auth.method_disabled`, `request.origin_not_allowed`, `rate_limited`, `service.unavailable`)
  leaves the challenge to be used by the next one.
- **Registration and step-up:** a row in `passkey_challenges`, one per session and purpose
  (asking again replaces it), taken by `DELETE … RETURNING`. A challenge issued to one session,
  user or purpose is nothing to another.

### Storage

`passkeys` (tenant columns, forced RLS): credential id (unique per environment), COSE public
key (`bytea`), signature counter, transports, AAGUID, backup-eligible and backed-up flags, the
user handle, a name, created and last used. Nothing in it is a secret. `passkey_challenges`
holds the session challenges. Both cascade with the user. Expired challenge rows are purged by
the retention job (`PasskeyStore.deleteExpiredChallenges`, batched, both adapters).

**User handle.** `user.id` is 32 opaque bytes, `HMAC-SHA256(key from TULA_MASTER_KEY,
environment : user)`: the same for every passkey of a user, saying nothing about the email or
the user id without the key. Derived rather than drawn at random and stored ahead of time, so
that nothing has to be kept between the options and the finish; each row records the handle it
was registered with, and an assertion's `userHandle` must equal it. (This departs from "a
stored random handle": the properties asked for hold, with one table fewer to keep consistent.
It is **not** random, and nothing in the code or the contract should say so.)

After a change of `TULA_MASTER_KEY` the derived handle changes, so a user's new registrations
get a different handle than their existing rows. That is harmless: every row carries its own
handle and an assertion is checked against its own row's. The one visible effect is that an
authenticator that still holds an old passkey of the account keeps it beside the new one
instead of replacing it.

**Signature counter.** `0` both sides means an authenticator that keeps none (every synced
passkey): fine. Otherwise the counter must grow; one that does not means a copied credential,
so the assertion is refused (the generic failure) and `user.passkey_counter_regressed` is
recorded. The use is written with a compare-and-set on the stored counter.

### Signing in

A passkey sign-in is an attempt of its own, like OAuth, because it has no identifier:

- `POST /v1/client/sign-ins/passkey` → the attempt (`needs_first_factor`,
  `strategies: ['passkey']`, with its secret) and the request options. **No
  `allowCredentials`**: the answer is the same for every caller. Offering `passkey` among a
  regular sign-in's strategies depends on the settings alone (`FIRST_FACTORS`).
- `POST /v1/client/sign-ins/:attemptId/passkey` → the assertion. Every failure is
  `auth.invalid_credentials`: unknown credential, another environment's, wrong signature,
  origin, RP ID hash or challenge, no user verification, a missing or wrong user handle, a
  stale or used challenge, a counter that went backwards.
- **No lockout.** There is no identifier to lock, and nothing to guess: a credential id is not
  a secret and a signature cannot be brute-forced. Tries are bounded per IP by the route (30 a
  minute) and per environment by the `verify` ceiling. **Starts have a ceiling of their own**
  (`passkeyStart`, 6,000 a minute per environment): every open sign-in page asks for one when
  it loads and again every four minutes for its autofill request, signed in to nothing, and
  under `verify` those would use up what real users' code and second-factor steps need. 6,000
  is 100 page loads a second or 24,000 idle pages; a start costs one attempt row, no hash and
  no email. A lookup miss returns without a
  signature check; the timing difference reveals only whether a credential id exists, which
  its holder already knows.

**A passkey satisfies two-step verification.** A sign-in by passkey never stops at
`needs_second_factor` or `needs_factor_enrolment`, whatever the user has enrolled and whatever
`mfa.policy` says. The session's `amr` is `hwk` (a credential bound to one device) or `swk`
(one its authenticator reports as eligible for backup: a synced passkey), `user`, and `mfa`.
`hwk`, `swk`, `user` and `mfa` are RFC 8176 values. `mfa` is what `requireRecentAuth` and
`finish` read, so a passkey session is "strong" everywhere a TOTP session is.

### A passkey as the second factor, and `mfa.policy`

After a password (or an emailed code, an OAuth provider, a password reset) a user's passkey is
offered as a second factor **only where a second factor is in force anyway**: the user has a
confirmed authenticator app, or the environment's policy is `required`. Otherwise a password
sign-in completes as before.

- So `mfa.policy: required` is satisfied by a user whose only factor is a passkey: they are
  asked for it after their password and are not sent to `needs_factor_enrolment`.
- And adding a passkey for convenience under `optional` does not turn every password sign-in
  into one that needs the device, with no backup codes behind it.
- `needs_factor_enrolment` still offers TOTP only. A passkey is registered from a signed-in
  profile, never inside an attempt.
- The proof goes through the one second-factor entry point (`Flows.submitSecondFactor`,
  `SECOND_FACTOR_VERIFIERS.passkey`): options from `…/second-factor/passkey/options` (they name
  the user's own credentials; the caller holds the attempt's secret and has proven a first
  factor), the assertion to `…/second-factor`. It shares the per-user second-factor lockout.

### Step-up

`passkey` is a step-up method for every user who has one (`POST
/v1/client/sessions/step-up/passkey` for the options, then `POST /v1/client/sessions/step-up`),
including users with TOTP, and is recorded with `mfa`. The step-up resolves the relying party
before it counts a guess: passkeys switched off, or a missing or foreign `Origin`, is refused
with nothing taken from the second-factor budget the user's authenticator codes share. A user with no second factor in force
may still step up with their password or an emailed code, as before. Registering, renaming and
removing a passkey need a recent authentication (`requireRecentAuth()`).

### Managing passkeys

`/v1/client/me/passkeys`: list, `…/options` and `POST` to register (`excludeCredentials` holds
the user's passkeys; at most `MAX_PASSKEYS_PER_USER` = 10, enforced in the insert's
transaction), `PATCH` to rename, `DELETE` to remove. Listing and removing work with the method
switched off.

**The last way to sign in cannot be removed.** `OAuth.canStillSignIn` is the one definition; it
now counts passkeys too, in both directions: removing a passkey is refused
(`passkey.last_sign_in_method`) when no password, emailed code, provider or other passkey
remains, and unlinking a provider is allowed when a passkey remains. The check runs inside the
store's transaction with the user row locked.

**The admin factor reset removes passkeys** (`DELETE /v1/admin/users/:userId/factors`): it is
the "this account's authenticators are gone" tool. Sessions are ended as before. Deleting a
user removes them by cascade.

Unlike the owner's own removal, the reset is **never refused for being the last way in**: a
lost or stolen device is exactly when the only passkey has to go. So it can leave an account
that cannot sign in, and it says so instead of hiding it:

- the response carries `x-tula-can-still-sign-in: true|false` (`CAN_STILL_SIGN_IN_HEADER`),
  worked out with the same `OAuth.canStillSignIn` rule from what the user has left;
- the `user.passkey_removed` entry records the same boolean (`canStillSignIn`) and nothing
  else about what is left.

An account answered with `false` needs the operator to give it a way in: the user's own
"Forgot password" where the password method is on (a reset sets a first password), or
switching on a method the user can use (the emailed code for a verified address).

The route keeps answering `204` with no body. A `200` with a body was the other option and was
not taken: existing clients and conformance scenario 23 check for exactly `204`, so a changed
status is not additive, while a new response header is. (The conformance format gained
`expect.headers` for it.)

Adding and removing a passkey are audited in the same transaction (`user.passkey_added`,
`user.passkey_removed`, with the passkey's row id; never the credential id or the key) and
announced to the owner through the two-step verification notice (`notifications.mfaChanged`),
each with its own hourly allowance. A passkey sign-in goes through the flow engine's `finish`,
so the new-device notice applies.

### Clients

- `@tula/core`: `signIn.canUsePasskey()`, `canAutofillPasskey()`, `withPasskey({ signal,
  autofill })`, `flow.submitSecondFactorWithPasskey()`, `session.stepUpWithPasskey()`,
  `user.passkeys.{list,add,rename,remove}`. Client codes (`status: 0`): `passkey.unsupported`,
  `passkey.cancelled`, `passkey.already_on_device`, `passkey.failed`. The browser's own error
  message is never passed on. An autofill request is restarted with a fresh attempt before its
  challenge lapses, and leaves no timer behind.
- Conformance: a `passkey` step type and a software authenticator in `@tula/conformance`
  (P-256, attestation `none`, Web Crypto only), so scenarios stay HTTP-level JSON.

## Consequences

- An operator must set `passkeys.rpId` and list origins under it before the method can be
  switched on; a misconfigured origin is `request.origin_not_allowed`, at the start.
- Passkeys do not work from native apps until Phase 2.
- Devices cannot be told apart beyond what the authenticator reports (no attestation), and
  `synced` is the authenticator's own claim.
- A user under `mfa.policy: required` whose only factor is a passkey, and who loses it, needs
  an admin reset: there are no backup codes for a passkey. (The same as TOTP without codes.)
- An admin reset can leave an account with no way to sign in; the response header and the
  audit entry say when, and the operator has to act on it.
- The session-challenge table is one more short-lived table for the retention job.

## Not done here

- Native passkeys (Phase 2), cross-origin iframes (`topOrigin`), attestation policies, and
  enrolling a passkey inside `needs_factor_enrolment`.
