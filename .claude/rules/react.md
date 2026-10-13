---
paths:
  - "packages/react/**"
  - "examples/react-vite/**"
---

# React SDK

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## React SDK (see ADR 0022)

- **Dialogs that must outlive a page belong to the provider.** The step-up dialog and the
  backup codes of an enrolment made inside a flow are drawn by `<TulaProvider>`
  (`components/prompts.tsx`), reached through `useTulaContext().prompts` and `useStepUp()`:
  an app unmounts `<SignIn>` the moment the client is signed in. An authenticator's setup
  key, its QR code and backup codes are held in state only while their screen is open. The
  QR encoder (`src/qr`) is the package's own and is loaded with `import()`; never add a QR
  dependency or import it statically.
- **Components render the server's step and nothing else.** A screen per `step.status`; a new
  sign-in method is a new screen and an entry in `FIRST_FACTOR_FORMS`
  (`packages/react/src/components/sign-in.tsx`). The default branch of every step `switch` is
  the "not supported" screen: never a blank card, never a guessed action.
- **Theme tokens live in `@tula/contract/theme`** (plain data, shared with Swift and Kotlin).
  The stylesheet's token block is generated from it; rules read the private `--_tula-*`
  properties only, never a literal colour. Every selector is wrapped in `:where()` so an app's
  CSS always wins. Tests enforce all three, and the contract's tests compute the default
  colours' contrast (4.5:1 text, 3:1 edges and focus) in both schemes.
