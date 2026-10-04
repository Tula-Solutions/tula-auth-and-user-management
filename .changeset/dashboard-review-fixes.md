---
'@tula/contract': patch
---

Review fixes of the dashboard step (ADR 0032).

- The OpenAPI snapshot: `POST /v1/instance/session` now says that a sign-in is counted in a
  bucket of its own (10 a minute per IP) and that failed sign-ins are recorded at most once a
  minute per address. The request and response shapes are unchanged.
- Documented: an application under a Content-Security-Policy without `'unsafe-eval'` should
  set Zod's `jitless` before importing `@tula/contract` (docs/releasing.md).
