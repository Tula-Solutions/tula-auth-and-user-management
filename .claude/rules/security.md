---
paths:
  - "apps/api/src/modules/flow/**"
  - "apps/api/src/modules/mfa/**"
  - "apps/api/src/modules/factor/**"
  - "apps/api/src/modules/oauth/**"
  - "apps/api/src/modules/passkey/**"
  - "apps/api/src/lib/webauthn.ts"
  - "apps/api/src/adapters/oauth/**"
  - "apps/api/src/lib/totp.ts"
  - "apps/api/src/modules/session/**"
  - "apps/api/src/modules/password/**"
  - "apps/api/src/modules/jwks/**"
  - "apps/api/src/modules/verification/**"
  - "apps/api/src/lib/crypto.ts"
  - "apps/api/src/lib/outbound.ts"
  - "apps/api/src/modules/webhook/**"
  - "apps/api/src/modules/native-app/**"
  - "apps/api/src/middleware/**"
---

# Security-sensitive code — checklist

Before finishing any change here, confirm each item holds and has a test:

1. **Enumeration:** sign-in with an unknown identifier behaves exactly like a known one: same flow
   step, same error code, comparable timing (dummy-hash verify).
2. **Secrets at rest:** high-entropy tokens and API keys as SHA-256; 6-digit codes as HMAC-SHA256
   (keyed, bound to the token id); signing keys and TOTP seeds encrypted with `TULA_MASTER_KEY`.
   Refresh-token children are derived (`HMAC(key, parent id)`), never stored recoverably.
3. **Comparison:** secrets are compared with `timingSafeEqual` on equal-length buffers.
4. **Randomness:** only `randomToken()` / `crypto.getRandomValues`. Never `Math.random`.
5. **Refresh rotation:** a used refresh token presented again revokes the entire family and emits
   `session.reuse_detected`. Sole exception: within `refresh.reuseGracePeriod` (see
   `packages/contract/src/session-profile.ts`) the server returns the *same* already-issued child;
   it never mints new tokens for a reused parent. Test both sides of the window.
6. **Expiry:** every token, code, flow attempt and session checks expiry against `deps.clock`.
   Idle and absolute session timeouts are both enforced.
7. **Attempts & rate limits:** verification codes have a max-attempts counter; credential
   endpoints are rate-limited per IP + identifier + environment.
8. **Tenancy:** every read and write is scoped to the resolved environment. A key or session from
   environment A can never touch environment B.
9. **Logging:** nothing sensitive in logs, errors or responses (`internalMessage` is logs-only).
10. **JWT:** verify algorithm (`EdDSA` only), `iss` (the per-environment `environmentIssuer`), `aud`,
    `exp`, and `kid` against the environment's JWKS. Reject `alg: none`, unknown `kid` and missing `kid`.
11. **Signing keys:** a key is published as `next` for at least `NEXT_KEY_MIN_AGE_MS` before it signs;
    private keys only ever leave the database sealed (`~/lib/secret-box`) and live in memory as
    non-extractable `CryptoKey`s.
12. **Attempt binding:** every flow step loads its attempt through the flow service's `load`, which
    requires the attempt's secret (`x-tula-attempt`). Missing, wrong, another attempt's, or an
    attempt with no stored hash: the same `flow.not_found` as an unknown attempt, with nothing
    counted, spent or sent. The secret is returned only by the start, stored only as SHA-256 and
    never logged or audited. Test every new step with each of those.
    **Method still on:** every step, including the ones an attempt waits on after its first
    factor (`needs_email_verification`, a second factor, an enrolment, a resend), calls
    `requireProvenMethod` after `load` and before anything is counted, spent or sent: it
    re-checks the first factor the attempt proved (`firstFactor` in its state: a settings
    switch, `Passkeys.relyingParty`, or `OAuth.credentials`). Test each parked step with its
    method switched off mid-attempt: `auth.method_disabled`, nothing used up.
13. **Origin of a browser flow:** an attempt started as `web` is refused
    (`request.origin_not_allowed`) at its start and at every step from an origin the environment
    does not allow, before any state changes (no guess counted, no code consumed, no session, no
    `Set-Cookie`). Test it at the router for every route that can complete a flow.
14. **First factors:** what a sign-in start offers comes from the environment's settings only
    (`Factors.firstFactors`), never from the identifier or the account.
15. **Second factor:** nothing reaches `complete` past a required second factor. A step that
    accepts a first factor (or a reset) asks `Factors.requiredFor` and returns no tokens on
    `needs_second_factor`. Test that no session exists until the factor is proven.
16. **Email first factors:** asking for a code or link (`first-factor/prepare`) answers, costs
    and is limited the same for an address with and without an account (a notice with no code
    and no link, a decoy token). A code counts against the identifier's lockout, shared with
    the password. A token of one purpose (`email_verification`, `password_reset`, `sign_in`) is
    refused for every other. Test known and unknown addresses side by side. A sign-up without
    a password re-checks on every step that `signUp.password` is still `optional`. Code
    attempts and link polls are limited per IP in separate buckets.
    **Pre-hijack:** an emailed code or link (or the code after a passkey sign-in) that
    verifies a previously unverified address removes the account's password in the same
    store transaction (`markEmailVerified` with `removePassword`), audited
    (`user.password_changed`, `removed: true`) and announced. After a password sign-in, in a
    sign-up and in a reset the password stays. Test both, and that a failed transaction
    leaves the address unverified **and** the password in place.
