# ADR 0064 — Tula UI: a copy-in component registry, and the docs site

- Status: accepted
- Date: 2026-10-21
- Ticket: TULA-83 (the plan), TULA-84 (the headless layer)

## Context

`@tula-tech/react` ships prebuilt components ([ADR 0022](0022-react-sdk.md)): one
stylesheet, a theme that is data, `appearance` slots. They are the fastest way to a working
sign-in and they stay. They are also a wall for a team whose app already has a design
system: it can recolour them and rename their parts, and it cannot change their markup, put
its own `Input` in them or reorder a form. Clerk-level DX in 2026 includes components a
developer *owns*, the way shadcn/ui's are owned: copied into the app, built from the app's
own primitives, edited freely.

The danger of copying is that a security property is copied with them. A sign-in screen is
mostly behaviour: which step is drawn, that an unknown step is "not supported" and never a
guess, that a passkey control is hidden until the browser has been asked, that a sign-out
whose server call failed is not a sign-out, that nothing but text reaches the DOM. A copy
that re-implements any of it is a copy that drifts from the fixes the package gets later,
and a developer cannot be asked to read ADR 0022 before editing a button.

So the line is drawn where it is cheapest to hold: **a copied file is presentation only.**
Everything that decides stays in `@tula-tech/react`, as public, semver'd API, and the copy
calls it.

## Decision

### The registry uses shadcn's registry format

Tula UI is a registry in shadcn's format (`registry.json`, items with `files`,
`registryDependencies`, `cssVars`). It is installed with `bunx shadcn add <url>`, which
needs nothing from us, or with a new `tula ui add <name>` (`packages/cli`), which does the
same and also writes the provenance and lock file below. The items are built with Tailwind
and the developer's own shadcn primitives (`button`, `input`, `field`, ...): a copy imports
`@/components/ui/*`, never a component of ours.

### Copied files are presentation only

The registry build refuses an item whose files:

