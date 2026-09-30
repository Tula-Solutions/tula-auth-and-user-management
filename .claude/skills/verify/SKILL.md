---
name: verify
description: Run Tula's full quality gate (Biome, typecheck, tests with coverage, contract and migration drift), fix whatever fails, and rerun until green. Use before /review-loop, before committing, or when asked to "verify", "check everything" or "make CI pass".
---

# Verify

1. Run `bun run verify` from the repo root. It is exactly what CI runs.
2. If it passes, report the pass table and stop.
3. If it fails, classify each failure and fix the **root cause**:
   - **Biome:** run `bun run check --write` for autofixable issues. Fix the rest by hand. Never add
     `biome-ignore` without a same-line reason.
   - **Typecheck:** fix the types. No `any`, no `@ts-ignore`. `@ts-expect-error` only in tests,
     with a reason.
   - **Tests:** decide whether the code or the test is wrong. Never weaken an assertion or delete
     a test to get green. If the test encodes a real requirement, fix the code.
   - **Coverage below threshold:** add behaviour tests for the uncovered branches (failure paths
     first). Don't write tests that only execute lines.
   - **`contract:check` drift:** run `bun run contract:generate` and review the diff. An
     unintended change means the code is wrong.
   - **`db:check` drift:** run `bun run db:generate`, then review and commit the migration.
4. Rerun `bun run verify`. Repeat until green. If the same failure survives 3 fix attempts, stop and
   report it with your diagnosis rather than looping.

## Report

```
| Gate          | Result | Notes |
| check (biome) | ✅/❌   |       |
| typecheck     | ✅/❌   |       |
| tests + cov   | ✅/❌   | lines x% / functions y% |
| contract      | ✅/❌/n/a |     |
| migrations    | ✅/❌/n/a |     |
```
