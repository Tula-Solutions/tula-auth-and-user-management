# ADR 0061 — Compose screens for sign-in, sign-up and password reset

- Status: accepted
- Ticket: TULA-50

## Context

The Kotlin client ([ADR 0054](0054-kotlin-client.md)) has no screen: an Android app that
wants a sign-in draws every step itself. The SwiftUI screens
([ADR 0057](0057-swiftui-screens.md)) settled what such screens are on a native platform: a
model that decides and views that draw, content as data, one table of strings, a theme value
that is checked before it is drawn, and tests of what the model decides that need no device.
This ADR is the same design on Android, and says where Android made it differ.

Scope, as for TULA-49: a sign-in with a password or an emailed code, a sign-up, the emailed
code that proves an address, a password reset and the replacement of an expired password. A
second step, passkeys, providers and the account's screens are not here.

## Decision

### Two modules: what decides is plain Kotlin, what draws is Compose

| Module | What | Where it is built |
| --- | --- | --- |
| `tula-auth-ui` | `TulaAuthModel`, `TulaAuthContent`, `TulaStrings`, the theme's grammar and conversion (`TulaThemeValues.kt`). Plain Kotlin on the JVM: no Compose, nothing of Android. | Everywhere, with `tula-auth`. Its tests run in CI's `kotlin` job. |
| `tula-auth-compose` | `TulaAuth`, the slots, `TulaComposeTheme`. An Android library on Compose's `ui` and `foundation`. | Only where an Android SDK is named. Compiled and linted in CI's `kotlin-android` job. |

A composable runs only when Compose draws it, and nothing in `verify` or in the `kotlin` job
draws. So every decision is in `tula-auth-ui`, where a JVM test reaches it: which screen is
open, what its fields hold, where a problem is said, where the focus is asked to go, what is
announced, what a field is read as. `tula-auth-compose` reads `model.state` and
`model.content` and calls `model.perform(action)`; a branch there that is more than "which
part is drawn for this state" belongs in the model.

Compose is `ui` and `foundation` only, with **no Material**: an app is not tied to a version
of a design library by a sign-in screen, and every colour and length is the theme's.

### The model is ADR 0057's, rule for rule

`TulaAuthModel` holds what `TulaAuthUI`'s model holds and decides as it does. The rules, each
with a test in `tula-auth-ui/src/test`:

