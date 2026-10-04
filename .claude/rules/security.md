---
paths:
  - "apps/api/src/modules/flow/**"
  - "apps/api/src/modules/mfa/**"
  - "apps/api/src/modules/factor/**"
  - "apps/api/src/modules/oauth/**"
  - "apps/api/src/adapters/oauth/**"
  - "apps/api/src/lib/totp.ts"
  - "apps/api/src/modules/session/**"
  - "apps/api/src/modules/password/**"
  - "apps/api/src/modules/jwks/**"
  - "apps/api/src/modules/verification/**"
  - "apps/api/src/lib/crypto.ts"
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
28. **OAuth first factor:** the exchange goes through `Factors.requiredFor` like every first
    factor. Test that a user with a second factor gets `needs_second_factor` and no tokens.
29. **Provider credentials and tokens:** client secrets and Apple keys are sealed
    (`secret-box`, purpose `oauth-credentials`, bound to environment + provider; test a
    ciphertext copied to another environment's or provider's row) and never returned, logged
    or audited. **No provider access, refresh or ID token is stored or logged**; an adapter
    returns a profile and nothing else. ID tokens: `RS256` only, issuer, audience, expiry and
    the attempt's nonce (test each, and `alg: none`, a foreign key, a tampered payload).
    Subjects are stable ids (`sub`, GitHub's numeric id), never a login or an address.
30. **The mock provider** exists only with `ENVIRONMENT=local` and `OAUTH_MOCK_PROVIDER=true`:
    `env.ts` refuses it elsewhere, and with a `PUBLIC_URL` that is not loopback; the container
    logs a warning at boot while it is on; the routes are not mounted otherwise; and the consent
    page redirects only to this API's callback. Keep all of them, each with its test.
