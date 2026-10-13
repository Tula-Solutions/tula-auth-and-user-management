---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "conformance/**"
---

# Testing rules

The rules of the test runner, timeouts, coverage and the documentation tests are in
`AGENTS.md`, "Testing"; conformance scenarios and client journeys in `conformance.md`. This
file adds what they do not say, and holds the whole rule about `toMatchObject`, which
`AGENTS.md` only names.

- `createTestDeps(overrides?)` takes overrides, and its clock can be advanced: use
  `deps.clock.advance('10m')` instead of sleeping. No real SMTP in unit tests.
- Restore a spy with `mockRestore()`.
- **Bun's `toMatchObject` does not compare `Date`s**: two different dates match
  ([oven-sh/bun#44405](https://github.com/oven-sh/bun/issues/44405), open; 1.4.2 and 1.4.3).
  Nor a `Map`, a `Set`, a `RegExp`, an `Error`, a function, `Headers`, `URLSearchParams`, an
  `ArrayBuffer`. For a time inside a subset match, pass both sides through `comparable()`
  from `~/testing/comparable`
  (`expect(comparable(row)).toMatchObject(comparable({ nextAttemptAt: due }))`) or use
  `toEqual`; for the other kinds use `toEqual`. When a test is about a boundary in time, make
  the mutation once and see it fail. `.claude/hooks/to-match-object.test.ts` (in
  `test:harness`) reads every call and fails for one whose argument, as written, holds such
  a value unwrapped: `new Date(…)`, `clock.now()`, a key named like a time (`…At`, `…Until`,
  `…Since`, `expires…`) with a name under it, a function, a pattern. It reads text: a date
  that arrives through a variable, a spread or a key not named like a time passes it, so
  the rule still has to be kept by hand. The helper lives in `apps/api` because every call
  that held a date was there (31 of 1,853, audited in TULA-65, none hiding a wrong value);
  a test of another package asserts on the time with `toEqual`, or imports the helper by
  relative path where its tests already import `apps/api/src` (cli, mcp, admin, nextjs,
  expo: `.claude/rules/turbo-inputs.md`).
- Test behaviour through the public function or HTTP route (`app.request`), not private helpers.
- Security-sensitive modules test the **failure paths**: expired, reused, wrong environment,
  wrong key, too many attempts, malformed input.
- Table-driven tests (`test.each`) for policies and flow transitions.
- Name a regression test after the behaviour, e.g.
  `test('reused refresh token revokes the whole family')`.
- Never mark a scenario `not_applicable` to get a guard green.