- import `@tula-tech/core` (a copy reaches the API only through `@tula-tech/react`'s hooks);
- call `client.session.signOut()` or `.signOut(` on a client (a copy signs out through the
  provider's `signOut`, [ADR 0022](0022-react-sdk.md): a failed sign-out is not a sign-out);
- touch `window`, `document` or `navigator` during render;
- use `dangerouslySetInnerHTML` (or `innerHTML`, `insertAdjacentHTML`);
- call `console`;
- hard-code a user-visible string (every word comes from `useLocalization()`, so that an
  app's translation and the operator's wording reach it).

The check is a source scan, as `package.test.tsx` already is for the package. It is a guard
against an honest mistake, not against an author who means harm: the registry's files are
reviewed like any others, and a developer who edits their copy owns the result.

### The headless layer: what a copy is given

`@tula-tech/react` exports, as public API under the package's semver, the pieces a copy
needs and the prebuilt components already use:

- **`<StepRenderer step screens start screen focusTitle onRestart>`.** `screens` is a
  `StepScreens`: a map from step status to a function of the step *narrowed to that status*.
  The keys are `FlowStep['status']` from the contract, so a key that is not a status is a
  type error, and a screen is handed `step.destination` only for the statuses that have one.
  A status the map leaves out, a status no version of the package knows (a newer server's)
  and a screen that returns `null`, `undefined` or `false` all draw the package's
  `UnsupportedScreen`, with a way to start again. **There is no fallback prop**: the
  "not supported" screen cannot be replaced, hidden or set to nothing, because the rule
  "never a blank card, never a guessed action" is the one a copy is most likely to break by
  accident. `start` is the screen before the first step (`step === null`), kept apart from
  `screens` so that the keys are exactly the contract's statuses. The prebuilt `<SignIn>`
  and `<SignUp>` are drawn through it, with no change to their markup or behaviour.
  `useScreenChanged` is exported with it, for the focus that moves to a new screen's title.
- **The first-factor table as data.** `FirstFactorForms` (strategy to form),
  `FirstFactorFormProps` (what a form is given) and `firstFactorStrategies(offered, forms,
  can)`, the function that chooses which strategies a table can draw: unknown strategies
  skipped, a link, a passkey or a texted code ruled out by the browser or the identifier, a
  phone number given the texted code alone. The prebuilt table (`FIRST_FACTOR_FORMS`)
  stays internal; a copy brings its own and gets the same selection rules.
- **`usePasskeySupport()`**: `undefined` until the browser has been asked after mount,
  then a boolean. Hidden until known: a copy draws a passkey control only for `=== true`.
  It returned `null` for "not asked" while internal; the public value is `undefined`, and
  every internal use compares with `=== true` / `=== false`, so nothing changed.
- **`useCountdown(until)`** and **`useRetryCountdown(error)`**: the second reads the clock in
  an effect when a `rate_limited` error arrives, so a copy never calls `Date.now()` in render.
- **`useFieldErrors(error, fields, credentialsField?)`**: which field a `TulaError`'s
  messages belong to (`errors[].field`, else the code's area), as `placeErrors` already
  decided for the prebuilt forms.
- **`useLocalization()`**: the provider's merged table.

These are semver'd: removing or retyping one is a breaking change, and each has a JSDoc
`@example` that the generated reference carries.

### Provenance headers and a lock file

Every copied file begins with a header naming the item, the registry version
(`@tula-tech/react`'s) and a hash of the file as copied. `tula ui add` also writes
`tula-ui.lock.json` (item, version, per-file hash). `tula ui diff` compares the developer's
file with the registry's current one and with the version it was copied from, and
`tula ui update` does a **three-way merge** (copied version, current registry, the
developer's edits), leaving conflict markers where they overlap. Without the header and the
lock a developer cannot tell what they changed or what they have missed, and a security
fix in a copy would never reach anyone.

### Versioned with `@tula-tech/react`, with a security marker

The registry is versioned with `@tula-tech/react` (they move together under the repository's
fixed version group), and an item states the minimum `@tula-tech/react` it needs. A release
that changes a registry item for a security reason marks it (`security: true` in the item's
metadata and in the changelog), and `tula ui diff` prints those first.

### A theme bridge

`@tula-tech/contract/theme` is the one place a theme is defined
([ADR 0022](0022-react-sdk.md)). The registry's theme bridge is **generated** from it: a
stylesheet block that sets shadcn's variables (`--background`, `--primary`, `--ring`, ...)
from the Tula tokens, so that a developer's copied components and the prebuilt ones can
share one look. **Tenant values still go only through `themeToCssVariables`**, which drops
any value `isValidThemeValue` refuses; the bridge maps token *names* at build time and never
writes a tenant-supplied value anywhere else.

### Tula's own style

The registry ships Tula's own style (the shadcn style named `tula`), so that a copied
component looks like the prebuilt one before the developer changes anything. The registry
build and the docs site's previews use it; a developer's `components.json` may name another.

### `@tula-tech/ui`: a private registry package

The registry lives in a **private** workspace package, `@tula-tech/ui` (`packages/ui`): the
items' sources, the registry build and its refusals, and the theme bridge. It is not
published to npm: what is published is the registry's JSON, served at `/r/*.json`, and
`@tula-tech/react`, which the copies import.

### A static docs site

A private static app, **Vite + React + TanStack Router + Tailwind v4 + shadcn**, renders
`docs/**` as the single source of the documentation, with **live previews** of the
components running on `@tula-tech/core`'s fake API (no server), and serves the registry at
`/r/*.json`. The docs stay in `docs/` and are tested as they are
(`.claude/hooks/docs.test.ts`); the site is a renderer, not a second copy. **Where it is
hosted is undecided** and decided in its own ticket: nothing here depends on it, since both
`bunx shadcn add` and `tula ui add` take a URL.

### The prebuilt components stay

`<SignIn>`, `<SignUp>`, `<UserButton>` and `<UserProfile>` are not deprecated and not
frozen. They are the zero-configuration path, and they are the registry's reference
behaviour: the copies and the prebuilt components call the same headless layer.

## Consequences

- The copies cannot drift in behaviour, only in looks. A fix to the headless layer reaches
  every app on its next `@tula-tech/react` upgrade; a fix to markup reaches an app only if
  it runs `tula ui update`, which is why the security marker exists.
- The headless layer is now API we keep: ten names more in the package's semver surface, and
  about 0.4 kB gzipped more in the bundle (the budget in `package.test.tsx` moved by exactly
  that).
- A step the server adds later is the "not supported" screen in every copy until a copy
  adds a screen for it. That is the intended failure.
- A developer who deletes the provenance header can no longer be merged; `tula ui diff` says
  so, and does not guess.
- The source scan cannot see a string built at run time or a call hidden behind an alias.
  Review of the registry's files stays the control for those.

## Amends

[ADR 0022](0022-react-sdk.md): the components are no longer the package's only UI surface,
and the step renderer, the first-factor table's helpers and the five hooks above are public
API, not internals.
