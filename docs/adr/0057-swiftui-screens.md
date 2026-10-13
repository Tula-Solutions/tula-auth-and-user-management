# ADR 0057 — SwiftUI screens for sign-in, sign-up and password reset

- Status: accepted
- Date: 2026-10-12

## Context

The Swift client ([ADR 0051](0051-swift-client.md)) has no screen: an app draws its own from
the step the server returns. TULA-49 adds the screens for the flows a client with no sheet
can finish: sign-in with a password or an emailed code, sign-up, the emailed code that
proves an address, and a password reset. The second step, passkeys, providers, texted codes
and the account screens are TULA-60.

The rules were not open. `@tula/react` ([ADR 0022](0022-react-sdk.md)) already says what a
prebuilt screen is: it draws the server's step and nothing else, an unknown step is a "not
supported" screen, a theme value is untrusted, every string is in one table, a flow that is
left is discarded, and accessibility is part of done. What had to be decided is how those
rules are held in SwiftUI, how the contract's theme (CSS strings) becomes something a phone
draws, and how screens are tested where `verify` has no Swift toolchain and `swift test` has
no screen.

## Decision

### A second library of the same package, on SwiftUI and nothing else

`native/swift` gains the library `TulaAuthUI` (`Sources/TulaAuthUI`), which depends on
`TulaAuth`, SwiftUI and Foundation. No package is added. An app that draws its own screens
links `TulaAuth` alone and gets no SwiftUI code.

The public surface is one view, `TulaAuthView(client:mode:theme:strings:onSignedIn:)`, the
model it draws (`TulaAuthModel`), the table of strings (`TulaStrings`), the resolved theme
(`TulaResolvedTheme`) and four slot modifiers.

### The model decides, the views draw

`TulaAuthModel` is an `ObservableObject` on the main actor: it holds the flow, maps the
client's `FlowScreen` to a `TulaAuthScreen`, runs every action and says where the focus
goes. `Views/` holds SwiftUI code that reads the model and calls it, and no decision. The
split is what makes the logic testable with `swift test` on a Mac, where nothing is drawn,
and it is why the coverage threshold counts the model, the strings and the theme and not
`Views/` (below).

