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
- A request with no `Origin` cannot use passkeys, **unless it is a registered native app's**
  (below). A server, and a request that names no native client kind, still cannot.

### Native apps (added 2026-10-09, TULA-31)

A passkey ceremony run by an iOS or an Android app has no page, so its request has no
`Origin` header and its client data does not carry a page's origin. What it carries is the
platform's to write, and what the platform writes identifies the app.

**What each platform says, and where from.**

| Platform | The origin in the client data | Source | How sure |
| --- | --- | --- | --- |
| Android (Credential Manager) | `android:apk-key-hash:` followed by the SHA-256 fingerprint of the app's signing certificate, its 32 bytes as base64url without padding | [Create passkeys, "Verify origin"](https://developer.android.com/identity/passkeys/create-passkeys): the fingerprint from `keytool`, the Python lines that encode it (`urlsafe_b64encode` with `=` removed), "accept all the origins as valid" for an app signed with several certificates | Documented by Google. Not seen from a device. |
| Android, a browser or another privileged app | A web origin, set by that app | [Privileged apps](https://developer.android.com/identity/sign-in/privileged-apps) | Documented. Such a caller is a browser to this server and sends the page's `Origin`. |
| iOS (`ASAuthorizationPlatformPublicKeyCredentialProvider`) | `https://` and the relying-party id | **Not in Apple's documentation.** [Supporting passkeys](https://developer.apple.com/documentation/authenticationservices/supporting-passkeys) says the relying-party id is the service's domain and that the app needs a `webcredentials` associated domain for it; it does not say what the client data's origin is. `https://<rpId>` is what developers report (Apple's developer forums, third-party guides) and what a WebAuthn client data origin for that id would be. | **Not confirmed**: no Apple page states it and no device was used. |