17. **Link binding:** an emailed link is accepted only with the `linkBinding` the asking client
    was given (SHA-256 on the attempt, constant-time compare). Missing, wrong or another
    attempt's binding: `verification.different_browser`, with the token **not** consumed and no
    session. A dead, replayed or foreign token: `verification.expired`. Accepting a link
    returns no tokens; only the holder of the attempt's secret completes. Test the attacker's
    case: their attempt must never complete because someone else opened the link.
18. **Redirect allow-list:** a redirect URL must equal an entry of `urls.allowedRedirectUrls`
    exactly (`Settings.requireRedirectUrl`); loopback `http` only in the `local` tier. Test a
    longer path, an added query or fragment, another case, a look-alike host and credentials in
    front of an allowed host. A link's token goes in the URL fragment, never the query.
19. **TOTP:** RFC 6238, SHA-1, 6 digits, 30 s; the current step ± 1 only, every candidate
    compared in constant time. A step is accepted **once** (`FactorStore.useTotpStep`, strictly
    greater than the last used step, a compare-and-set): test the same code twice sequentially
    and concurrently, and an earlier step's code after a later one. The secret is stored sealed
    (`secret-box`, bound to environment + user + factor id): test that a ciphertext copied to
    another user's or environment's row does not verify. A pending (unconfirmed) or lapsed
    enrolment never satisfies a sign-in or a step-up.
20. **Backup codes:** stored only as a keyed hash bound to the user; input normalised (case,
    spaces, dashes); single use under concurrency; another user's code is refused; all replaced
    on regeneration and deleted when MFA is turned off or reset.
21. **Second-factor guesses:** every route that checks a TOTP or backup code (sign-in, reset,
    enrolment confirmation, step-up) counts the guess under `Mfa.secondFactorLockKey` before
    the check: one budget across methods and routes. No tokens and no session exist at
    `needs_second_factor` or `needs_factor_enrolment`.
22. **Step-up:** a route that changes how an account is protected has `requireRecentAuth()`.
    Test a stale `auth_time` (refused), a fresh one (accepted), a refreshed token (claims
    unchanged), and that a user with a second factor cannot step up with the password alone.
    `auth_time` and `amr` come from the session row, never from the request.
    A password guess by someone who holds a session (a password step-up, the current
    password of a change-password) counts under the one per-user key `Mfa.stepUpLockKey`,
    never a key per route: test that guesses on one route use up the other's budget.
    **Step-up by emailed code** (`email_code`): listed by `Mfa.stepUpMethods` only for a
    verified address and no confirmed second factor. Test that a user with a second factor is
    refused both the send and the code; that a code asked by one session, one user or for
    another purpose (`email_verification`, `password_reset`, `sign_in`) steps up nothing, and
    a `step_up` code is honoured nowhere else; expired, reused, replaced and out-of-guesses
    codes; that the guess is counted (`step_up:<environment>:<user>`) before the check; the
    send limits; and that neither the code nor the address reaches a log line, an audit entry
    or a limiter key.
23. **MFA secrets never leak:** no Base32 secret, `otpauth://` URI, backup code or TOTP code in
    a log line, audit entry, email or error body. Only the responses that return them (start,
    confirm, regenerate, in-flow confirm) carry them, with `Cache-Control: no-store`.
24. **Recovery:** a password reset never removes or bypasses a second factor; only the owner
    (after a step-up) or an admin reset removes one, and the admin reset ends every session.
25. **OAuth state and ticket (ADR 0026):** the callback finds its attempt by `state` alone
    (hash compared in constant time) and consumes it **before** the code exchange, success or
    not; a replay gets an error and no second exchange. It sets no cookie, creates no session,
    returns no token and reflects nothing from the provider: a 303 to the attempt's
    allow-listed URL with a ticket or a contract code in the **fragment**, or a constant page.
    The ticket is single use, 60 seconds, stored hashed. Test a missing, unknown, tampered,
    replayed, other-provider and other-environment state, and a replayed and expired ticket.
26. **OAuth binding:** the exchange needs the ticket **and** the binding the starting browser
    was given. Missing or wrong: `oauth.different_browser`, nothing completed, nothing used up
    (login CSRF). The attempt's secret is rotated at the exchange. Test that an attacker's
    ticket with a victim's (or no) binding creates no user, no session and no `Set-Cookie`.