- **Theme values are untrusted input** (a tenant's brand colour). `themeToCssVariables` drops
  any value `isValidThemeValue` refuses for its token's type; never write a theme value into a
  `style` attribute, a stylesheet or native UI by any other path, and never loosen the grammar
  to allow `url(`, `var(`, `;` or braces. A new token type gets a validator and tests.
- **A result belongs to the session it was asked for.** A hook or handler that awaits the API
  checks, before it sets state, that the session it started under is still the current one
  (see `use-session.ts`); state that is one user's (half-typed passwords, messages) is keyed
  by the session id.
- **Every user-visible string is in `localization.ts`**; server error messages come from
  `@tula/core`'s table by code. Strings are rendered as text, never as HTML.
- **A destination is only ever a prop** (`afterSignInUrl`, …), checked to be relative or
  `http(s)`. Nothing reads a URL from the address bar or the server. A relative destination
  means this origin: `safeUrl` refuses a value with no scheme that names a host (`//host`,
  `/\host`, a path that normalises to one).
- **A failed sign-out is not a sign-out.** `@tula/core` signs out locally and throws when the
  server could not be told, because the session (and a browser's cookie) may live on. The
  components sign out through `useTulaContext().signOut`, never `client.session.signOut()`
  with a swallowed error: it navigates only after a sign-out that went through, and otherwise
  the provider shows `SignOutFailedDialog` (an alert, "Try again"), which is the provider's
  because the component that asked is gone once the client is signed out.
- **A flow that is left is discarded.** `flow.discard()` (every flow has it) forgets the
  attempt's secret and drops the answer of an action still in flight, so a late `complete`
  signs nobody in; `use-flow.ts` calls it on `reset()` and when `adopt()` replaces a flow.
- **Nothing touches `window` or `document` during render**, and no token, code, password or
  attempt secret goes into storage, a URL, a DOM attribute or a log line. The one thing in web
  storage is `@tula/core`'s emailed-link binding (`tula.link.<attempt id>` in `localStorage`):
  it is not a token and authorizes nothing by itself; the components never touch it.
- **An effect that waits is restartable.** A wait started from an effect (`waitForEmailLink`)
  gets its own `AbortSignal` and is aborted in the cleanup; StrictMode, Fast Refresh and
  `<Activity>` clean up and set up again in one tick, and the second wait must not die with
  the first one's signal.
- **One WebAuthn request at a time, and never during render** ([ADR 0027](../../docs/adr/0027-passkeys.md)).
  Whether the browser can use a passkey is asked after mount (`usePasskeySupport`), and a
  passkey control is hidden, not broken, where it cannot: a method that is the user's only
  one says so in words. **Hidden until known**: a passkey button, and a passkey among a
  screen's other ways, is drawn only once `usePasskeySupport() === true`, on the first-factor,
  second-factor and step-up screens alike (`sign-in.tsx`, `mfa.tsx`, `prompts.tsx`). Because
  support is asked after mount, a browser that has WebAuthn draws the link one commit after
  the screen (a frame late; where it is the only other way the whole list arrives with it,
  after the title has taken the focus). That is accepted: the other choice draws, in a browser
  without WebAuthn, a control that is then taken away. Only the screen itself treats "not
  asked yet" as "not ruled out", so that a passkey-only step does not open on "not supported".
  `passkey.test.tsx` pins both halves; reading support during render instead is a design
  change, not a fix. The request that waits in the address field's autofill
  (`autocomplete="username webauthn"`, `withPasskey({ autofill: true })`) is an effect that
  waits: its own signal per run, aborted in the cleanup, and **aborted before any other
  ceremony starts** (`components/passkey.tsx` is the one place that starts one). It never sets
  a pending state: the form it sits behind must stay usable.
- **A dismissed passkey dialog is not an error, and not a success.** `passkey.cancelled` is
  said through the quiet `Status` in its neutral tone (`tone='neutral'`: the muted text
  colour, not the success one), never `role="alert"`, the button works again and takes the
  focus back, and the autofill request is started again after any try that did not sign in; every
  other failure is the message its code has. Nothing of a ceremony (options, the credential,
  the browser's own error text) is kept in state, rendered or logged.
- **A passkey sign-in is an attempt of its own.** Its flow reaches the screens through
  `adopt()`, which discards the attempt it replaces, and its completion is delivered even if
  the screen has gone meanwhile (the client is signed in before the flow comes back, and an
  app takes `<SignIn>` away at that moment). Because the flow hook is not pending meanwhile,
  the component takes `useCompletion`'s `hold` before its first await and releases it after
  its flow went through `finish`: while a hold is out, a signed-in client is never treated as
  "was already signed in". Never order these with a timer.
- **Accessibility is part of done**: labelled fields, errors associated and announced, focus
  moved on a step change and on failure, state as text and not only colour, keyboard operation
  of everything. axe runs on every screen in the browser tests with no rule disabled.

## Testing

- Component tests (`packages/react`) run in happy-dom through a preload
  (`src/testing/setup.ts`) with Testing Library, against `@tula/core`'s own fake API
  (`src/testing/harness.tsx`).
- **A component test's `user` never pauses between keys** (`world()` sets up user-event with
  `delay: null`; `src/testing/harness.test.tsx` holds it). user-event's default waits for a
  timer after every keystroke, and on a CI runner busy with the other packages' tests each of
  those waits took tens of milliseconds: a test that signs in types some fifty keys, and the
  first one of the run died at the five-second limit. Use `w.user`, never a
  `userEvent.setup()` of the test's own.
- **In a component test, wait for focus with `await expectFocus(element)` and for a dialog to
  close with `waitFor(() => expect(openDialogs()).toBe(0))`** (both in `harness.tsx`). Never
  `expect(element)` inside `waitFor`, and never a synchronous
  `expect(document.activeElement).toBe(element)`: focus moves in an effect, so the check races
  it, and a matcher that fails on a happy-dom element formats its whole window (a message of
  over 100 MB, which is what times CI out).
- **Assert that something is not on the page with `expectAbsent(screen.queryBy…(…))`**
  (`harness.tsx`), never `expect(screen.queryBy…(…)).toBeNull()`: that matcher fails exactly
  when it holds an element, and then formats the window (22 seconds and 290 MB on CI, for one
  button). `harness.test.tsx` fails for a test file of `packages/react` that does it inline;
  it does not see a result kept in a variable first (`const el = …; expect(el).toBeNull()`),
  which is the same mistake.
- **In `packages/react`, `findBy…`, `waitFor` and every `w.user` call return after the effects
  of the last commit, and after the renders and effects those asked for**
  (`src/testing/settle.ts`, installed by `setup.ts`). Nothing more: work React is given from
  a timer or a later task (a countdown's tick, an answer the fake API has not given yet) is
  not waited for, so wait for what it draws. Under `jest.useFakeTimers()` it waits for
  nothing (`setImmediate` is faked too); the check for that is the package's own
  (`Object.hasOwn(setTimeout, 'clock')`), because Testing Library's also wants a global
  `jest`, which Bun does not define. Testing Library alone returns after
  the commit and one zero-delay timer, and on a starved runner that timer beats React's next
  turn: a test then saw a control an effect was about to remove, and another typed into a
  field while the title's focus effect was still to come. Never configure another
  `asyncWrapper`, and keep the two `onAStarvedRunner` tests in `harness.test.tsx`: they fail
  every time without it. A control that must never be drawn is a different claim: test what
  was on the page when its effect ran (the `drawnWhenAsked` test in `passkey.test.tsx`).

## Components, styles and tests in detail

What the sections above do not say (moved from `sdk.md`).

- Runtime dependencies: `@tula/core` and the contract's Zod-free entry points. No CSS
  framework, icon library, CSS-in-JS runtime or router. React is a peer (18.2+ and 19).
- The "not supported" screen is `UnsupportedScreen`. A hook that reads the page's address
  does so through `@tula/core`, never `location` itself.
- One stylesheet, `src/styles.css`, with classes prefixed `tula-`; `package.test.tsx`
  enforces its rules. Every stylable part goes through `el('<name>')` with a name from
  `ELEMENT_NAMES` (class `tula-<kebab>` and `data-tula-element`). Adding a name is additive;
  removing or renaming one is breaking.
- Never copy a server's error message into the localization table.
- Render touches neither `Date.now()` nor storage either (`ssr-render.tsx` proves it in a
  process without a DOM). No `dangerouslySetInnerHTML`. No `console`.
- A destination is passed through `go()` / `safeUrl()`.
- `SignOutFailedDialog` belongs to the client whose sign-out failed: it is not drawn for
  another `client` the provider is given later, so its retry never reaches a different
  client. Never `client.session.signOut().catch(() => undefined)`.
- A provider dialog (`Modal` in `components/prompts.tsx`) gives the focus back to what had it
  when it opened; when that is gone or was the document (the "Sign out" item after the client
  signed out, a sign-in form after an enrolment) it goes to the first tabbable element of the
  page (`firstTabbable`), and stays put only when the page has none.
- Never share an in-flight request across sessions. Do not drop a flow object in an effect
  cleanup (`<Activity>` re-runs effects with state kept).
- Passwords and codes are component state only while the form is on screen; cleared on
  submit of a sign-in password and on completion.
- Accessibility, by component: a real `<form>` and a `<label>` per field (`TextField`),
  errors through `errors` (sets `aria-invalid`, `aria-describedby`, `role="alert"`), `Button`
  for anything that can be pending (`aria-disabled`, never `disabled`), focus on the title
  when a screen changes (`Card focusTitle`). Tab order follows the document: put a secondary
  action after the field it belongs to.
- Tests query by role and label. Coverage is per file (90%). A new screen or state gets, in
  `e2e/tests`, a scenario and an `expectAccessible` call in both colour schemes.
- **An expired password** (`needs_new_password` with `reason: 'expired'`, ADR 0041) is
  answered with `flow.submitNewPassword`; `<SignIn>` draws `ExpiredPasswordScreen` for that
  reason and the "not supported" screen for the step with no reason or one it does not
  know. Its history line is drawn for `max(history, 1)`: the expired password is refused
  whatever the policy remembers. Its words are
  `localization.expiredPassword`.
- **The texted sign-in code** (`sms_code`, ADR 0037): the first field takes a phone number
  only where the client configuration lists `smsCode` (then a text field with
  `autocomplete="username"`; an email field's own validation would refuse a number). A
  number is shown `sms_code` and nothing else (a password for a number signs nobody in), an
  address is never shown it. **Nothing is texted on arrival**: a message costs money, so the
  screen asks with a button. The words never claim a message was sent ("if you can sign in
  with this number…"), and `auth.invalid_credentials` on this screen is said about the code,
  not about a password.
- **A texted code as the second step** (`sms_code`, ADR 0025): the second-factor screen, the
  step-up dialog and the account page ask for the message with a button and draw the code
  field only after a send of that screen succeeded. **Nothing is texted on arrival**, also
  where it is the only option. `@tula/core` never asks by itself
  (`flow.prepareSecondFactor`, `session.prepareStepUp`, `mfa.startSms`). The account page
  offers it only where `Factors.sms.available`. `TextedCodeForm` (`components/mfa.tsx`) is
  the one form for all three. On a refusal an operator's setting causes (`SWITCHED_OFF`:
  `auth.method_disabled`, `sms.disabled`, `sms.country_not_allowed`) it shows the code's
  message and removes its own controls (send, field, resend): never leave a button that can
  only be refused again. `sms.unavailable` keeps the button.
- **A dormant texted code and a passkey:** `<UserProfile>` says a dormant texted code is "not
  asked for while … and … your second step again" (`mfa.smsNotInUse`), and `PasskeysSection`
  with `secondStep: 'texted_code'` writes `passkey.replacesTextedCode` above "Add a passkey"
  as the button's description, before any ceremony. **"Add a passkey" is unavailable until
  the two-step section has read the account's factors** (`secondStep: 'checking'`, said with
  `passkey.addChecking`), and stays so when that read failed (`'unchecked'`,
  `passkey.addUnchecked`, no retry control: the two-step section says its failed read the
  same way): focusable, `aria-disabled`, described by the reason. What was read belongs to
  the session it was read for. The two sections tell each other what changed through
  `UserProfileSections` (`onSecondStep`, `revision`), never through a second request of
  their own.
- **Passkeys:** the profile's "Add a passkey" is left out where the browser has no WebAuthn.
  The profile's section always loads the list: with the method off it shows what the user
  has (rename, remove) without "Add". Component tests fake `navigator.credentials` through
  the world's `passkeys` option; browser tests use a DevTools virtual authenticator
  (`addVirtualAuthenticator` in `e2e/tests/support.ts`), which answers a conditional request
  by itself unless told to wait (`setAnswering(false)`).
- **Two-step verification:** `needs_second_factor` and `needs_factor_enrolment` have screens
  (`components/mfa.tsx`); an option this version does not know is left out, never guessed. A
  test asserts nothing of the setup key, its QR code or backup codes is left in the DOM
  after their screen; completion of an in-flow enrolment waits for "I have saved these
  codes". Sensitive calls go through `useStepUp()`; no component decides which calls those
  are. The QR code stays a separate chunk (`import('../qr')`; a test holds both budgets), is
  drawn dark on white with a four-module quiet zone, and is decoded by `jsqr` in tests.
