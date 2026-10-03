---
paths:
  - "apps/api/src/modules/flow/**"
  - "apps/api/src/modules/mfa/**"
  - "apps/api/src/modules/factor/**"
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
23. **MFA secrets never leak:** no Base32 secret, `otpauth://` URI, backup code or TOTP code in
    a log line, audit entry, email or error body. Only the responses that return them (start,
    confirm, regenerate, in-flow confirm) carry them, with `Cache-Control: no-store`.
24. **Recovery:** a password reset never removes or bypasses a second factor; only the owner
    (after a step-up) or an admin reset removes one, and the admin reset ends every session.