27. **OAuth account linking:** every row of the table in `OAuth.resolveAccount` has a test. A
    known identity is its user whatever the provider's email says; a missing or unverified
    provider address is refused **before** any lookup by address; an automatic link needs the
    Tula address verified too, else `oauth.account_exists`. Unique violations (two callbacks
    for one new identity, a link racing a deletion) end in a contract error or a sign-in, never
    a 500. Removing the last way to sign in is refused inside the store's transaction.
    The table is stated once per provider in `modules/oauth/linking-table.test.ts`: a new
    provider adds its rows (the test fails for one that has none).
    **X and Facebook** (`OAUTH_PROVIDERS_WITHOUT_ADDRESS`, the one place that says so) are
    never linked by address and never refused for lacking one: an unknown identity makes a
    user with **no email address**. Test that an address on the provider's side, verified
    or not, connects nothing to the account that has it and appears in no answer; that two
    callbacks for one new identity make one user; that such a user's only identity cannot
    be removed (`identity.last_sign_in_method`), that it cannot be given a password and is
    sent no email; and that every other provider with no address is still
    `oauth.email_missing`.
28. **OAuth first factor:** the exchange goes through `Factors.requiredFor` like every first
    factor. Test that a user with a second factor gets `needs_second_factor` and no tokens.
29. **Provider credentials and tokens:** client secrets and Apple keys are sealed
    (`secret-box`, purpose `oauth-credentials`, bound to environment + provider; test a
    ciphertext copied to another environment's or provider's row) and never returned, logged
    or audited. **No provider access, refresh or ID token is stored or logged**; an adapter
    returns a profile and nothing else. ID tokens: `RS256` only, issuer, audience, expiry and
    the attempt's nonce (test each, and `alg: none`, a foreign key, a tampered payload).
    Subjects are stable ids (`sub`, GitHub's numeric id), never a login or an address.
    **A Microsoft token** (`adapters/oauth/microsoft.ts`) is accepted only with `iss` equal
    to `https://login.microsoftonline.com/<tid>/v2.0` for its own `tid`, a signing key whose
    `issuer` covers that issuer, and a tenant the configured `tenant` accepts; the account
    is `<tid>:<oid>`, never `sub` or an address; the address is verified only with
    `xms_edov === true`. Test each refusal with a locally signed token. Widening `tenant`
    (one organization to `organizations` or `common`) is **not** a recorded weakening
    (`diff.test.ts` pins it): it admits accounts from more directories, though a sign-up
    still needs the verified-domain claim, so say so when a change touches it.
    **Whether an ID token's nonce is checked is said at every call** of `verifyIdToken`:
    the attempt's nonce, or `NONCE_NOT_ECHOED` for a provider that documents no nonce
    (LinkedIn only, which has no PKCE either: ADR 0026 says what binds its code). Never
    give the parameter a default, and never pass the symbol for a provider that echoes one.
    **Discord** (`adapters/oauth/discord.ts`): the account is the user id, accepted only
    through `isSnowflake`; the address is verified only with `verified === true`.
    **LinkedIn** (`adapters/oauth/linkedin.ts`): the ID token is verified for `sub` (only
    the two issuers of `LINKEDIN_ISSUERS`) and nothing else of it is read; the address,
    `email_verified === true` (the boolean) and the name come from the userinfo answer
    alone, whose `sub` must equal the token's (`linkedInProfile`, shared with the mock;
    a mismatch is `invalid_token`). Test `"true"`, `1` and an absent field for both, and
    for LinkedIn a mismatched and a missing `sub` and a token that says verified beside an
    answer that does not. **X** (`adapters/oauth/x.ts`) and **Facebook**
    (`adapters/oauth/facebook.ts`): the account is the numeric id (`isXUserId`,
    `isFacebookUserId`: digits only, no sign, no leading zero), never a username or a
    name; the profile's `email` is `null` whatever the answer holds (test an answer that
    carries an address, and that no email scope or field is asked for). X sends PKCE;
    Facebook has none and sends `appsecret_proof` (test its value against a known HMAC and
    that it is in no error). **A profile read with an access token** (Discord's user,
    LinkedIn's userinfo, X's `/2/users/me`, Facebook's `/me`) goes through `readProfile` (`adapters/oauth/profile-read.ts`): a
    fixed address, a deadline, `redirect: 'error'`, 64 KiB. Each adapter tests a redirect
    that is not followed, the cap and the timeout, and that a failure carries nothing of
    the answer or the token.
30. **The mock provider** exists only with `ENVIRONMENT=local` and `OAUTH_MOCK_PROVIDER=true`:
    `env.ts` refuses it elsewhere, and with a `PUBLIC_URL` that is not loopback; the container
    logs a warning at boot while it is on; the routes are not mounted otherwise; and the consent
    page redirects only to this API's callback. Keep all of them, each with its test.
31. **Passkey responses (ADR 0027):** verified only through `~/lib/webauthn` and
    `Passkeys.assert`. Test, for registration and for every place an assertion is accepted
    (sign-in, second factor, step-up): client data for another origin, another allowed origin
    than the request's, an RP ID hash for another relying party, no user verification, another
    user's credential, another environment's, a wrong or missing user handle. Every failed
    sign-in is `auth.invalid_credentials`, creates no session and sets no cookie.
32. **Passkey challenges:** single use and five minutes. Test a replayed response (on its own
    attempt and on a new one), a right response after a wrong one for the same challenge, an
    expired challenge, two concurrent requests with one response (one session), a challenge of
    another session and of another purpose (`registration` vs `step_up`).
33. **Passkey origin and method:** `Passkeys.relyingParty` on every step, before anything is
    counted or used: no `Origin`, a disallowed one, an allowed one outside `passkeys.rpId` and
    a look-alike host are `request.origin_not_allowed`; passkeys switched off mid-attempt is
    `auth.method_disabled` and uses nothing up (the same response completes once it is back on).
    "Nothing" includes the second-factor guess budget (sign-in second factor **and** step-up:
    assert `deps.lockout.attempt` was not called with `Mfa.secondFactorLockKey`) and the
    challenge: the environment's ceiling is charged after the relying party and **before** the
    challenge is taken, so a `rate_limited` or `service.unavailable` leaves it usable. The
    unauthenticated start has its own ceiling (`passkeyStart`), never `verify`.
34. **Signature counter:** growing is accepted, equal or lower is refused and recorded
    (`user.passkey_counter_regressed`, never the credential id), zero both sides is fine, and
    the stored counter does not move on a refusal.
35. **Passkey and MFA:** a sign-in by passkey never answers `needs_second_factor` or
    `needs_factor_enrolment` (test with TOTP enrolled and with `mfa.policy: required`), and its
    `amr` has `mfa`. After a password, `passkey` is among the options only for a user with an
    authenticator app or under a `required` policy; with passkeys off it never is.
36. **Passkey management:** register, rename and remove need `requireRecentAuth()`; the limit
    is enforced in the insert's transaction; the last way to sign in cannot be removed (test
    with every other method off, and that a remaining one allows it); the admin reset removes
    them (it is never refused as "the last way in") and ends every session, and says what that
    left: `x-tula-can-still-sign-in` on its 204 and `canStillSignIn` on the
    `user.passkey_removed` entry, by `OAuth.canStillSignIn` (test a passkey-only user: `false`);
    no response, audit entry, email or log line holds a public
    key or a credential id.