**What a screen holds is data, outside `Views/`** (`TulaAuthContent.swift`):
`TulaAuthContent(screen:strings:…)` is the title, what is under it, the address a sign-in
is for, the fields (each with its kind, label, hint and what the keyboard's "go" does), the
main button and the links, every one of them with the `TulaAuthAction` it performs and the
identifier it is found by. The model's `perform(_:)` is the one door every control goes
through, and it does nothing for an action the open screen does not offer. A field's
problems as they are drawn (`problems(of:)`), the form's (`formProblem`) and what VoiceOver
reads for a field (`spokenLabel(of:)`) are composed there too. `ContentTests` has a row for
every case of `TulaAuthScreen` (its `switch` has no `default`: a new case does not compile
without one) and asserts what is offered and what each offer does.

**What is left in `Views/`** is drawing: the column and its spacing, the theme's colours and
type on each part, the default look of a field, a button and a problem, the four slots, the
keyboard and autofill traits of each kind of field, the button that shows a password (its
state is the field's own), the spinner while an action is out, and the two focus bindings.
`body` iterates the content and calls `perform`; it has no `switch` over the screen.

`TulaAuthScreen` is a closed list: the three forms that start a flow, the password, the
offer of an emailed code, the code, the verification of an address, a reset's new password,
an expired password's replacement, `signedIn`, and `notSupported(status:)`. **Every step the
client reports as `FlowScreen.notSupported`, and every known step this target has no form
for (a second factor, a factor enrolment), is `notSupported`**: a title, a sentence and a
"Start again" button that discards the attempt. Never a blank screen, never a request on a
guess. A screen added by TULA-60 widens the list and the model's mapping in the same
change, with a row in `ModelTests`.

The screens follow the server as `@tula/react`'s do: a sign-in whose step offers both a
password and an emailed code opens on the password with the code as the other way, and
nothing is emailed by arriving there; where a code is the only way it is asked for at once.

### Nothing secret outlives its screen

- The model holds no token. The session is the client's.
- A password or a code is in the model's field state only while its screen is open: every
  one is emptied on every change of screen and by `close()`. What happens to it when it is
  sent differs by what it is, and each row has a test against a transport that refuses
  (`LeftAndRefusedTests`):

  | Field | When it is sent |
  | --- | --- |
  | The password of a sign-in | Emptied as it is sent, right or wrong: a password that was refused is typed again, not edited. |
  | A code that travels alone (the code that signs in, the code that proves an address) | Emptied as it is sent, right or wrong: a refused code is read from the email again. |
  | A password that is being chosen (a sign-up's, a reset's, an expired password's replacement) | Kept when the server refuses it, so that it can be put right against the message under it ("too short"); emptied when the screen changes. |
  | A reset's code, sent with the new password | Emptied when the refusal is said at the code field; kept when what was refused is the password, so that the same code goes with the corrected one. |

  The address is kept across screens of one visit (a sign-in's address is carried to a
  reset) and emptied by `close()`.
- `TulaAuthView` calls `close()` when it disappears, which is also when another screen is
  pushed over it or another tab is chosen: the flow is discarded (`flow.discard()`, which
  forgets the attempt's secret and drops an answer in flight), every field is emptied, the
  address included, and **the model is back on the start screen of the mode it was made
  for** (also from a reset reached from a sign-in). A view that comes back keeps its model,
  and a model left on a step with no flow would draw buttons that can do nothing.
- **No button is silent.** An action of the open screen does what it says, marks what is
  missing, says what went wrong or, where its flow is gone, opens the start of the flow
  with `flowLost` ("That attempt is no longer open. Start again."), shown and announced.
  Nothing in the model leaves a step open without its flow, so the last is a defence and
  not a path; a test reaches it by calling the internal `leave()` alone.
- **A result belongs to the visit it was asked for.** Every action captures the model's
  generation before it awaits and drops its answer when the generation has moved (a change
  of flow, a `close()`): a late error is shown to nobody, and an attempt that had not
  completed signs nobody in on a screen that has gone.
- **A sign-in that had completed when its screen was left is said, not dropped.** The
  client records a step and checks "discarded" in one step under one lock
  (`FlowAttemptState.accept`, as `@tula/core`'s flow does in one turn), and stores the
  session after it: a flow left while its session is being stored has completed, and
  `discard()` does nothing to a completed flow. The client is signed in then, whatever the
  screen shows, so the model shows `signedIn` and calls `onSignedIn` once, under the newer
  generation too. Before this the check and the recording were two steps with the session's
  storing between them, and a view closed in that window was left drawing a form to a
  signed-in user, with the app told nothing. Tests hold the window open with a storage that
  waits (`FlowTests`, `LeftAndRefusedTests`, `ContentTests`).
- The model is `TulaRedacted`: `print`, `String(reflecting:)` and `dump` show its type's
  name. It logs nothing, and no error it shows holds what was typed.

### Every string is in one table, and a server's error is its code

`TulaStrings` is a struct of plain properties with English defaults; an app changes the
ones it wants and hands the table to the view. A value in `{braces}` is filled in once and
never read again (`TulaStrings.format`), and every string is drawn as text: nothing is
parsed as Markdown, HTML or a link.

A failed call is shown by its code: `errors[code]` when the app's table has one, otherwise
the contract's English sentence for a code this version knows (`TulaErrorDefinitions`, the
generated table, and the client's own codes), otherwise `unknownError`. **Text a server
wrote is never put on a screen**: for a code this version does not know `TulaError.message`
is the server's `detail`, and the table refuses it. A canary test holds that for the form
error, a field's errors and what is announced.

A field error goes under its field when the server names one of the screen's fields
(`place`), and to the form otherwise. `rate_limited` with a wait says the wait in words.

### A theme value is checked by the contract's grammar, then turned into a number

The generated `TulaTheme` holds the contract's strings (`"#5b4cf0"`, `"0.9375rem"`, a font
stack). A value may come from data a tenant edits, so it is untrusted, and it reaches a view
in two steps that both refuse rather than guess:

1. `TulaThemeGrammar.isValid(type, value)` is `isValidThemeValue` of
   `packages/contract/src/theme.ts`, rule for rule: the forbidden characters and words
   (`;`, braces, `<`, `>`, a backslash, `@`, `!`, a line break, `/*`, `url(`,
   `expression(`, `var(`), the length cap, and the grammar of each type. It is never looser
   and is stricter in one place: a value with anything outside ASCII is refused.
2. A value the grammar accepts is turned into what the system draws with, and **what this
   version cannot turn into one is refused as well**:

   | Type | Drawn | Refused although the grammar accepts it |
   | --- | --- | --- |
   | colour | `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`; `rgb()`, `rgba()`; `hsl()`, `hsla()`; `transparent`, `black`, `white`: as sRGB channels and an opacity | `hwb()`, `lab()`, `lch()`, `oklab()`, `oklch()`, every other colour keyword (the system has no table of CSS names, and a guess draws a brand in the wrong colour) |
   | length | `0`, `px` and `pt` as one point each, `rem` and `em` as 16 points each | `%`, `ch`, `ex`, `vw`, `vh`, `vmin`, `vmax` (a share of something a native screen does not have); a negative length; one over 200 points; a text size under 11 points |
   | font family | the first family of the list: a generic name (`system-ui`, `sans-serif`, `ui-monospace`, …) is the system's typeface, any other is asked for by name, and one the device lacks is drawn in the system's | |
   | shadow | checked and not drawn: a phone's screens have no card to cast one | |

A refused value is replaced by the default theme's value for the same token, and the
token's key (`light.primary`, `radius`: never the value) is listed in
`TulaResolvedTheme.refused`. Nothing an app or a tenant wrote reaches a view any other way:
the views read `TulaResolvedTheme` and never a string of the theme. Text sizes are the
theme's points scaled by Dynamic Type (`ScaledMetric`).

The default theme resolves with nothing refused, in both schemes; a test holds that, so a
default the contract gains that this target cannot draw fails there instead of drawing the
fallback silently. `ThemeGrammarTests` has the hostile table (the forbidden forms, the
length cap, non-ASCII white space) and the conversions.

**The grammar is a second copy of the contract's, in Swift, kept equal by hand, and held
to one table of cases.** Nothing generated carries the rules. A rule changed in `theme.ts`
is changed in `TulaThemeValues.swift` in the same change. `packages/contract/src/theme-cases.json`
is a fixed corpus of values of every type with the contract's verdict for each; the
contract's test holds `isValidThemeValue` to it and
`testTheGrammarGivesTheContractsVerdictForEveryValueOfTheSharedCorpus` holds the Swift
grammar to the same file. The corpus is ASCII, where the two are meant to be equal, and it
is some seventy values: it catches a rule that moved in one copy, not every string the two
could differ on.

White space is ASCII's six characters in both: a space, a tab, a line feed, a vertical tab
(U+000B), a form feed and a carriage return. Three of them are among the forbidden
characters and refuse a value wherever they stand. **A vertical tab is not among them, in
either copy**: around a value it is trimmed, as a space is (JavaScript's `trim()` takes
it), and between the parts of a shadow it separates; inside a colour, a length or a font
family it matches nothing and the value is refused. The corpus has a row of each.

### Slots are four, and none can take a label away

| Modifier | Replaces | What it is given |
| --- | --- | --- |
| `.tulaAuthHeader { context in … }` | What is above the title (by default the app's initial on the brand colour) | The screen and the app's name |
| `.tulaAuthFooter { … }` | The last line ("Secured by Tula") | |
| `.tulaAuthPrimaryButtonStyle(_:)` | The main button's look | A SwiftUI `ButtonStyle` configuration; the label already says, in words, when the action is being sent |
| `.tulaAuthFieldStyle(_:)` | How a field is drawn | `TulaAuthFieldConfiguration`: the label, the input, the hint, the problems, whether it has the focus |

A field style is handed the text field itself, already labelled for VoiceOver (with its
problems), bound to the focus and identified: a style places it and draws around it. It
cannot remove the label or the association of a problem with its field. It can leave the
problems undrawn, which the protocol's documentation says it must not. A slot reads the
resolved theme from the environment (`tulaAuthAppearance`).

The title, the messages and the order of a form are not slots. An app that needs more
draws its own screens on `TulaAuthModel`, or on the client.

### Accessibility is in the model and the parts

- Every field is the system's `TextField` or `SecureField` with an accessibility label; the
  visible label above it is hidden from VoiceOver so that it is not read twice.
- A field's problems are part of what the field is read as (`fieldInvalid`: "Password,
  invalid: …"), are drawn under it in words that start with "Error:" beside a mark, and are
  announced when they arrive. A problem is never a colour alone.
- On a change of screen the model asks for the focus on the title, and on a failure on the
  first field with a problem (`TulaAuthFocus`); the view moves the keyboard's focus
  (`FocusState`) and VoiceOver's (`AccessibilityFocusState`) there. A status ("A new code
  is on its way.") and a form error are announced.
- The main button says "Loading…" as its value while its action is out, and is unavailable.
- Every control is at least 44 points high, text is never truncated (it wraps), and sizes
  follow Dynamic Type.
- The default colours are the contract's, whose tests hold their contrast (4.5:1 for text,
  3:1 for edges and focus) in both schemes. `ThemeContrastTests` computes the same from
  the resolved values the screens draw with, for every text on the surface it is drawn on.
- A drag down puts the keyboard away (`scrollDismissesKeyboard(.interactively)`): a number
  pad has no key that does, and a screen's last lines are under it.

### Tests, in three layers

1. **Logic, with `swift test`** (`Tests/TulaAuthUITests`): the real client on a transport
   that is a table of answers, with its tokens in memory. Every screen's mapping, every
   action, what is emptied when, the generation guard, where a field error goes, what is
   announced, the strings' rules and the theme's grammar and conversions. No view is made.
2. **The screens on a simulator, against the real API** (`examples/swiftui/TulaExampleUITests`,
   XCUITest): the example app is launched pointed at `native/swift/fixture/server.ts`, the
   fixture the Swift journeys use, started by `native/swift/fixture/ui-tests.ts`, which
   picks a simulator, runs `xcodebuild test` with a timeout and ends the fixture. Each test
   has an API of its own (`POST /__test/servers`), reads the emails the server sent, and
   runs the system's accessibility audit (`performAccessibilityAudit`) on the screens it
   reaches, in the light scheme and, in one test, the dark one. This is the native UI test
   seam: TULA-60's screens add tests there.
3. **What `verify` holds**: nothing of the screens runs there. `test:harness` tests the two
   scripts' own logic: which simulator is picked, the `xcodebuild` arguments, what the
   coverage check counts, how the fixture's first line is read (`readyPort`: whole however
   the pipe cuts it, within a deadline, the rest read and dropped), and, from the runner's
   source, that each of its three `Bun.spawn` and `Bun.spawnSync` calls names a timeout
   constant among its arguments and that the fixture is ended in a `finally` and on
   `SIGINT` and `SIGTERM`. That last pair is a reading of the text, not a run: no test
   starts the runner.

The seam is synchronous on purpose. An `async` `setUp` or `tearDown` on a main-actor
`XCTestCase` ended the test runner in `swift_task_dealloc` on Xcode 16.4, so set-up,
tear-down and the tests are plain throwing methods, and the few calls to the client and the
fixture are awaited through a helper that blocks the test's thread on a semaphore.

**A screen is audited with the keyboard away.** The audit measures an element from the
pixels at its frame, and while the keyboard is up a screen's last lines are under it: the
contrast "of the last line" and of "Forgot password?" on the password screen was the
keyboard's (their frames began at 572 and 504 points with the keyboard's top at 561, and
the line above it; no screen without a keyboard reported either). The seam drags the
keyboard away before every audit and fails when it does not go. **No contrast finding is
left out**, in either scheme.

**The audit has one exclusion, for one element**, written where the audit is called with
the reason: "text clipped" on the address field while it holds an address (25 characters,
drawn whole in a field 321 points wide; seen on the reset's start and the sign-up's with
the address carried over). Text clipped in any other field, in the address field while it
is empty, or in a label, a button or a message fails the test. It is an exclusion of the audit's finding, not a proof
that the finding is wrong: `docs/plans/phase-2-unverified.md` says so.

**The audit is not VoiceOver.** It is what axe is to the browser tests: a set of checks on
what the system's accessibility tree says. No test turns VoiceOver on, and where the
VoiceOver focus lands is asserted on the model, not on a device.

### Coverage counts what decides

`native/swift/fixture/coverage.ts` holds two modules, each alone to the unchanged threshold
(90% of lines, 85% of functions): `TulaAuth`, and `TulaAuthUI` as the files directly in
`Sources/TulaAuthUI`. `Views/` is left out, as `Generated/` is, for a stated reason: a
SwiftUI `body` runs when SwiftUI draws it, `swift test` on a Mac draws nothing, and the
simulator run reports no coverage here. Counting the views would either fail for lines no
test of that kind can run or be met by lowering the threshold. The rule that keeps the
exclusion honest is the split above: a decision in a view is a bug of the design, and
belongs in the model, where it is counted.

### The UI tests are run by hand, and the `Swift` workflow is not given a job for them

`swift test` in the `Swift` workflow now also builds `TulaAuthUI` and runs its logic tests,
and the coverage step holds both modules. The simulator run is **not** a job: it has been
run on one Mac, with one Xcode and one simulator runtime, and nobody has run it on a
GitHub runner (which simulator runtimes the image has, how long a cold build takes there,
whether the accessibility audit answers the same). A job that was never seen to pass is a
job that fails for reasons unrelated to a change, on every pull request that touches the
package. It becomes a job when someone has run it there; the script is what that job would
call. Until then a change to `Sources/TulaAuthUI` or `examples/swiftui` is run by hand and
`docs/plans/phase-2-unverified.md` records the run.

### The example is an Xcode project outside the workspace

`examples/swiftui` is an iOS app (`TulaExample.xcodeproj`, written by hand; the app's
deployment target is iOS 16, the package's floor, and its UI tests' is iOS 17, which the
accessibility audit needs) whose
sign-in, sign-up and reset are `TulaAuthView`, with a screen for where the API is and one
for who is signed in. It is not a workspace package, has no `package.json`, and
`.dockerignore` excludes it. It holds no key: the API's address and the publishable key
come from the scheme's environment variables (which is how the UI tests point it at the
fixture) or from its setup screen.

## What the design shows, and where this departs from it

`docs/design/Design.pdf` (page 3, the iOS sign-in) shows a centred brand tile, a title and
a subtitle, provider and passkey buttons, a filled field with its placeholder as its only
label, a full-width primary button, "New here? Create an account" and "Secured by Tula".

Followed: the centred column, the brand tile (the app's initial on the brand colour, once
the name is known), the title and subtitle, the full-width primary button, the two
sentences at the bottom.

Departed from, each on purpose:

- **A label above every field, and an edge around it.** The design's field is a filled box
  whose placeholder is its label. A placeholder disappears when typing starts and the
  field's fill against the background is under 3:1; the label above and the edge are what
  the accessibility criterion of the ticket asks for, and what `@tula/react` draws.
- **No provider and no passkey button.** They are TULA-60; a step that offers only those is
  the "not supported" screen until then.
- **No card and no shadow.** The design's web screens sit on a card; a phone's screen is the
  surface. The theme's `shadow` is checked and not drawn.
- **No name fields at sign-up.** The sign-up asks for what the server needs, an address and
  a password.
- **No live password checklist.** The client-side policy evaluator is not ported (ADR 0051,
  "Not decided here"); the server's field errors are shown under the field.

## Consequences

- An app gets sign-in, sign-up and reset with one view, and the rules of `@tula/react`'s
  components on iOS.
- There are now two implementations of the theme grammar and two tables of strings (React's
  `localization.ts` and `TulaStrings`), kept equal by hand.
- A flow that reaches a second step, a passkey, a provider or a texted code ends on "not
  supported" in these screens, although the client itself can take the first three: the
  screens are behind the client until TULA-60.
- The simulator tests need Xcode, a simulator runtime, `bun` and an installed workspace,
  and take about four minutes after the build. They are not in CI.

## Not verified

`docs/plans/phase-2-unverified.md`, "Step 2.14, the SwiftUI screens", has what was run,
with which Xcode, simulator and iOS version, and what was not. In short: the screens ran on
one iPhone simulator; **no device was used, VoiceOver was never turned on, and nothing was
run on a GitHub runner**. Dynamic Type at its largest sizes, a right-to-left language, an
iPad, a keyboard and Switch Control were not tried.

## Not decided here

The screens of TULA-60. A translated table shipped with the package (there is the English
one). The client-side password checklist. Publishing the package.
