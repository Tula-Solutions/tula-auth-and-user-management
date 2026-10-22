---
paths:
  - "packages/react/src/components/step-renderer.tsx"
  - "packages/react/src/components/first-factor-forms.ts"
  - "packages/react/src/hooks/use-passkey-support.ts"
  - "packages/react/src/hooks/use-countdown.ts"
  - "packages/react/src/hooks/use-field-errors.ts"
  - "packages/react/src/hooks/use-localization.ts"
---

# Tula UI (the copy-in registry)

Canonical for this area (the path `packages/ui/**` is added to the front matter by the change that creates the package: `agent-rules.test.ts` accepts only paths that match a tracked file); `AGENTS.md` lists this file under "Area rules" and does not repeat
it. The decisions are in [ADR 0064](../../docs/adr/0064-tula-ui.md). The React SDK's own
rules (`react.md`) apply to the headless files above as they do to the rest of
`packages/react`.

- **A copied file is presentation only.** Behaviour and security live in the headless layer
  of `@tula-tech/react`; a registry item calls it and draws what it returns. The registry
  build refuses an item whose files import `@tula-tech/core`, call `client.session.signOut()`
  (sign out through the provider's `signOut`), touch `window` / `document` / `navigator`
  during render, use `dangerouslySetInnerHTML`, call `console`, or hard-code a user-visible
  string (words come from `useLocalization()`). A new refusal gets a row in the build's
  tests; never loosen one to get an item through, change the item.
- **The registry uses shadcn's format** and the developer's own shadcn primitives
  (`@/components/ui/*`). An item never ships a primitive of its own. Install is
  `bunx shadcn add <url>` or `tula ui add`.
- **The step renderer's contract.** `StepScreens` is keyed by `FlowStep['status']`, each
  screen takes its step narrowed to that status, and a key that is not a status is a type
  error. A status with no screen, one this version does not know and a screen that returns
  nothing all draw `UnsupportedScreen`. A screen returns a `ReactElement` or `null` (never
  `ReactNode`: `''` and `[]` must not compile) and runs as a component of its own, so it
  may call hooks. The guarantee is "every status maps to an element or to the fallback"; an
  element that renders nothing is its author's. **There is no fallback prop and there never is one**:
  the "not supported" screen cannot be replaced, hidden or set to `null`. `step-renderer.test.tsx`
  holds the type tests (`@ts-expect-error`) and the unknown-status render; keep both.
- **The headless exports are semver'd.** `StepRenderer`, `FirstFactorForms`,
  `FirstFactorFormProps`, `firstFactorStrategies`, `usePasskeySupport`, `useCountdown`,
  `useRetryCountdown`, `useFieldErrors`, `useLocalization` and `useScreenChanged` carry a
  JSDoc `@example`, appear in `docs/reference/react.md` and are rendered without a DOM by
  `testing/ssr-render.tsx`. A prebuilt component and a copy use the same one: never a second
  implementation of a rule for the registry's sake.
- **Hidden until known, decided in one place.** `firstFactorStrategies(offered, forms, can,
  list)` takes the tri-state `usePasskeySupport()` (`undefined` is "not asked yet", not
  "no") and decides both lists: `'active'` keeps a passkey for `undefined`, `'alternatives'`
  only for `true` (`react.md`). A copy uses the helper and never re-states the rule.
- **Provenance and the lock file.** Every copied file starts with a header (item, registry
  version, hash as copied) and `tula ui add` writes `tula-ui.lock.json`; `tula ui diff` and
  `tula ui update` (a three-way merge) depend on both. A change to either format is a change
  to a published contract: version it.
- **The registry is versioned with `@tula-tech/react`** and an item states the minimum
  version it needs. A release that changes an item for a security reason marks it
  (`security: true` in the item and in the changelog).
- **The theme bridge is generated** from `@tula-tech/contract/theme` to shadcn's variables;
  never edit its output. Tenant values still go only through `themeToCssVariables`
  (`react.md`): the bridge maps token names, it never writes a tenant value.
- **`@tula-tech/ui` is private** (`"private": true`, never in `PUBLISHABLE_PACKAGES`): what
  is published is the registry's JSON at `/r/*.json`. The docs site renders `docs/**` as the
  one source of the documentation; it holds no copy of a page.
