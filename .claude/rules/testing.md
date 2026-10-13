---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "conformance/**"
---

# Testing rules

The rules of the test runner, timeouts, `toMatchObject` and dates, coverage and the
documentation tests are in `AGENTS.md`, "Testing"; conformance scenarios and client journeys
in `conformance.md`. This file adds what they do not say.

- `createTestDeps(overrides?)` takes overrides, and its clock can be advanced: use
  `deps.clock.advance('10m')` instead of sleeping. No real SMTP in unit tests.
- Restore a spy with `mockRestore()`.
- A time inside a subset match:
  `expect(comparable(row)).toMatchObject(comparable({ nextAttemptAt: due }))`. When a test is
  about a boundary in time, make the mutation once and see it fail.
- Test behaviour through the public function or HTTP route (`app.request`), not private helpers.
- Security-sensitive modules test the **failure paths**: expired, reused, wrong environment,
  wrong key, too many attempts, malformed input.
- Table-driven tests (`test.each`) for policies and flow transitions.
- Name a regression test after the behaviour, e.g.
  `test('reused refresh token revokes the whole family')`.
- Never mark a scenario `not_applicable` to get a guard green.