What makes a platform willing to run the ceremony for an app at all is the association file
of the relying party's domain ([ADR 0040](0040-native-app-identity.md)): `webcredentials` on
iOS, `get_login_creds` on Android. The server never sees that check. No passkey ceremony was
run on a device or an emulator for this work
([what is not verified](../plans/phase-2-unverified.md#step-28-passkeys-from-a-native-app-tula-31-adr-0027)).

**The rule.** `Passkeys.relyingParty` stays the one place, and now answers the relying-party
id and a *set* of origins (`RelyingParty.origins`):

| The request | The origins a response may carry |
| --- | --- |
| Has an `Origin` header, whatever client kind it declares | That origin, when the environment allows it and it belongs to `passkeys.rpId`: the rule above, unchanged. Otherwise `request.origin_not_allowed`. An empty header and `null` are headers. |
| No `Origin`, `x-tula-client: android` | One `android:apk-key-hash:…` for each fingerprint of each Android app the environment has registered. |
| No `Origin`, `x-tula-client: ios` | `https://<passkeys.rpId>`, when the environment has at least one iOS app registered **and allows that origin** (`urls.allowedOrigins`, by the function that judges a page's origin). |
| No `Origin`, a native kind whose platform has no registered app; or `ios` where the relying party's own origin is not allowed | None: `request.origin_not_allowed`, the answer such a request has always had. The two are the same answer, at the start and at every later step. |
| No `Origin`, any other kind or none (`web`, `server`, an unknown word) | None: `request.origin_not_allowed`, unchanged. |

- **The Android string is built by one function of the contract**, `androidApkKeyHashOrigin`
  (`packages/contract/src/native-app.ts`), which the conformance runner uses too: a server
  and a runner cannot disagree about the encoding, and its test holds values computed
  outside it, by the lines of Google's page.
- **`~/lib/webauthn` compares the response's origin with the set by exact string equality**
  (the library's `expectedOrigin` list, which is `Array.includes`). Nothing is normalised on
  either side: standard base64, padding, hex, another case, a trailing slash or a port is
  another string and is refused. An empty set verifies nothing.
- **An Android origin names a certificate, not an app.** Two registered apps signed with one
  certificate present the same origin, and an app that is not registered but is signed with
  a registered app's certificate presents it too. That is the platform's choice of what to
  put in the string; the package name is in no part of a response. Whoever holds the signing
  key is the operator.
- **An iOS origin names nobody, and it is a page's.** Every app that Apple lets use the
  domain writes the same string, and so does a browser for a page at `https://<rpId>`. The
  registration of an iOS app is therefore a switch ("an app of this environment may present
  the domain's own origin"), and which app it is, is decided by Apple from the file the
  operator publishes.
- **So the iOS origin is accepted only where the environment allows that page**
  (changed in review; the first version accepted it for any registered iOS app). The rule
  for iOS is: no `Origin`, the kind `ios`, at least one iOS app registered, **and**
  `https://<rpId>` among `urls.allowedOrigins`. The last is asked of `acceptsPageOrigin`,
  the function the web rule uses, and the whole native rule is one function
  (`Passkeys.acceptedNativeOrigins`): never a second comparison. That judgement is the
  list's exact entries in every tier: the `local` tier's "any loopback origin" belongs to
  CORS (`allowedOrigin`) and is not used here, and an `https` origin is never loopback's to
  wave through. Why: an operator may leave the relying party's own address off the list on
  purpose (`rpId` `example.com` with a marketing site at the apex, the app at
  `app.example.com`). A script on the apex can run the browser's ceremony for `example.com`
  on a challenge of an attempt it started, and a program can send the result with no
  `Origin` under the name `ios`: a response made on a page the operator did not allow would
  have signed in, registered a passkey or stepped a session up. With the rule, what an iOS
  request may carry is something the operator has allowed in so many words.
- **What it costs, and it is said to the operator.** An iOS app's passkeys need
  `https://<rpId>` on the list, and listing it also lets a page at that address use the
  client API from a browser. There is no way to allow the string for apps only: the server
  cannot tell the two apart (above). `docs/native-apps.md` says both, and `tula doctor`
  warns where an iOS app is registered, passkeys are on and the origin is not allowed
  ([ADR 0031](0031-instance-admin-and-cli.md), `native_app_passkeys`), because the refusals
  would otherwise be silent. Android is unchanged: no page can produce an
  `android:apk-key-hash:` origin.
- **In a flow, the client kind is the attempt's** (`state.client`, fixed when the attempt
  starts), not a header of a later call: an attempt started as `web` cannot finish a
  passkey step as `android`. The signed-in routes (registration, step-up) have no attempt
  and read the header of each request.

**The client kind is the caller's claim, and here is what a false one gains.** A header
proves nothing; what is verified is the response.

- *A page in a browser.* Every passkey route that starts or finishes a ceremony is a
  `POST`, and a browser's `fetch` sends `Origin` with every `POST`, same-origin included; a
  page cannot remove the header. So a page is always judged by its own origin, and
  declaring `ios` or `android` changes nothing. The one passkey route a browser reaches
  without an `Origin` is the list (`GET /v1/client/me/passkeys`), which verifies no
  response.
- *A program that is not a browser* (a script, another app) writes any header it likes. By
  claiming `android` it chooses which origins the server will accept; it must still present
  a response whose client data carries one of them **and** is signed by the private key of
  a passkey the server already holds (or, for a registration, hold a session of the account
  that has recently authenticated). Client data is assembled by the client, not attested:
  whoever holds a passkey's private key outside a platform authenticator (a software
  authenticator, the conformance runner's) can write any origin into it, and could before
  this change write the web origin and send it as an `Origin` header. Nothing is gained
  that the key did not already give.
- *What the origin check is for* is the other case: a real authenticator, which lets its
  key sign only what its platform assembled. There the string is true, and an app the
  operator did not register (or a build signed with another certificate) is refused. That
  is the whole of the claim: **the server refuses what honest platforms report as someone
  else's app; it does not, and cannot, attest that a request came from an app at all.**
  Proof that a request comes from a particular device is device binding, a later step.
- *A false `ios` in particular* claims the one native origin a browser also writes. A
  response with `https://<rpId>` comes from Apple's API for an associated app or from a
  page at that address, and a real authenticator signs it for either. A page cannot drop
  its `Origin` (see above), but a program holding such a response can send it under the
  name `ios`. That is why the origin is accepted only where the environment allows the
  page too: under the rule a false `ios` gains nothing that the page, sending its own
  `Origin`, would not be given. Where the origin is not allowed, a request that says `ios`
  has no ceremony at all (`request.origin_not_allowed`, before an attempt is made or a
  challenge taken), and the same response sent under `android` is judged and refused for
  its origin like any other.

**Refusals, and what they cost.**

- A sign-in whose response carries an origin the environment does not accept (an app that
  is not registered, a certificate that is not a registered fingerprint, a platform's
  origin under the other platform's name) is `auth.invalid_credentials`, exactly as for an
  unknown passkey: the same status, body and headers, no session, no cookie. The challenge
  is spent, as for every judged response.
- A registration is `passkey.registration_failed`, a second factor and a step-up their
  existing failures; none is new, and no error code was added.
- **A native request in an environment with no app of its platform is
  `request.origin_not_allowed`**, at the start and at every later step, before an attempt is
  made, a challenge taken or a guess or a ceiling counted. It is the answer a request with
  no `Origin` had before this change, kept so that registering an app is the only thing
  that changes an answer. It does tell a caller whether an environment has an app of a
  platform, which the public association files already say. An iOS request where the
  relying party's own origin is not allowed gets the same answer at the same places, so
  the two are not told apart (whether an origin is allowed is what a CORS preflight says).
- **That is a different answer from "an app that is not registered, on a platform that has
  one"** (401 `auth.invalid_credentials` at the finish), on purpose. With no app of the
  platform there is no origin a response could carry, so the server can refuse before it
  makes an attempt or spends a challenge, as it does for a page whose origin is not
  allowed; with an app, whether *this* response is a registered app's is known only from
  the response, and a judged response fails like every failed sign-in. Answering the first
  case with a ceremony that can never succeed would hide a public fact at the price of a
  challenge and a ceiling charge per request. Left as it is after review; an owner's call
  if the 403 should become the generic failure.
- A native passkey step reads the environment's apps (one `nativeApps.list`, at most
  `MAX_NATIVE_APPS` rows); a browser's request reads none.

**Removing an app, or a fingerprint, takes its origin away at once**: the set is read from
the rows on every step, so a ceremony begun before the removal does not finish. Where the
removal leaves the platform with no app, the step is refused before its challenge is taken
(the relying party is judged first); where another app or fingerprint remains, the response
is judged, refused for its origin, and the challenge is spent. The passkeys stay.
A passkey belongs to the relying party, not to the app it was made in, and works from the
web or from another registered app; **nothing records which origin a passkey was
registered from**, and nothing should come to depend on it. Changing `passkeys.rpId`
orphans passkeys made in apps as it does every other.

**The conformance runner stands in for the authenticator.** A `passkey` step gives the
client data's origin either as a string (`origin`: a page's, or `https://<rpId>` for an iOS
app) or as an Android certificate's fingerprint (`androidCertFingerprint`), from which the
runner derives the origin with the contract's function. Scenarios 92 to 95 are a
registration and a sign-in from each platform (the iOS half of each first refused, then
accepted once the operator allows `https://<rpId>`; in 93 a response made on that page and
sent as the Android app is the generic failed sign-in), an app that is not registered, and
a fingerprint that is not, or is no longer, the registered one. They show the server's
rule, not a platform's behaviour.

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

**The one step a passkey sign-in can wait on is `needs_email_verification`** (a user whose
address is not verified). That step and its resend are held to the method the attempt proved,
which here is the passkey: `Passkeys.relyingParty` on each (passkeys still on, the request's
origin in the relying party), **not** the password's switch, so the attempt completes where
passwords are off. Once the code is accepted the attempt completes: it has `mfa` in what it
proved, so it is not sent on to a second factor or an enrolment either. The attempt, which
started with no identifier, is stored with the user's address from that point. And because
this verifier did not prove the account's password, an address verified for the first time
this way loses that password (ADR 0024, "A password set before the address was proven").

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
- A native app can use passkeys once it is registered (ADR 0040) and the relying party's
  domain serves the association files; the SDKs that run the ceremony on a device are later
  steps of Phase 2, and until one has, the two origins are the documentation's word.
- Devices cannot be told apart beyond what the authenticator reports (no attestation), and
  `synced` is the authenticator's own claim.
- A user under `mfa.policy: required` whose only factor is a passkey, and who loses it, needs
  an admin reset: there are no backup codes for a passkey. (The same as TOTP without codes.)
- An admin reset can leave an account with no way to sign in; the response header and the
  audit entry say when, and the operator has to act on it.
- The session-challenge table is one more short-lived table for the retention job.

## Not done here

- A passkey ceremony on a device (the native SDKs), cross-origin iframes (`topOrigin`), attestation policies, and
  enrolling a passkey inside `needs_factor_enrolment`.
