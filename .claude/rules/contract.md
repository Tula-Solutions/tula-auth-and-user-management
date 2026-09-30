---
paths:
  - "packages/contract/**"
---

# Contract rules (packages/contract)

- This package is the public contract for every SDK (TS, Swift, Kotlin). Changes are
  **additive by default**. Removing or renaming a field, enum value or error code is a breaking
  change and must be called out in the PR's "Breaking changes" section.
- Error codes are `area.reason` in snake_case (`password.too_short`) with an HTTP status and a
  default English message. Params are typed.
- Every exported schema has `.meta({ ref: 'Name' })` and a JSDoc block; public helpers include
  `@example`.
- Keep this package free of Node/Bun-only APIs. It must run in browsers and React Native.
- After changes: `bun run contract:generate` (writes `openapi.json`) and run the contract tests.
  Use `/contract-change`.