37. **Session profiles (ADR 0028):** a session's limits are its profile's **as configured
    now**, through `Sessions.profileOf` and the session service. Test both sides of every
    limit you touch, a profile tightened after the session was created (ended at its next
    refresh or request), one loosened (never past the stored absolute limit), and a deleted
    one (the built-in for the client kind). The profile a client asks for
    (`x-tula-session-profile`) is honoured only when `clientSelectable`: test an unknown name,
    one not offered, the other kind's built-in and an inherited object key (`constructor`);
    each gives the client kind's built-in and the same answer. Read profiles by own key only.
38. **Stateful sessions:** the token (`tula_st_…`) is derived, stored only as SHA-256, never
    rotated and never in a body. Test that it is refused as a refresh token and a refresh token
    as it; another environment's key; a revoked, idle and over-age session on the **very next**
    request; and that a Bearer header, when present, decides alone.
39. **Cookie authentication and CSRF:** the session cookie is read only where
    `requestMayUseSessionCookie` allows. Test, for a read and for every kind of mutating
    route: an `Origin` the environment does not allow, `Sec-Fetch-Site: cross-site` with an
    allowed `Origin`, and an unsafe method with no `Origin`. Each must leave the request
    unauthenticated with **nothing changed and no `Set-Cookie`** (a foreign page must not be
    able to clear the cookie either). Cookies only through `~/modules/session/cookies`
    (`__Host-` prefix over https, `HttpOnly`, `SameSite=Lax`, no `Domain`).
40. **Concurrent sessions:** the limit is enforced by `SessionStore.create` in one
    transaction per user; the service names and denylists the sessions to end first. Test
    simultaneous sign-ins at the limit in the shared store suite (both adapters), that only
    live sessions count, that another user's and another environment's sessions are never
    ended or counted, and that `refuse_newest` creates no session, sets no cookie, and is
    answered only after every factor was proven (a wrong password at the limit is still
    `auth.invalid_credentials`).
41. **Backend verification:** `POST /v1/admin/sessions/verify` needs a secret key of the
    session's own environment, never answers a refresh token with claims, and never writes
    the token to a log or an audit entry.
42. **Dashboard session (ADR 0032):** minted and verified only by `~/lib/dashboard-session`;
    cookies only through `~/middleware/dashboard-session`. Test a tampered payload and
    signature, expiry at exactly eight hours with no extension, a correctly signed payload
    that claims more, a session from before an admin-token rotation and a master-key change,
    and the cookie's exact attributes over http and https (two paths, never `/v1`). Sign-in:
    a wrong, missing, malformed and unreadable token (empty body, not JSON) are the same
    `auth.invalid_key`, counted before the check in the sign-in's own bucket, refused when
    the limiter cannot count, and recorded with nothing of what was presented. Failures are
    recorded through `ControlPlane.recordFailedSignIn` (one entry a minute per address, with
    a count; the tally is keyed by a keyed hash of the address): never one row per failure
    in an append-only table that anyone can reach.
43. **Dashboard CSRF:** for every route a cookie can authenticate, test each leg alone: a
    foreign `Origin`, `Sec-Fetch-Site: cross-site` with an allowed `Origin`, no
    `x-tula-dashboard` header (the cookie is ignored), and an unsafe method with no `Origin`.
    Each must change nothing and set no cookie. An origin from an environment's settings is
    never enough: only `PUBLIC_URL` and `CORS_ORIGINS`, exactly, in every tier. The `local`
    tier's loopback rule is never applied to a cookie (cookies are not scoped by port): test
    another localhost port.
