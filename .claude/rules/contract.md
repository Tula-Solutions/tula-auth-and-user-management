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
  `event-types.ts`, `webhook-signature.ts`, `custom-claims.ts` and `device-binding.ts` must not import Zod (types only from schema modules): they are the entry
  points SDKs load at run time. A new subpath goes in both `exports` and
  `publishConfig.exports`, and in `bunup.config.ts`; `entry-points.test.ts` bundles each one
  and fails if it imports Zod or the three lists disagree.
- A new activity type is a name in `event-types.ts`, a `data` schema in `events.ts` and a
  fixture in `event-fixtures.ts`. An event's `data` is an allow-list and, once webhooks deliver
  it, a public shape: fields are only ever added.
- Native apps (`src/native-app.ts`, ADR 0040): the identifier patterns, the caps, the two
  file builders and `nativeAppWeakenings` live here and are used by the API, the dashboard,
  `@tula/config` and the CLI. A new relation or section of a served file is an entry here
  (`ASSET_LINKS_RELATIONS`) and a decision in the ADR, never a request field.
- After changes: `bun run contract:generate` (writes `openapi.json`) and run the contract tests.
  Use `/contract-change`.
- Device binding (`src/device-binding.ts`, ADR 0043): the header names, the closed
  algorithm list (`DPOP_ALGORITHMS`: `ES256` alone), the `DeviceKey` interface,
  `createDpopProof`, `jwkThumbprint` and `generateSoftwareDeviceKey` live here, on web
  platform APIs only, and are what the server's tests, `@tula/core` and the conformance
  runner all use: never a second proof builder. A new algorithm is a decision in the ADR.
  The test holds the thumbprint RFC 9449 gives for its example key.
- A session profile's `deviceBinding` (`src/session-profile.ts`): the default is
  `defaultDeviceBinding(name)` and nothing else (`none` for `web`, `optional` otherwise),
  which is why the `web` profile has a schema of its own (`WebSessionProfileSchema`).
  Asking less is a weakening in `settingsWeakenings`; a new value of the enum is a
  decision in ADR 0043, with its place in `DEVICE_BINDING_STRENGTH`.
