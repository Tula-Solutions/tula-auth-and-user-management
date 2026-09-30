---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "conformance/**"
---

# Testing rules

- `bun:test` only. Colocate tests next to the code (`service.ts` → `service.test.ts`).
- Build dependencies with `createTestDeps(overrides?)`: memory adapters + a fixed, advanceable
  clock. Advance time with `deps.clock.advance('10m')` instead of sleeping.
- No network, no Docker, no real SMTP in unit tests. Postgres-backed tests are
  `*.integration.ts`.
- Prefer `spyOn(obj, 'fn')` + `mockRestore()` over `mock.module` (process-global in Bun).
- Test behaviour through the public function or HTTP route (`app.request`), not private helpers.
- Security-sensitive modules test the **failure paths**: expired, reused, wrong environment,
  wrong key, too many attempts, malformed input.
- Table-driven tests (`test.each`) for policies and flow transitions.
- A regression test for a bug or review finding must fail before the fix. Name it after the
  behaviour, e.g. `test('reused refresh token revokes the whole family')`.