44. **One credential per request:** the dashboard header or `x-tula-environment` with an
    `Authorization` header is a 400; the admin token is refused on `/v1/admin/*` and a secret
    key on `/v1/instance/*`; the environment of a dashboard request comes from the
    environment's own row, and an unknown or malformed id is the same 404, after the session
    was checked.
45. **HTML responses:** every route that answers HTML carries a Content-Security-Policy with
    no script source other than `'self'` (or none) and `nosniff`; `lib/api-docs.test.ts` walks
    the route table. The API reference is served only where `API_DOCS` is on, from the
    installed package, never a CDN, and never with inline script or `unsafe-eval`. A change
    to it is checked in a browser (`e2e/tests/dashboard/api-docs.spec.ts`: no violation, no
    request to another host).
46. **Static files:** a new way to serve a file goes through `resolveDashboardFile`. Test
    `..`, encoded separators, a backslash, an absolute path, a NUL, a dot file and a link that
    leaves the directory; and that a missing asset is a 404, not the app.
47. **Webhooks (ADR 0034):** the signing secret is made by the server (32 random bytes,
    `whsec_` + base64), returned only by the registration, stored only sealed (`secret-box`,
    purpose `webhook-secrets`, bound to environment + endpoint id: test a ciphertext copied to
    another endpoint's and another environment's row) and never in a log line, an audit entry,
    an event payload or an error. An endpoint's address is in no audit entry or payload
    either (`changed: ['url']`, never the value). The address is judged by the outbound
    guard when it is saved (`Outbound.check`) **and** at every delivery (`Outbound.request`):
    test a name that passed when saved and resolves to a private address at delivery, and
    that nothing was sent. A refusal answers `webhook.url_not_allowed` with the guard's fixed
    word and never the address or what it resolved to. Of a receiver's answer only the status
    code and the duration are kept: test with a canary in the answer's headers and body
    against the delivery row, the logs and every store. One endpoint's failure, slowness or
    removal mid-round must not fail the round or another environment's deliveries. Bulk settling
    (`settleBefore`) is strict at its cutoff: test the event at the very instant of the
    earliest switched-on endpoint's registration (owed, not settled), a switched-off
    endpoint, and another environment. The endpoint cap is counted and inserted under
    `deps.environmentLock` (`webhook_endpoints`): keep the concurrent-registrations test.
    **Retries and the log (TULA-42):** an event is settled when its deliveries are queued,
    never held for a failing endpoint. Test the whole schedule on the test clock (a
    millisecond early is too early), the eighth failure, and that a request sent and not
    recorded is sent again and not counted. `endpoint_unresponsive` and `signing_failed` mean
    nothing was sent: never an attempt row, never counted (test many more rounds than there
    are attempts), bounded only by age. Switching an endpoint off: `410` at once; a run of
    failures five days long and not a millisecond less, where a run has no success and no
    silence longer than `WEBHOOK_FAILURE_RUN_MAX_GAP_MS` (test the silence exactly at the
    limit and a millisecond over, and one failed delivery, five quiet days, one failure:
    still on); one success resets it, re-enabling resets it, and a reset made while a round is sending
    is not undone by that round's next failure (`setHealth` compares what was read: test the
    stale write in the store suite and the round in the service), and the `webhook_endpoint.disabled` entry is the `system`'s with no address or
    secret. A test event carries `test: true` inside the signed body, writes no outbox row
    and no audit entry, goes through the guard (test a name re-pointed at a private address),
    and its answer has five named fields and no canary. Sending again: the stored payload
    only, appended to the same delivery, refused while pending, for an endpoint that is off
    and for an event that is gone, and **impossible across environments** (their key with our
    endpoint id, with their own, and a sibling endpoint: 404, nothing sent). Both are behind
    `sendRateLimit` (per environment, refuses when it cannot count). A delivery sent again
    that gets through clears the endpoint's run; a test event never does; a failed one of
    either moves nothing. A delivery has at most `WEBHOOK_MAX_TOTAL_ATTEMPTS` requests
    (`attempt_limit`), and the list is paged and counted inside
    `WEBHOOK_DELIVERY_LIST_WINDOW`. An answer over the size cap is judged by its status code,
    which is all the guard passes on: test a 2xx (delivered, once) and a non-2xx, with a
    canary in the oversized body. **Secret rotation (TULA-43):** the new secret is the
    server's, returned once (`no-store`), and nothing of either secret is in a read, an audit
    entry, an event payload, a log line or an error (test with both secrets and their base64
    parts, and that no response field is even named like a secret). During the overlap every
    delivery carries two signatures, the current secret's first; test the end of the overlap
    one millisecond before and at it **on the clock alone** (no round has cleared the row),
    a previous secret that expires mid-round, and that a test event and a delivery sent
    again sign the same way. Never three: test a rotation during an overlap (409,
    `rotation_in_progress`, nothing changed or recorded), two at once (one wins, in the
    service and in the store suite), and the instant the overlap ends (allowed). The early
    end: with and without an overlap under way, and at the instant it ended by itself. Both
    are impossible across environments with the answer an unknown id gets. Bindings: an
    existing row sealed the old way still opens; the current ciphertext in the previous slot
    and the previous one in the current slot do not; nor one from another endpoint or
    environment. A previous secret that does not open: delivered with one signature, said
    once per endpoint per round; a current one that does not: nothing sent, and no rotation
    (`secret_unreadable`). The expired ciphertext is deleted by the next round, on an
    endpoint that is off too, unrecorded and without moving `updatedAt`. `verifyWebhook`
    with a list: either secret, both orders, an empty list, a third secret, a malformed
    entry beside a good one, and one HMAC per secret whichever matched. The retention deletes
    are bounded in the database: test a recent event, an unsettled one, a pending delivery
    and a recent one against the store on PGlite, and that `created_at` and `occurred_at`
    cannot be updated to get past the floor.
