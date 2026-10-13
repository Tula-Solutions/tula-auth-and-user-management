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
- Every exported schema has `.meta({ ref: 'Name' })`.
- Keep this package free of Node/Bun-only APIs. It must run in browsers and React Native.
- The entry points SDKs load at run time must not import Zod, and a new subpath is added in
  three places (`publishable-packages.md`). Such a module takes types only from the schema
  modules.
- An activity type's fixture is in `event-fixtures.ts`; what a new type needs, and why a
  payload only grows, is in `audit-and-events.md`.
- Redirect URLs (`src/redirect-url.ts`, ADR 0044, Zod-free, the `./redirect-url` subpath):
  the three kinds an entry may be, `REDIRECT_SCHEMES_NEVER_CUSTOM`, the two closed lists
  of providers with and without PKCE (`bindsCodeWithPkce`; a provider is in exactly one)
  and `customSchemeRedirectRefusal`. The settings schema, the API, the dashboard and the
  CLI use these and have no rule of their own. App-link paths (`isAppLinkPath`,
  `normalizeAppLinkPaths`, `MAX_APP_LINK_PATHS`) are in `native-app.ts`.
- Native apps (`src/native-app.ts`, ADR 0040): the identifier patterns, the caps, the two
  file builders and `nativeAppWeakenings` live here and are used by the API, the dashboard,
  `@tula-tech/config` and the CLI. A new relation or section of a served file is an entry here
  (`ASSET_LINKS_RELATIONS`) and a decision in the ADR, never a request field.
- After changes: `bun run contract:generate` (writes `openapi.json`) and run the contract tests.
  Use `/contract-change`.
- Device binding (`src/device-binding.ts`, ADR 0043): the header names, the closed
  algorithm list (`DPOP_ALGORITHMS`: `ES256` alone), the `DeviceKey` interface,
  `createDpopProof`, `jwkThumbprint` and `generateSoftwareDeviceKey` live here, on web
  platform APIs only, and are what the server's tests, `@tula-tech/core` and the conformance
  runner all use: never a second proof builder. A new algorithm is a decision in the ADR.
  The test holds the thumbprint RFC 9449 gives for its example key.
- A session profile's `deviceBinding` (`src/session-profile.ts`): the default is
  `defaultDeviceBinding(name)` and nothing else (`none` for `web`, `optional` otherwise),
  which is why the `web` profile has a schema of its own (`WebSessionProfileSchema`).
  Asking less is a weakening in `settingsWeakenings`; a new value of the enum is a
  decision in ADR 0043, with its place in `DEVICE_BINDING_STRENGTH`.
- ID-token sign-in (`src/oauth.ts`, ADR 0045 and 0047): `ID_TOKEN_PROVIDERS`, which client
  kinds may start for each (`ID_TOKEN_CLIENT_KINDS`), which provider has
  `additionalClientIds` (`takesAdditionalClientIds`: Google alone; Apple's audiences are
  its environment's iOS apps), and the exchange's strict body (`idToken`, and the two
  optional names of `MAX_ID_TOKEN_NAME_LENGTH`). A new provider is an entry in the first
  two and a decision in an ADR about its audience and its nonce.
