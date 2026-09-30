---
paths:
  - "apps/api/src/modules/flow/**"
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
2. **Secrets at rest:** tokens, codes, API keys are stored as SHA-256 hashes; signing keys and TOTP
   seeds are encrypted with `TULA_MASTER_KEY`.
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
10. **JWT:** verify algorithm (`EdDSA` only), `iss`, `aud`, `exp`, and `kid` against the environment's
    JWKS. Reject `alg: none` and unknown `kid`.