48. **The outbound guard (`lib/outbound.ts`):** an error carries a fixed word and, for
    `response_too_large` only, the answer's status code: never a header or a byte of a body.
    Keep the test that the socket is destroyed when an answer streams past the cap. Every rule of `request` is a rule of `check`,
    and both share the functions that hold them; a new rule gets a row in both tables of
    `outbound.test.ts`. Its settings come from `deps.outbound` only, which `container.ts`
    builds as `{ tier }` and nothing else (a test holds that): never pass a resolver or a
    certificate from configuration, and never call an operator's address with `fetch`.
49. **Hooks (ADR 0035):** the `before_sign_up` hook is asked only where an account is about
    to be created: for a proven address, or at the first sign-in with a provider of
    `OAUTH_PROVIDERS_WITHOUT_ADDRESS` (X, Facebook), where the question's `email` is `null`.
    Test, for every sign-up path that has an address, an existing and a new
    address side by side: the same answers, and the receiver not called at the start, for a
    wrong code, for a decoy attempt, without the attempt's secret, from a foreign origin, or
    for an address that has an account. A path with no address has nothing to put side by
    side, so its test is about when: the receiver is called only at the exchange, after the
    binding is checked (not at the start, not at the callback, not for another browser's
    binding), and never for an identity that is already someone's
    (`modules/oauth/x-facebook.test.ts`). A denial and a failure leave no user, identity,
    session or `user.created`, and end the attempt. Every kind of bad answer (a non-2xx
    whatever its body, a redirect, an oversized body, not JSON, an unknown key, a `code`
    beside an `allow`, a late answer, a hang) is a failure, tested in both failure modes:
    refused as `hook.unavailable` by default, let through with `hookBypassed` under `allow`.
    The deadline: 5001 refused by the contract and by the database, and the service never
    passes more than 5000. An address that passed when saved and resolves to a private one
    when called is not called. A secret that does not open sends nothing; a ciphertext sealed
    for another hook, another environment or under the webhooks' purpose does not open.
    Another environment's hook, a disabled hook and a removed hook are never asked; a hook
    changed mid-attempt applies as it is when the account is about to be created. An answer
    with extra fields changes nothing about the account or its session. An administrator's
    create asks nothing. Nothing of an answer beyond the decision and the code reaches a
    store, a log line or an error (canary in the answer's headers and body), and no log line
    holds the address asked about. `allow` on failure, switching a hook off and removing one
    that is on are recorded with `weakened: true`.
    **`before_session`** is asked in `finish` only. Test, side by side, a wrong and a right
    password, a locked account and a sign-in waiting on a second factor: the receiver is
    called only for the one whose every factor is proven, and the answers before that are
    the same with and without a hook. A denial and a failure under `deny` leave no session,
    no token, no `Set-Cookie`, no `session.created` and no new-device notice; a hang ends in
    bounded time and sets `lastFailedAt` / `lastFailureReason`. A refresh and a step-up do
    not ask it. **`before_token`**: an answer with `sub`, `amr`, `emailVerified`, `userId`
    or `__proto__`, a nested value, a key beside `claims`, or claims over the cap with the
    template is a failure in both modes and never partly applied; the token of a session
    made with such an answer under `allow` equals one made without a hook. A refresh, a
    refresh in the grace window and a stateful request make no call and do not read the
    hook store; a step-up asks again and replaces what is stored (also with nothing, when
    the hook is gone or failed under `allow`), and under `deny` a failed call fails the
    step-up and leaves `amr`, `auth_time` and the claims as they were. Stored claims that
    break a rule are issued as none. Two step-ups at once never store claims of neither,
    and a step-up that keeps losing asks exactly `STEP_UP_ATTEMPTS` times and then answers
    503 with nothing changed (mutate the constant both ways). A template that outgrows a
    session's stored claims costs the template's claims, never the hook's: test the
    refresh, its replay in the grace window and both ways through a stateful check, and an
    address that grew. `before_session`'s question has no email address; `before_token`'s
    has neither an email nor an IP address. An enrolment inside a sign-in that a hook then
    refuses leaves the factor absent, no backup code valid and no new session, and the
    user's earlier sessions ended and denylisted (they end before the factor is on, as
    ADR 0025 orders it: pinned, not fixed).
    A backup code used for a refused sign-in is spent (nine left): pinned, not fixed.
