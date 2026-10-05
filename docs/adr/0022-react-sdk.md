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

A flow hook keeps its flow object for exactly as long as it keeps the step: an effect cleanup
does not drop it. A cleanup is not proof of an unmount (React's `<Activity mode="hidden">`
tears effects down and keeps state), and dropping the flow there left a screen whose next
action could only answer `flow.invalid_step`.

Results are tied to the session they were asked for. `useSession` shares one in-flight list
request per session id and drops a result whose session is no longer the current one, so a
sign-out, or another user signing in, while a request is pending never shows the earlier
user's devices; `<UserProfile>`'s password and device sections are keyed by the session id;
and `@tula/core`'s `user.get()` installs the user only into the session that asked.

A failed sign-out is not a sign-out. `@tula/core` forgets the session locally first and then
throws when the server could not be told, because the server may still hold the session and
the browser its cookie (behind `@tula/nextjs` the cookies are cleared only on an answered
sign-out, so the next page load would be signed in again). `<UserButton>` and `<UserProfile>`
therefore sign out through the provider (`useTulaContext().signOut`): it navigates to the
after-sign-out URL only after a sign-out that went through, and otherwise shows a dialog of
its own (`SignOutFailedDialog`, an alert, with "Try again" and "Close"). The dialog is the
provider's because the client is signed out by then and the component that asked is usually
no longer on the page. `@tula/core` was left as it is: keeping the local session on a failed
call would break "a signed-out client stays signed out" and the other tabs' notification.
`useAuth().signOut` keeps throwing to its caller and does not navigate.

A relative destination means this origin. `safeUrl` refuses a value with no scheme that names
a host (`//host`, `/\host`, a path that normalises to one): another site is written out with
its scheme.

Completion (`onComplete`, or the after-URL) is reported from the action's result, not from an
effect: an app that wraps `<SignIn>` in `<SignedOut>` unmounts it the moment the client is
signed in, before an effect for the completed step could run.

### Two-step verification ([ADR 0025](0025-mfa.md))

- `needs_second_factor` and `needs_factor_enrolment` are two more screens of `<SignIn>` (also
  after a reset) and `<SignUp>`: the authenticator code with "Use a backup code", and the
  enrolment (QR code, the setup key as selectable text in groups of four, the code). An option
  this version does not know (`passkey`) is left out; with none left the step is "not
  supported", as before.
- **The provider owns two dialogs** (`components/prompts.tsx`, native `<dialog>` opened with
  `showModal`): the step-up dialog and the backup codes shown after an enrolment inside a
  flow. They live in the provider and not in the component that asked, because confirming an
  enrolment signs the client in, an app that wraps `<SignIn>` in `<SignedOut>` unmounts it at
  that moment, and the codes are shown once. `onComplete` (or the after-URL) waits until the
  user ticks "I have saved these codes"; Escape does not dismiss that dialog.
- **Step-up is a hook, `useStepUp()`**: `withStepUp(action)` runs the action and, only when
  the API answers `auth.step_up_required`, opens the dialog with the methods the server named,
  sends the proof and runs the action once more. A cancelled dialog rethrows the original
  error. No component knows which actions are sensitive; `<UserProfile>` wraps its MFA calls
  and the password change in it.
- `<UserProfile>` gains a "Two-step verification" section (turn on, backup codes with copy,
  download and the explicit confirmation, new codes, turn off; hidden where the environment's
  policy is `off` and nothing is enrolled, and without "Turn off" where it is `required`).
- **The QR code is drawn by the package's own encoder** (`src/qr`: byte mode, level M,
  versions 1 to 40, Reed-Solomon, all eight masks), as inline SVG with `role="img"`, an
  accessible name and the setup key as its text alternative, always dark on white with the
  four-module quiet zone. A dependency was not an option (runtime dependencies are `@tula/core`
  and the contract only). Its tests decode every version, and the SVG a component renders,
  with a real decoder (`jsqr`, a dev dependency). It is loaded with `import('../qr')` when an
  enrolment is first drawn, so it is a separate chunk (2.1 kB gzip).
- The secret and the codes live in component (or provider) state only while their screen is
  shown; tests and the browser suite assert that nothing of them is left in the DOM, web
  storage or the address afterwards.

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
- **Theme values are untrusted.** A brand colour can come from a database a tenant edits, and
  under server rendering an inline theme is text in a `style` attribute, where
  `red; background:url(…)` would be a second declaration. `themeToCssVariables` therefore
  validates every value against a strict grammar for its token's type (`isValidThemeValue`:
  hex / `rgb()`-style functions / keywords; number + unit; a list of font names; shadow layers
  of lengths and one colour) and **drops** what does not match rather than escaping it. No
  value may contain `;` `{` `}` `<` `>` `\` `@` `!`, a line break, `/*`, `url(`,
  `expression(` or `var(`. The check lives in the contract so every SDK shares it; every
  default value is tested against its own validator. The price: no gradients, `calc()` or
  `var()` through `appearance`; those belong in the app's own stylesheet.
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
an install, core already depends on it). With two-step verification: 32.7 kB gzip with core
(React excluded) in the entry, 2.1 kB for the lazily loaded QR encoder, plus about 5 kB gzip
of CSS; a test holds the budgets (35 kB, 3 kB and 6 kB) and checks no schema library is
bundled. The build splits chunks (`splitting: true`) so the encoder stays out of the entry.

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
  (`/__test/outbox`, `/__test/reset-limits`) are for the test process only (`e2e/guard.ts`,
  tested with the harness tests): they refuse a request that carries an `Origin`, one whose
  `Host` is not exactly the loopback `host:port` the fixture bound to (a DNS-rebinding page
  sends no `Origin` on a same-origin GET, but its `Host` names the attacker's domain), and
  one whose `Sec-Fetch-Site` is anything but absent, `none` or `same-origin`.
- **The API image contains no browser package.** The Dockerfile does not copy the manifests of
  `packages/react` or `examples/*`: with them present, `bun install --production` installed
  their dependencies and peers, React included. A harness test holds that.

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
