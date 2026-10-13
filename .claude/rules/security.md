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

A rule is stated once: in `AGENTS.md` ("Security rules") when every change must know it, in
its area's file otherwise. This file is the checklist a change to security-sensitive code is
held to in every area: what must hold **and have a test**. It repeats no rule.

Before finishing any change here, confirm each item holds and has a test:

1. **Enumeration:** sign-in with an unknown identifier behaves exactly like a known one: the
   same flow step, the same error code, comparable timing.
2. **Secrets at rest:** a 6-digit code's keyed hash is bound to its token's id, and to
   whatever else the code is for (the user, a number, the session or attempt that asked).
   What is sealed is bound to its row: test a ciphertext copied to another row.
3. **Comparison:** `timingSafeEqual` on equal-length buffers.
4. **Refresh rotation:** a reused parent emits `session.reuse_detected` and never gets new
   tokens. Test both sides of the grace window.
5. **Expiry:** every token, code, flow attempt and session checks expiry against
   `deps.clock`. Idle and absolute session timeouts are both enforced.
6. **Attempts:** a verification code has a max-attempts counter.
7. **Tenancy:** every read and write is scoped to the resolved environment. A key or session
   from environment A can never touch environment B.
8. **JWT:** verify the algorithm (`EdDSA` only), `iss` (the per-environment
   `environmentIssuer`), `aud`, `exp`, and `kid` against the environment's JWKS. Reject
   `alg: none`, an unknown `kid` and a missing `kid`.
9. **Signing keys:** a key is published as `next` for at least `NEXT_KEY_MIN_AGE_MS` before
   it signs; a private key lives in memory as a non-extractable `CryptoKey`.
10. **The outbound guard (`lib/outbound.ts`):** keep the test that the socket is destroyed
    when an answer streams past the cap, and the test that `deps.outbound` is `{ tier }` and
    nothing else: never pass a resolver or a certificate from configuration.
11. **Nothing sensitive in a response:** what a rule keeps out of a log line is kept out of
    an error and a response body too.

## What to test in one area

The failure paths of one area are the "What to test" section of its file, which a change
there is held to as it is to the list above:

| Area | File |
| --- | --- |
| Flow steps, emailed codes and links, redirect URLs | `flow-security.md` |
| Two-step verification, step-up, a texted second factor | `mfa.md` |
| Providers, the mock provider, native ID tokens, Sign in with Apple | `oauth.md` |
| Passkeys, a native app's origins | `passkeys.md` |
| Session profiles, stateful sessions, the cookie and CSRF, the session limit | `sessions.md` |
| A device key and its proofs | `device-binding.md` |
| Custom claims | `jwt-templates.md` |
| The dashboard's session, its CSRF, HTML responses, static files | `control-plane.md` |
| Webhooks | `webhooks.md` |
| Hooks | `auth-hooks.md` |
| Phone numbers, text messages, a texted sign-in code | `phone-and-sms.md` |
| Password history and expiry | `passwords.md` |
| Email templates | `message-wording.md` |