50. **JWT templates (ADR 0036):** custom claims are issued only under `ext`, only from the
    closed source list or an operator's constant, and only through `CustomClaims.build`.
    Test: every reserved name and every malformed key refused at save, with the field's
    path; each cap one over (templates, claims, key length, constant length, bytes at the
    sources' maxima); a profile naming a missing template; removing a template in use; a
    token of a profile without a template has exactly the old claim set; a template with no
    value for a user adds no `ext`; nothing a request said (IP address, user agent) and no
    name reaches a claim (canary); a template changed between sign-in and refresh; another
    environment's template never applied; a stale settings cache on another instance; a
    stored document with an unknown source or a dangling name still signs in; over the cap
    at build drops the whole namespace of a template alone and logs no value; a stateful session's answer
    carries the same claims; a refresh reads the user once. For a reader: a forged or
    malformed `ext` (not an object, an array, a reserved key, a nested value, over the cap)
    is absent, in a token and in the sealed header, with and without the middleware.
    Neither a template's name, a claim's key nor a constant appears in an audit entry or an
    event's payload.
51. **Phone numbers and SMS (ADR 0037):** a text message is sent only through `Sms.sendCode`
    (the `SmsSender` port; a failed send is `sms.unavailable`, never "sent"), and only after
    `Settings.requireSms` for that number, which every step that sends or accepts a texted
    code calls before anything is counted, spent or sent. An empty `sms.allowedCountries`
    allows nothing. The development inbox (`SMS_PROVIDER=dev`, `/v1/dev/sms/messages`) exists
    only with `ENVIRONMENT=local` and a loopback `PUBLIC_URL`, refuses a request with an
    `Origin` and one whose `Host` is not loopback (DNS rebinding), and is checked in `env.ts`,
    `container.ts`, `createApp` and the handler: keep all four. A phone number is personal data: never in a log line, an audit entry, an event
    payload, an error or a limiter or lockout key (a keyed hash there). A phone code is a
    `phone_verification` token whose keyed hash covers the user and the number, guessed under
    `Phone.codeLockKey` (its own per-user key, never `Mfa.stepUpLockKey`). Test: SMS off, on
    with no country, a country not listed, a country removed and SMS switched off between
    the send and the confirmation, another user's code, a code for a number that was
    replaced, a wrong, used and expired code, the lockout, a failed send leaving the earlier
    code working, no recent authentication, and the inbox route in every other tier.
    Every send limit is in `Sms.sendCode`, after `requireSms` and `requireSender` and
    narrowest first; the daily limit (`sms.dailyMessageLimit`) is counted in
    `sms_code_counts` by the one store method `SmsUsageStore.takeFromDay` (one transaction
    on one connection under `pg_advisory_xact_lock`; never `deps.environmentLock`, whose
    holder keeps a connection while its work needs another) before the send, never in the
    rate limiter; narrow limits are counted before wide ones and a send a wide limit
    refuses keeps what the narrow ones counted; the database keeps the last seven days of
    counts whatever a delete asks (`sms_code_counts_retention_floor`); all of it fails closed and answers the one `rate_limited`. Limiter keys
    hold keyed hashes of the number, the address and the prefix; counts are by calling
    prefix (at most four digits), never by number. Test: each limit alone, a refused send
    counted by no wider limit, the limiter failing at each key, the day's take failing,
    two sends at once for the day's last message, a wide refusal still costing the asker,
    a delete of today's count deleting nothing, a failed send counted back
    out, and no number, prefix or address in a key, a log line or the usage answer.
    The Twilio sender (`SMS_PROVIDER=twilio`, `adapters/sms/twilio.ts`) holds its credentials
    in a closure (never a property, `deps.config`, a log line or an error; not given to the
    worker), calls one constant host with `redirect: 'error'`, a deadline, a response cap and
    `tls: { rejectUnauthorized: true }`, never retries, counts any 2xx as sent (its body is
    for the log only), says `failed` only for an answer that refuses (a 4xx, a 3xx, a
    redirect) and `unconfirmed` for everything else, **any 5xx included, whatever its
    body**, and logs Twilio's own text only through `maskProviderMessage` (digits are joined
    across any three characters that are not ASCII letters or digits, never a list of
    separators).
    `Sms.sendCode` gives a message back to the day only for `failed`: a send whose outcome
    is unknown stays counted. Its
    variables are judged at boot only when it is chosen. Test (stubbed `fetch`, never a
    request to Twilio): which of the three outcomes each kind of answer and each way of getting none is, that an
    unconfirmed send leaves the day's count one higher and spends the day's last message
    while a failed one does not, the timeout, both
    credential forms, both senders, the text arriving unchanged, and the canary (an answer
    that repeats the number and the credentials: none in the error, none unmasked in the
    log).