- **A screen per step, and "not supported" for every other one** (`TulaAuthScreen`, made
  from the client's `FlowScreen` in one function). A step the client has a call for and these
  screens no form for is `NotSupported` too. Never blank, never an error, never a request on a
  guess.
- **What a screen offers is data** (`TulaAuthContent`: the title, the fields with what they
  ask of the keyboard, the main button, the links, each with its `TulaAuthAction` and its
  identifier), **and one door performs it** (`perform`), which does nothing for an action the
  open screen does not offer.
- **Nothing is emailed by arriving at a step that offers another way.** A code is asked for
  at once only where an emailed code is the step's one strategy.
- **A flow that is left is discarded, and a late answer changes nothing** (`close()`, a move
  to another flow, "Start again"; every action notes the model's generation). **The one
  answer that is not dropped is a completion**: the client is signed in, so the model shows
  `SignedIn` and calls `onSignedIn` once per completion, also after `close()`.
- **A flow that completed is signed in also when its session could not be stored**
  (`storage.failed`): `SignedIn`, with `strings.sessionNotSaved` shown and announced.
- **A closed screen is on the start of its own mode with nothing typed**, and no action is
  silent: one whose flow is gone opens the start with `strings.flowLost`.

**One departure from the Swift client, which is the Kotlin client's own**: the Kotlin client
has a call for a texted first-factor code (ADR 0054). These screens have no form for it, so a
step that offers only `sms_code` is `NotSupported` here although the client's own
`flow.screen` is not.

### Nothing secret outlives its screen

The session is the client's; the screens hold no token. `password`, `code` and `newPassword`
are emptied by every change of screen, by a completion and by `close()`. What is emptied **as
it is sent** is decided per secret, and is ADR 0057's table:

| Secret | Emptied as it is sent |
| --- | --- |
| A sign-in's password | Always, right or wrong. |
| A code that travels alone (a sign-in's, the one that proves an address) | Always, right or wrong. |
| A password that is being chosen (a sign-up's, a reset's, an expired password's replacement) | Only when it was taken. A refused one is kept, to be put right. |
| A reset's code | When the refusal is said at the code field; kept when the new password was what was refused. |

Whether a password is drawn in the clear is the model's too (`revealed`, `toggleReveal`),
emptied wherever the fields are.

What Android adds:

- **The model is held with a plain `remember`, never `rememberSaveable`**, and nothing of it
  goes into a `SavedStateHandle` or a `Bundle`: saved instance state is written to disk by the
  system. The cost is stated: **a configuration change the activity does not handle (a
  rotation, by default) makes a new model, and the flow that was open is discarded**, with
  what was typed. An app that wants a flow to outlive one either handles the change itself
  (the example declares `configChanges` for it) or holds a `TulaAuthModel` of its own where it
  survives (`TulaAuth(model = …)`), and then calls `close()` itself.
- `TulaAuthState` and `TulaAuthModel` print as their names. The state is a data class for
  its `copy` and its equality, with `toString()` overridden: a state in a log line or a crash
  report must not be a password.
- **`FLAG_SECURE` is the app's choice.** The library sets no window flag: a library that
  blanks every screenshot of an activity it is one part of decides something that is not its
  own. `docs/kotlin.md` says how an app sets it for the screens that take a password.
- The text a field holds is the model's, mirrored into Compose state for the text field and
  written back on every change; the mirror is of the composition and goes with it.

### Every string is in one Kotlin table, not in Android resources

`TulaStrings` is a class with a property per string and a table of error sentences by code;
its defaults are the English table, so `TulaStrings()` is English and an app names only what
it changes. A failed call is said as `errors[code]`, else the
contract's sentence for a code this version knows, else `unknownError`: **text a server wrote
is never drawn or announced**. A value is put into a `{placeholder}` once and never read
again.

Android's own answer is `strings.xml`. It was not taken, for three reasons. The table is used
by the model (what a field is read as, what is announced), and the model is in a module with
no Android, so that its tests run on the JVM: a resource cannot be read there. A resource
string is looked up by an integer through a `Context`, which the model would then have to be
handed. And the strings and the error codes are one table an app replaces in one place, as in
`@tula/react` and `TulaAuthUI`. **The cost: nothing follows the device's language by itself.**
An app that is translated builds a `TulaStrings` from its own resources (`stringResource`)
and passes it; `docs/kotlin.md` shows that.

### A theme value is checked by the contract's grammar, then turned into a number

A theme value is untrusted (a tenant's brand colour). It reaches a composable only as a
`TulaResolvedTheme`: first the contract's grammar (`TulaThemeGrammar`, the rules of
`isValidThemeValue`, never looser), then a conversion that **refuses what this version cannot
draw instead of guessing**. A refused value is the default's, and `refused` names the token,
never the value. Both schemes are resolved; `TulaComposeTheme` takes the one the system is in
(`isSystemInDarkTheme`).

The grammar is a hand-kept copy, as the Swift one is. What holds it to the contract is the
shared corpus, `packages/contract/src/theme-cases.json`: the Kotlin test reads the file and
asserts the contract's verdict for every row. A rule changed in
`packages/contract/src/theme.ts` is changed in `TulaThemeValues.kt` in the same change, with a
value in the corpus. The default theme resolves with nothing refused, and every text of it
has 4.5:1 on what it is drawn on in both schemes (computed from the resolved values).

### Three slots, and none can take a label away

`TulaAuthSlots` has `header`, `primaryButton` and `footer`, each a composable lambda with a
default in `TulaAuthDefaults`. A header is handed the title and the modifier that makes it a
heading and takes the focus; a button its words, whether it is pending and its `onClick`.
**Fields, links and problems are not slots**: a field's label, its error and what it is read
as are what the acceptance criteria are about, and a slot that replaces a field can drop all
three. SwiftUI's fourth slot (a field *style*, which is handed the field already labelled)
has no equivalent that keeps that guarantee in Compose's `BasicTextField` without a wider
API; a field slot is a decision of its own.

### Accessibility is in the model and the parts

- A visible label above every field, and the same words, and no others, as the field's
  content description.
- A problem in words ("Error: …") under its field, in a polite live region, and as the
  field's `error` semantics: said once where the field is read and announced once when it
  appears. It is not in the content description as well (the model's `spokenLabel`, which
  joins the two, is for a view with no `error` of its own and is not used here). How often
  TalkBack then says a problem was not listened to. A problem above the form is in an
  assertive live region.
- Every link and the button that shows a password is at least 48 dp in both directions, and
  the main button, the links and that button have an edge in the theme's focus colour while
  they have the focus (`focusEdge`); the main button, whose own colour the focus colour
  promises nothing against, has a second edge of the page's colour inside it. A slot that
  replaces the main button shows the focus itself. **Live regions, not
  `View.announceForAccessibility`**, which Android has deprecated.
- The title is a heading and the screen a pane with the title's words; on a change of screen
  the focus is asked to the title, on a failure to the first field with a problem
  (`focusRequests` in the state, applied in an effect).
- A password field is `KeyboardType.Password` with autocorrection off and is a password to
  the semantics tree unless shown; fields carry their autofill content type.
- Controls are at least 48 dp high, text wraps, sizes are in `sp`. State is never a colour
  alone.

### Tests, in three layers

1. **The model, on the JVM** (`tula-auth-ui/src/test`): the table of behaviours of
   `TulaAuthUITests`, against a scripted HTTP engine under the real client. Kover holds the
   module to 90% of lines, the bound of `tula-auth`, over all of its sources.
2. **Robolectric: not built.** It would draw the composables on the JVM without a device. It
   was left out because it would add a second copy of Android to the build for what the first
   and third layers already split between them; adding it is a decision.
3. **The screens on a device** (`examples/compose/src/androidTest`): Compose's instrumented
   tests drive the example app against the real API. A test on a device cannot start a
   process of the machine, so `native/android/fixture/ui-tests.ts` does: it starts
   `e2e/kotlin-fixture.ts`, forwards its port into the device with `adb reverse` and hands
   the address to the tests. **The fixture's guard and its bind address are unchanged**: it
   listens on 127.0.0.1, and inside the device the address is the same because the port is
   forwarded, not exposed. Every process the runner starts has a timeout, and what it started
   is ended in a `finally` and on `SIGHUP`, `SIGINT` and `SIGTERM`
   (`.claude/hooks/compose-ui-tests.test.ts` reads the source for that; it does not start
   the runner).

### The UI tests are run by hand, and CI compiles them

No workflow starts an emulator. CI's `kotlin-android` job compiles and lints
`tula-auth-compose`, the example and the example's UI tests; `.claude/hooks/ci.test.ts` holds
that, and that no job runs a test on a device. A hosted runner's emulator is slow and its
failures are hard to tell from a test's; adding the run is a decision for when somebody has
seen it pass there several times.

### The example is a module of the SDK's build, outside the workspace

`examples/compose` has no `package.json` and is excluded from the Docker build context. It is
a module of the Gradle build at `native/android` (the settings file names the directory), so
it has that build's wrapper and catalog and names no version of its own. **It holds no key**:
the API's address and the publishable key come from the launch intent's extras (a debuggable build only) or its setup
screen. Plain `http` is allowed to this machine only (`127.0.0.1`, `localhost` and the
emulator's name for its host, `10.0.2.2`), and its sealed tokens are out of Android's backups.

## Consequences

- An Android app gets a sign-in by adding one composable, and can replace its words, its
  colours and three of its parts.
- The Kotlin build gains Compose (1.11, the newest line that compiles against the API level
  the build pins) and, for the tests only, AndroidX Test.
- A rotation ends an open flow unless the app handles it. That is the price of keeping a
  typed password out of saved state.
- Two hand-kept copies of the theme's grammar now exist (Swift, Kotlin), each held to the
  contract by the same corpus.

## Not verified

`docs/plans/phase-2-unverified.md`, "Step 2.15, the Compose screens", says exactly what was
run and on what. In short: the UI tests passed on one emulator, once set up by hand, and on
nothing else. Nothing ran on a physical device, TalkBack was never turned on, no
accessibility checker was run, and the dark scheme and the "not supported" screen were not
drawn by any test (both are covered on the JVM, as values and as decisions).

## Not decided here

- A slot for a field.
- The second step, passkeys, providers, a texted code and the account's screens.
- Running the UI tests in a workflow.
- A Robolectric layer.
- Following the device's language without the app's help.
