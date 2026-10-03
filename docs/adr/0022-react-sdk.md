# ADR 0022 — `@tula/react`: components, theming and browser tests

- Status: accepted
- Date: 2026-10-03

## Context

`@tula/react` is the first UI on top of `@tula/core` ([ADR 0021](0021-core-sdk.md)) and the
template for the native UI kits in Phase 2. It has to cover the flows the server has today
(sign-up with email verification, sign-in, password reset, account management), stay correct
when the server gains methods the installed SDK does not know, be themeable to "looks like the
customer's app" (business plan §4.6), be accessible, and render on a server without crashing.
Phase 1's rule 3 adds: browser behaviour is tested in a browser.

## Decision

### Shape

```tsx
<TulaProvider publishableKey baseUrl | client   appearance? localization? navigate? …urls>
  <SignedIn> <SignedOut> <TulaLoading>
  <SignIn> <SignUp> <UserButton> <UserProfile>

useAuth() useUser() useSession() useTula()
useSignIn() useSignUp() useResetPassword()          // headless flows
usePasswordChecklist() useClientConfig()
```

- **One client per provider**, created from the key and URL or handed in. `load()` runs once
  after mount (a module-level map makes React's StrictMode double effect harmless) and is
  retried with a growing delay, and on `online`, while the API is unreachable.
- **State through `useSyncExternalStore`** over the client's `onChange`. The server snapshot is
  `loading`, so server markup and the first browser render agree.
- **`<TulaLoading>` rather than a `fallback` prop**: it composes with `<SignedIn>` /
  `<SignedOut>` and puts the three states side by side in the app's markup.
- **`useSession()` is the session and the device list** (`sessionId`, `sessions`, `revoke`,
  `revokeOthers`), as the plan names it.
- **Flow hooks never reject.** An action resolves with the next step, or `null` with the reason
  in `error`. A rejected promise in an event handler is an unhandled rejection; a form wants
  state. A second action while one is pending resolves `null` and sends nothing.

### Components render the server's step

A component is a `switch` on `step.status`; each case is a screen. There is no flow logic: no
"after the password comes the code". `needs_first_factor` renders the form of each offered
strategy this version knows, from one table (`FIRST_FACTOR_FORMS`, `password` only today);
unknown strategies are skipped. Every other status — `needs_second_factor` until 1.8 ships its
screens, or one a newer server invented — renders **"This step is not supported"** with "Start
again". That default branch is what keeps an old SDK safe: never a blank card, never a guessed
action. Steps 1.7–1.10 add screens and table entries.

Three things the components do know, because they are presentation: which field an error
belongs to (the server's `errors[].field`, else the code's area), that `retryAfterMs` is a
countdown, and that `attemptsRemaining` is worth showing. The countdown only disables the
action for as long as the server said; it decides nothing.

Completion (`onComplete`, or the after-URL) is reported from the action's result, not from an
effect: an app that wraps `<SignIn>` in `<SignedOut>` unmounts it the moment the client is
signed in, before an effect for the completed step could run.

### Navigation and redirects

Components never import a router. The provider takes `navigate` (default
`window.location.assign`) and the app's URLs; components take the same URL props and
callbacks. **A destination is only ever a prop.** Nothing reads `redirect_url` or anything else
from the address bar, which removes the open-redirect class outright; a convenience parameter
can be added later with a same-origin check if it is wanted. URLs are followed only when
relative or `http(s)`.

### Theming: tokens in the contract, private properties in the stylesheet

- `@tula/contract/theme` (Zod-free, JSON-serialisable): the token table (`THEME_TOKENS`: key,
  scope, type, CSS property), `DEFAULT_THEME` (light and dark), `themeToCssVariables` and
  `contrastRatio`. Swift and Kotlin generate constants from the same table in Phase 2. The
  contract's tests compute WCAG contrast for every text/background and edge pair of the
  defaults in both schemes.
- One stylesheet, `@tula/react/styles.css`. Its token block is **generated** from the contract
  (`bun run --filter @tula/react generate`; `generate:check` runs in `verify`, and a test
  repeats the check). The rest is hand-written.
- An app sets public properties: `--tula-color-primary` (light), `--tula-dark-color-primary`
  (dark), `--tula-radius`, …. Rules read private ones, `--_tula-*`, which the token block
  resolves on each component root to the public property of the active scheme or the default.
  Two names per colour, rather than one name redefined in a media query, is what lets a theme
  be applied **inline** (the `appearance` prop) for both schemes without knowing which is
  active, and without a style tag or a CSS-in-JS runtime.
- Dark values never fall back to light ones: an app that only sets a light background must not
  get that background under dark text.
- `data-tula-theme="light|dark"` on a root or any ancestor forces a scheme.
- **Zero specificity.** Every selector is wrapped in `:where()` (a test enforces it), so an
  app's own rule always wins, whatever the load order. Cascade layers were the alternative;
  unlayered app CSS beats any layer too, but layers interact with an app's own layer order,
  and `:where()` has no such coupling.
- `appearance` = `{ theme, colorScheme, elements }` on the provider and on each component.
  `elements` adds class names to named parts; the names are a typed, stable list
  (`ELEMENT_NAMES`) and each part also carries `data-tula-element`.

### Localization

One typed table of every string (`TulaLocalization`, English defaults), overridable in part.
Server error messages stay in `@tula/core`'s table keyed by code; `localization.errors` is
handed to the client. One message is deliberately not the server's: a wrong *current* password
in the profile says so, because the API's message for `auth.invalid_credentials` is written for
sign-in ("email or password").

### Accessibility

Part of done, not a later pass: labelled forms; errors associated and announced; focus to the
new step's title on a step change and to the first invalid field on failure; the checklist's
state as text; pending buttons that keep their name and focus (`aria-disabled`); a menu-button
pattern for the user menu and a native modal dialog for the profile; 24 px targets; reduced
motion; contrast computed in tests. The title of a card takes focus but draws no ring: it is
not a control.

### Server rendering

Every export is a client component. Nothing touches `window` during render; a test renders
every component in a process with no DOM. `@tula/nextjs` (1.12) adds the server side.

### Dependencies and size

Peer: React 18.2+ or 19. Runtime: `@tula/core`, and `@tula/contract` for its Zod-free
`/theme` entry point (a direct dependency because it is imported directly; it adds nothing to
an install, core already depends on it). 13.3 kB gzip (21.2 kB with core, React excluded) plus
4.1 kB gzip of CSS; a test holds a budget and checks no schema library is bundled.

### Tests

- **Component tests** (`bun test`, happy-dom through a preload, Testing Library) drive the
  components against `@tula/core` with its own fake API: every step, every error path, focus,
  the unsupported state, hydration. Coverage threshold 90% per file (currently above 99%).
- **End-to-end** (`e2e/`, Playwright, Chromium): the example app `examples/react-vite`, built
  only from the components, against **the real API in process** (`createApp` on memory
  adapters, wall clock) with the sent emails readable by the tests. Scenarios: sign-up, sign
  out and in, wrong password, reset (old password refused), change password, two browsers and
  revoking one, sign out of all others, keyboard-only sign-up, and axe on every screen and
  state in light and dark with no rule disabled. `bun run e2e`; its own CI job; not in
  `verify`.
- **The fixture cannot reach production.** `e2e/server.ts` refuses to start without `E2E=1`,
  lives outside `apps/api` (the API image copies only `apps/api` and the packages it imports,
  and `.dockerignore` excludes `e2e/`), and nothing imports it. Its test routes
  (`/__test/outbox`, `/__test/reset-limits`) refuse any request that carries an `Origin`.

## Consequences

- Zero specificity cuts both ways: an app's broad rule (`button { … }`, `:focus-visible { … }`)
  restyles the components too. Documented; apps scope such rules.
- The flow hooks' `null`-plus-`error` convention differs from `@tula/core`, which throws.
- A flow cannot be resumed after a reload (core's decision); the components start again.
- Signing in costs two requests (start, then password) because the first screen is the email
  alone. That is what lets the server answer with the methods on offer before a password is
  asked for.
- The profile dialog relies on `<dialog>.showModal()` (all current browsers).
- `colorScheme: 'system'` follows the OS, not an app's own theme switch; an app with one sets
  `data-tula-theme` on its root element, as the example does.
- React 18 is supported by the peer range but the tests run on React 19 only.
- Playwright needs Node on the machine (its test runner does not run under Bun); `bun run e2e`
  starts it through `bunx`. Bun still runs the server under test.