52. **Password history (ADR 0038):** a new password is compared with the user's previous
    ones only in `Users.replacePassword`, last of its checks (after the proof of the account
    and `Passwords.assess`, before the hash and before a reset's code is spent), for a
    user's own password and never for an administrator's. Every stored hash is verified in
    turn with no early exit; the refusal is `password.reused` with `params.history` and
    nothing about which matched, and is not logged or recorded. The comparison is counted
    per user (`PASSWORD_HISTORY_CHECKS_PER_HOUR`), the old hash is kept and the surplus
    deleted in the store's transaction, and the write is a compare-and-set on the hash that
    was compared with. Test: a history of 0, 1 and 3 (the third-last refused, the
    fourth-last accepted), another user's and another environment's passwords not counting,
    an account with no password, an administrator's password recorded and not refused, a
    hash upgrade adding no row, the unproven password's removal deleting the history, a
    deleted user's rows gone, a failed change leaving credential and history untouched, two
    changes at once, the per-user limit and the limiter failing, and no hash, count or index
    in the error, the log or the audit entry. A reset's proof is the emailed code alone, also
    for a user with a second factor (the password is stored before the factor is asked for):
    keep the test that such a user gets `password.reused` with the code unspent, and never
    skip the comparison for them. A reset's code is spent and its sessions ended once, before
    the first write: keep the assertions that a refusal on a later pass and the 503 leave
    both done.
53. **Email templates (ADR 0039):** an environment's wording reaches a message only through
    `renderTemplate`, and is judged only by the contract's `emailTemplateProblems` (at save,
    on the tolerant read and again at render). Test: HTML in a subject, a body and a value
    escaped in the HTML part and literal in the text part; a line break or control character
    in a subject (refused at save, cleaned when it arrives through a value); a value that
    holds `{{code}}` not expanded again; a body of only its required placeholder; each cap
    one over, and the section's byte cap; an unknown kind, an unknown placeholder and
    malformed braces refused with the field's path and without the text; a code message
    without its code and a sign-in without its link refused; a notice given `{{code}}` or
    `{{link}}` refused; **every kind**, the code messages included, refused for a scheme
    (`://`, each of `EMAIL_LINK_SCHEMES`), `www.`, a bare domain, an email address and an
    IPv4 address, in its subject and in its body, with `10:30`, `Note: …` and
    `{{appName}}.{{provider}}` accepted, and the built-in copy of every kind passing the
    rule; a notice subject that starts with a digit, with `{{time}}` or
    `{{backupCodesLeft}}`, or with an allowed invisible character and then a digit refused
    at save and, through the app's name, replaced by the built-in subject at render; a
    subject or body of only invisible characters refused as empty; a stored subject
    surviving a stored body that no longer passes, and the reverse, through
    `readStoredEnvironmentSettings`; an app name with a text-direction control refused on
    input and still read when already stored; the HTML part of every notice in the order
    body, facts, the server's sentence, support line, footer; a notice with its own body still ending in the
    server's facts and then the server's own sentence of what to do if the reader did not
    do this (every kind of the notice category, last before the support line, once, in
    both parts); a text-direction control, a private-use or unassigned code point and a
    lone surrogate refused at save, one row per class, never stripped; a zero-width joiner
    and non-joiner accepted and delivered unchanged, and not hiding a domain from the link
    rule; a stored template that no longer passes sending the built-in copy,
    logged by environment and kind; another environment's template never used; a stale
    settings cache on another instance; every kind byte for byte the built-in copy when
    nothing is saved. Neither a subject nor a body appears in an audit entry, an event's
    payload, a log line or an error (the event canary runs the scenario with its text
    tapped), and `@tula/mcp` does not return them.
54. **Signing in with a texted code (ADR 0037):** `sms_code` is off by default. Every step calls
    `requireSmsMethod` first; an account is looked for by number only in
    `Phone.signInHolder` (exactly one holder, proven within a year), only from the prepare
    and attempt steps; a number that does not sign in gets the same answer, the same
    limiter rows and no message (`DecoyMessage`: nothing taken from the day, refused when
    the day is spent), and the real message is `detached` after the day's take, its token
    stored only once the sender took it (`issueWhenTaken`; nothing the detached work throws
    escapes or logs an error's message; a stopping process waits for it in `closeApi`
    before the pool closes); the texted code is spent last, after the email an unverified
    address needs (a refused email leaves it usable for the tries it has left: each
    submission is one of five), and of two right submissions at once the one that loses the
    spending is `auth.invalid_credentials` (for an unverified address the second is
    normally `rate_limited` by the emailed code's cooldown first); the code is an `sms_sign_in`
    token bound to the attempt and the number, guessed under `Phone.signInLockKey`, and
    every failure, a locked number included, is `auth.invalid_credentials`; the session's
    `amr` is `sms`, which is never a recent authentication, a step-up or `mfa`, and never
    enrols a factor (`mfa.enrolment_needs_other_sign_in`). Test: a known and an unknown
    number side by side (answer, limiter counters, outbox), two holders, a stale proof, a
    code for another attempt and another purpose, the lockout's key and order, the method,
    SMS, the country and the sender each taken away mid-attempt, a banned holder, required
    MFA, the step-up refusal, and no number in a log line, an event or an audit entry.
