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
- `error-codes.ts`, `headers.ts`, `issuer.ts`, `password-rules.ts`, `theme.ts`,
  `event-types.ts` and `webhook-signature.ts` must not import Zod (types only from schema modules): they are the entry
  points SDKs load at run time. A new subpath goes in both `exports` and
  `publishConfig.exports`, and in `bunup.config.ts`; `entry-points.test.ts` bundles each one
  and fails if it imports Zod or the three lists disagree.
- A new activity type is a name in `event-types.ts`, a `data` schema in `events.ts` and a
  fixture in `event-fixtures.ts`. An event's `data` is an allow-list and, once webhooks deliver
  it, a public shape: fields are only ever added.
- After changes: `bun run contract:generate` (writes `openapi.json`) and run the contract tests.
  Use `/contract-change`.
