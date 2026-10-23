---
paths:
  - "native/swift/**"
  - "examples/swiftui/**"
  - ".claude/hooks/swift-journeys.test.ts"
---

# Swift SDK and SwiftUI screens

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## Swift SDK (`native/swift`, see ADR 0051)

The hand-written client beside the generated types: flows, the session, passkeys,
providers, a device key, the second step and step-up (TULA-37, TULA-56), texted codes and
a phone number on the account (TULA-60), no screen. The SwiftUI screens are a second
library of the package ("SwiftUI screens" below: TULA-49, and TULA-60 for the rest).

- **It behaves as `@tula-tech/core` does, and a rule changed in one is changed in the other.**
  One refresh at a time; a refresh the server refuses for the session (`session.*`,
  `auth.unauthenticated`, `auth.user_banned`) ends it once and anything else keeps it; a
  refresh that got no answer is repeated once, at once, inside the single flight, and an
  HTTP answer of any status never; a result of an older generation is never installed.
  `TulaSession.refreshTimeout` (8 s) stays below `MIN_REUSE_GRACE_PERIOD` and equal to
  `@tula-tech/core`'s `REFRESH_TIMEOUT_MS`: a unit test holds the constants.
- **A deadline never rests on the transport honouring cancellation** (`Race` in
  `TulaHTTP.swift`: the request and a timer race). Keep the test with a transport that
  ignores `Task.cancel`.
- **The refresh token is in the client's `TulaTokenStorage` and nowhere else**: the
  Keychain by default, as an item that is never synchronizable, in one of two classes that
  never leave the device (`KeychainAccessibility`, a closed pair). Never user defaults, a
  file, a cache in the adapter, a log line, an error or a URL. The access token is in
  memory only.
- **A storage that fails is not "signed out".** `KeychainTokenStorage` throws for every
  answer but "found" and "no such item", never `nil`; the session reports `storage.failed`
  and keeps what it had (`load()` leaves the state `loading`). Keep the tests of each.
  **"The session is kept" is true of the running app only**: after a refused write the
  Keychain holds a token the server has replaced, the write is not tried again until the
  next refresh that succeeds, and an app ended then and started past the grace window is
  signed out by the server. Say so wherever `storage.failed` is documented. `signOut()`
  removes the stored token also when it could not read it.
- **No test asks a real Keychain**, and no doc says the adapter works against one: its
  logic is tested on a fake of the internal `KeychainItems`.
- **A failed sign-out is not a sign-out.** `signOut()` throws when the server could not be
  told; the token it could not revoke is kept in memory (never in storage) for the next
  `signOut()` and for nothing else.
- **A step this version has no call for is `FlowScreen.notSupported`**: an unknown status,
  a known one with no action here, an unknown `reason`, a step that offers only ways the
  client cannot take (an emailed link alone; a passkey alone on a client with no sheet). Never an error, never a request on a guess. A new action widens
  `FlowScreen` in the same change, with a row in `FlowTests`.
- **A first factor is a call of its own, not a strategy parameter** (`prepareEmailCode`,
  `attemptEmailCode`; `prepareSmsCode`, `attemptSmsCode`): nothing can be asked for that
  this version cannot prove. There is no call that asks for an emailed link (its binding
  would have to outlive the app: ADR 0051, "Not built"). **Nothing is texted by arriving
  at a step or a screen**: a texted code, as a first factor, a second factor
  (`prepareSmsSecondFactor`), a step-up (`stepUp.sendSmsCode`) or an enrolment
  (`factors.startSms`), is asked for by a call of its own.
- **Every flow call after the start sends the attempt's secret**, one action runs at a
  time (`flow.busy`), and `discard()` forgets the secret and drops the answer of an action
  in flight. **A flow that had already completed is not discarded, and its completion is
  reported** (as in `@tula-tech/core`): `discard()` does nothing to it, and the action that
  completed it returns `complete`, or throws `storage.failed` with the client signed in.
- **The client logs nothing, and `TulaError` holds no underlying error**: it prints its
  code and status only. A generated type prints what it holds (ADR 0050): never
  interpolate, log or put one in an error. Every `TulaConfigurationError` is a fixed
  sentence that repeats nothing it was given (a canary test holds it).
- **The client kind is `ios`, written in one place, and is not an option**; the key is a
  publishable key or the client is not made. No redirect is followed, the `URLSession`
  keeps no cookie, cache or credential, and a path parameter that is not one segment is
  refused before any request.
- **No third-party dependency**: Foundation, Security, CryptoKit and AuthenticationServices,
  which are the system's. Google's ID token comes from the app; never add Google's SDK or
  any other package.
- **The system is behind four protocols, and all four are `nil` unless the app passes
  one** (`TulaPasskeySheet`, `TulaAppleSheet`, `TulaBrowserSession`,
  `TulaDeviceKeyStore`). Never give one a default that touches the system: a test that
  forgot an argument would show a sheet, and every session of an app that never asked
  would be bound. `TulaSystemSheets.swift` is the one file that imports
  AuthenticationServices. **No test shows a sheet, opens a browser or asks a real
  Keychain or Secure Enclave**: the adapters' tests build the framework's requests and
  read them, and stand in for the one step that shows something (`Perform`, `SheetRun`,
  `Launch`). Those seams are internal; never make one public.
- **A dismissed sheet and a closed browser are values, never an error and never a
  sign-in**: `TulaCeremony.dismissed`, `ProviderOutcome.cancelled`. A sheet's failure is
  one of the four words of `TulaSheetError`, read from the framework's error by domain
  and code: **a framework's own error text is never kept**, in an error, a log or state.
  Nothing of a ceremony (options, a credential, an ID token, a ticket's binding) outlives
  its call, except a provider's binding and a ticket whose exchange got no answer, in
  memory, for at most a minute.
- **One sheet at a time for a whole client** (`CeremonyGate`): a second is `flow.busy`
  before any request, never joined and never queued; the place is given back when the
  sheet answered or after `sheetCeiling` (300 s, a challenge's lifetime), and a later
  answer is dropped.
- **What the browser returns is read only when it is the redirect URL that was asked for,
  character for character, followed by `#`.** Never normalise either side, never judge the
  redirect URL in the client (the server's `request.redirect_not_allowed` is thrown as it
  is), and an error code in the returned address is passed on only when the contract
  defines it. A new refused form gets a row in `ProviderTests`. **A held ticket is
  forgotten only on an answer about it** (and after a minute, at a sign-out, by a new
  round trip): a client error raised before it was presented keeps it
  (`ProviderRoundTrip.retryable`). `SystemBrowserSession` refuses an `https` redirect URL
  the system could never return to (a port, user information, a query, a fragment, a host
  ending in a full stop) before anything is opened.
- **For Apple the Swift client takes the hash of the nonce** (`appleNonce`, the lowercase
  hexadecimal SHA-256), because it is what calls the sheet; `@tula-tech/core` and `@tula-tech/expo`
  do not hash. Never send Apple's sheet the raw nonce, and never hash for Google.
- **Proofs are made in the transport, for the six starts and the refresh** (`proven` in
  `TulaHTTP.swift`), the nonce is kept in memory, and a request is repeated once after
  `device.nonce_required`, inside the same call and deadline. **A `device.*` answer never
  ends the session, with one exception**: a refresh refused `device.proof_invalid` while
  the key store says the key is gone (`existing()` answered `nil`) ends it locally and
  tells the server. A store that throws is `device.key_failed` and keeps the session:
  `TulaDeviceKeyStore.existing()` answers `nil` only when it knows, and throws when it
  cannot tell. Keep the tests of all four outcomes (`DeviceKeyTests`, the device
  journeys). Sign-out sends no proof. **The store is asked twice before a session is
  ended** (`DeviceProofs.verdict`): only two looks that both say "no key" are `gone`; a
  second look that finds the key or throws keeps the session (`device.key_failed`). Never
  end a session on one look, and never word the two looks as closing the case: they
  narrow it.
- **Everything a call waits for outside the client is inside its deadline**
  (`ApiTransport.within`): the request, the look for the device key, the signing of each
  proof, the looks after a refused proof. A key store that never answers is
  `network.timeout` (as in `@tula-tech/core`), nothing sent, the session kept. **The store is
  asked one thing at a time** (`DeviceProofs.existing` and `create`, each a single
  flight): a caller that finds a look or a making out joins it under its own deadline and
  starts no second one, so a store that never answers is asked once. Never call the store
  from `DeviceProofs` another way. **A caller that gives up leaves no task waiting, and
  never cancels the shared call** (`Shared`: a waiter is a continuation its own task's
  cancellation resumes); never await a flight as a `Task`'s value again. **A removal that
  succeeded drops the flights** (`DeviceProofs.remove`, the one way the client removes a
  key: the sign-out's and `TulaClient.removeDeviceKey()`): who had joined gets
  `device.key_failed` at once, who asks afterwards looks again, and a late answer of the
  dropped look is used by nobody, also while a newer look is out (`Shared.finish` asks the
  generation: keep that guard and the test that fails without it). **A removal whose
  outcome is not known (no answer in time, the caller cancelled) drops them too; one the
  store refused drops nothing.** A cancelled removal is `device.key_failed`: the client
  has no code for a cancelled call and throws no `CancellationError`. A dropped call is not
  stopped, so two calls of a store can run at once: `TulaDeviceKeyStore.create` says a
  store must tolerate it. Keep the test of each (`HardeningTests`). The sign-out of
  a lost key runs inside the shared refresh and has `refreshTimeout`, never the client's
  timeout. A new await on a store, a sheet's result excepted (the gate's ceiling), goes
  through `within`, with the test that it ends (`HardeningTests`).
- **A key that cannot be had is never read as gone, also when it will never be had
  again** (a blob the enclave no longer opens): every refresh is `device.key_failed` and
  the docs say that it may not pass. **The client removes a key by itself only at a
  sign-out, and only for `TulaDeviceKeyStoreError.unusable`**, the store's own word for
  "never again"; a removal that fails is not the sign-out's failure, and a sign-out
  cancelled while the store is being asked removes nothing. Every other failure
  (a locked device, a cancellation, a deadline, an unknown error) leaves the store alone:
  it may pass, and a store can be shared with a client whose session is bound to the key.
  **`KeychainDeviceKeyStore` throws that word for nothing**, because no Keychain status
  and no CryptoKit error is documented to mean it; the way out there is the app's
  (`signOut()`, then `TulaClient.removeDeviceKey()`, never the store's own `remove()` in
  a doc: the client is not told of that one). Making the adapter throw it for a status is
  a decision in ADR 0051, with Apple's sentence that justifies it.
- **What holds a secret is `TulaRedacted`** and prints as its type's name with `print`,
  `String(reflecting:)` and `dump`: a new type of the package that holds a token, a code,
  a secret, a key or a ticket, or the client or session that lead to one, conforms and
  gets a row in the table of `HardeningTests` (a private type conforms and has no row:
  the test cannot name it). Its mirror suppresses the superclass too, so a subclass of a
  redacted class prints nothing of either. The generated types are ADR 0050's exception,
  and `FlowSnapshot`, which holds a generated step, prints as they do.
- **The Secure Enclave key is never exported, and a simulator's software key is said to be
  one** wherever `KeychainDeviceKeyStore` is documented.
- **`native/swift/fixture/server.ts` is a test fixture and is guarded like
  `e2e/server.ts`**: it refuses to start without `TULA_NATIVE_FIXTURE=1`, listens on
  127.0.0.1, puts its `/__test/*` routes behind `e2e/guard.ts`, keeps the run's secret key
  in its own process (a journey's admin call is relayed), and `.dockerignore` excludes
  `native`. Never loosen one, and never import it from anything.
- **A journey has one form in the source**: `journey("<scenario>", "<title>") { … }` or
  `behaviour("<id>", "<title>") { … }` as the first statement of a `func test…() async
  throws` method of a top-level `final class …: JourneyTestCase`, both names plain string
  literals. `native/swift/fixture/journeys.ts` reads the sources and judges them with
  `loadClientJourneys`, `clientJourneyListProblems` and `clientSuiteProblems`: never
  restate a rule of the list there, and never loosen the scan (it refuses `XCTSkip`,
  `XCTExpectFailure`, `#if`, `@available`, `defaultTestSuite` and swift-testing attributes
  anywhere in that directory): reword what it finds. It runs as a test of the Swift suite
  and in `test:harness` (`.claude/hooks/swift-journeys.test.ts`, with the scan's own
  fixtures). `SWIFT_NOT_BUILT` holds the count of `not_built` scenarios per ticket: it
  changes with the list.
- **`verify` proves the list and the declared journeys agree, not that a Swift test
  passes.** A change under `native/swift/Sources` or `Tests` is run by hand (`swift test
  --package-path native/swift`, then the coverage check) and
  `docs/plans/phase-2-unverified.md`, the two sections of "Step 2.14, the Swift client",
  say what was run.
  The coverage thresholds are `SWIFT_COVERAGE_THRESHOLD`, over the hand-written sources
  only: never count `Generated/`.
- **Organizations (`TulaOrganizations.swift`, TULA-121, ADR 0065) are read for showing and
  never for deciding.** `TulaOrganizationClaims.read` takes the three claims of the access
  token without verifying its signature, all three or none, under the contract's grammars
  (hand-kept copies; `.claude/hooks/native-organizations.test.ts` holds the claim names, the
  fragment parameter and the caps to the contract's). Keep the doc comment that says the
  app's own server checks the same keys. **An invitation's token is a secret**:
  `TulaInvitationLink`, `TulaOrganizations` and `TulaOrganizationInvitations` are
  `TulaRedacted`, the token is sent in a request body only, and it is in no error, log line
  or URL. Choosing an organization (`TulaSession.setActiveOrganization`) installs only the
  access token of the answer, as a step-up does, and checks that the answer names the choice
  that was asked for; `OrganizationJourneys` has the three journeys.
- **Never say more of iOS than was run**, in a doc, a README, a changeset or a doc
  comment. What was: the package compiled for the iOS simulator, and the screens, with the
  client under them, run in one simulator by the example's UI tests ("SwiftUI screens"
  below). **Nothing was run on a device. No passkey sheet, no Sign in with Apple sheet
  and no browser session has been shown by this package, no key was made in a Secure
  Enclave, and no test looked at a Keychain item**: never word a passkey, a provider
  sign-in, the device key or the Keychain storage as working on iOS until one has.

## SwiftUI screens (`native/swift/Sources/TulaAuthUI`, see ADR 0057 and ADR 0060)

`TulaAuthUI` is the package's second library: SwiftUI screens on the client for a sign-in
with a password or an emailed code, a sign-up, the emailed code that proves an address and
a password reset (TULA-49), and for a texted code, the second step, an authenticator app
set up inside a sign-in, a passkey and the providers on the first screen, and the account
(`TulaAccountView`; TULA-60, [ADR 0060](../../docs/adr/0060-swiftui-second-step-and-account.md)).

- **It depends on `TulaAuth`, SwiftUI and Foundation, and on nothing else.** No third-party
  package, and nothing of `TulaAuth` is made public or changed for it: the screens are an
  app on the client's public API.
- **The model decides, the views draw.** `TulaAuthModel` holds which screen is drawn, what
  the fields hold, where a problem is said, where the focus is asked to go and what is
  announced; the files under `Views/` read it and call its actions. **Never put a decision
  in a view**: a view's `body` runs only when SwiftUI draws it, `swift test` draws nothing,
  and `Views/` is not counted by the coverage check for that reason. A branch that is more
  than "which part is drawn for this state" belongs in the model, with a test in
  `Tests/TulaAuthUITests`.
- **What a screen offers is data, and one door performs it** (`TulaAuthContent.swift`):
  the title, the fields, the main button and the links of every `TulaAuthScreen`, each
  with its `TulaAuthAction` and its identifier, and what a field's problems and its
  VoiceOver label read as. A view iterates `model.content` and calls `model.perform(_:)`,
  which does nothing for an action the open screen does not offer. Never give `body` a
  `switch` over the screen, a control an action of its own, or a composed label: a new
  control is an offer in `TulaAuthContent`, with its row in `ContentTests` (whose table
  has no `default`).
- **A screen per step, and "not supported" for every other one.** `TulaAuthScreen` is made
  from the client's `FlowScreen` in one function (`screen(of:)`); a step that offers
  only ways this app cannot take (an emailed link; a passkey where the client was given no
  sheet) is `notSupported` too. Never a blank screen, never an error, never a request on a guess: no
  action of the model sends anything from that screen. A new screen is a case of
  `TulaAuthScreen`, its fields, its words in `TulaStrings` and a row in the tests of both
  layers.
- **A control that cannot work is not drawn, and that is decided from `client.sheets`
  and `TulaAuthOptions` and nothing else** (ADR 0060). A passkey button needs the
  client's passkey sheet; a provider's needs Apple's sheet, the app's Google closure, or a
  browser session together with a redirect URL; a provider name the table has no words
  for is not drawn. Never give a control a fallback that shows something the app did not
  pass, never judge a redirect URL in a screen, and never add a dependency for a
  provider's sheet (Google's ID token is the app's closure, and what it throws is never
  kept or shown). An environment whose only ways cannot be taken here is said in words
  (`ways.noWayHere`), never a blank screen.
- **A dismissed sheet, a closed provider page and `flow.busy` are a `notice`, never a
  `formError`**: drawn in the muted colour, announced, nobody signed in, the button
  working again. Keep the test of each, on both models.
- **Nothing is texted by arriving at a screen.** A texted code is asked for by its button,
  on the sign-in, the second step, the step-up and the account alike; the code field is
  drawn only once a send succeeded. The server's "no message will be sent"
  (`TulaAuthModel.switchedOff`) takes the button away and leaves the sentence.
- **Backup codes of a setup inside a sign-in are shown before `onSignedIn` is called**,
  and leaving their screen any way reports the completion once. So an app goes on when
  `onSignedIn` / `onSignedOut` is called, never on `session.updates()`: the example and
  `docs/swift.md` say so, and stay that way.
- **A setup key, its QR code and backup codes are held only while their screen is open**,
  on both models: emptied by every change of screen or panel and by `close()`. The QR
  code is drawn in memory by `TulaQRCode` (CoreImage) each time and never written
  anywhere; the pasteboard is written only by the `copy` closure, on a person's "Copy".
  A new thing a screen holds is a row in ADR 0060's table and in the tests that leave the
  screen in the middle.
- **The account screen is one model with panels** (`TulaAccountModel`,
  `TulaAccountContent`, `TulaAccountView`), by the same split: the content table in the
  tests has a row for every panel. A session is named by its client kind in the table's
  words, never by a user agent, and marked in words: "This device", "Bound to a device
  key". Signing out other sessions needs no proof. A texted second step is offered only
  where `Factors.sms.available`, and a dormant one is said, never hidden.
- **The step-up is the account screen's own, and a typed secret does not wait behind it.**
  A call answered `auth.step_up_required` opens the step-up with the ways the server named
  that this app can take, and what was asked for is `Owed`: `.perform` (run again by
  itself: nothing secret was typed for it) or `.retype` (the form opened again, empty,
  with the sentence that says so: the password change). Never keep a password or a code
  in the model behind another panel to save a person typing it again.
- **A failed sign-out is not a sign-out, on the account screen too**: it stays, says that
  the session may still be active, offers the sign-out again and does not call
  `onSignedOut`.
- **Nothing is emailed by arriving at a step that offers another way.** The code is asked
  for at once only where an emailed code is the step's one strategy; beside a password, or
  beside a way these screens lack, it is offered and a person asks.
- **The screens hold no token, and nothing secret outlives its screen.** The session is
  the client's. `password`, `code` and `newPassword` are emptied by every change of
  screen, by the completion and by `close()` (the view's `onDisappear`). **What is
  emptied as it is sent is decided per secret, and ADR 0057 has the table**: a sign-in's
  password, and a code that travels alone, right or wrong; a password that is being
  chosen (a sign-up's, a reset's, an expired password's replacement) is kept when the
  server refuses it, to be put right, and a reset's code is emptied only when the refusal
  is said at the code field. Never say "every secret is emptied after every submission",
  and a new secret field gets its row there and its test against a refusing transport
  (`LeftAndRefusedTests`). Never keep one in another property,
  a `@State` of a view, `@AppStorage`, `@SceneStorage`, the pasteboard or a log. The model
  is `TulaRedacted`; a new type here that holds a field's text conforms too. **Whether a
  password is drawn in the clear is the model's too** (`revealed`, `isRevealed`,
  `toggleReveal`): emptied wherever the fields are, and for a password as it is sent and
  emptied. Never a `@State` of the field: a view's copy outlives the screen it was set
  on, and the next password typed would be drawn in plain text.
- **A flow that is left is discarded, and a late answer changes nothing.** `close()`, a
  move to another flow and "Start again" call `discard()`; every action notes the model's
  `generation` and its answer, a failure included, is dropped when that has moved. Keep
  the three tests of an answer that arrives after the screen was left. **The one answer
  that is not dropped is a completion**: a flow that had completed when it was left
  cannot be discarded (the client is signed in), so the model shows `signedIn` and calls
  `onSignedIn` once (`arrived()`); never drop it, a form would be drawn to a signed-in
  user. The client makes that sound: `FlowAttemptState.accept` checks "discarded" and
  records the step under one lock hold, before the session is stored, as `@tula-tech/core`
  does in one turn. Never put an `await` between the two. **A late completion ends
  whatever is open by then, on purpose**: a second flow started meanwhile is discarded
  and its fields emptied (as `@tula-tech/react`'s screens go when the client becomes signed
  in). So `onSignedIn` can be called after `close()`, and "once" is once per completion.
- **A flow that completed is signed in also when its last action threw.** The answer said
  `complete`, the client holds the session in memory, and storing it failed
  (`storage.failed`): the flow is over, a retry could only be `flow.invalid_step`, and
  "Start again" would sign nobody out. The model shows `signedIn`, calls `onSignedIn`
  once and says `strings.sessionNotSaved` on that screen, shown and announced, never an
  alert that blocks: the session is sure only while the app runs (the words say "may be
  signed out when the app closes", because a later refresh that succeeds stores it after
  all). An action asks its flow
  whether it completed; a start that threw hands back no flow, so it asks the client's
  session, and only for `storage.failed`. Never show the error on the form the flow
  left, and never word that session as kept. `CompletedAndRevealedTests` has the table
  (a password, an emailed code, a sign-up's code, a start); a new action that can
  complete gets a row.
- **A closed screen is on the start of its own mode, with nothing typed, the address
  included** (`close()`): a view that is pushed over or left for another tab keeps its
  model, and a step with no flow would have buttons that do nothing. **No action is
  silent**: one whose flow is gone opens the start with `strings.flowLost`, shown and
  announced (`lost()`), and a new action that needs a flow does the same.
- **Every string is a property of `TulaStrings`, and a server's error is its code.** No
  string literal that a person reads in `Views/` or the model. A failed call is
  `errors[code]`, else the contract's sentence for a code in `knownCodes`, else
  `unknownError`: **text a server wrote is never drawn or announced** (for a code this
  version does not know `TulaError.message` is the server's `detail`; the canary test
  holds the form, the fields and the announcement). A value is put into a `{placeholder}`
  once and never read again, and a string is drawn with `Text` of a `String` value, never
  a literal built from one, `LocalizedStringKey`, `AttributedString(markdown:)` or a link.
- **A theme value is untrusted and reaches a view only through `TulaResolvedTheme`.**
  First the contract's grammar (`TulaThemeGrammar`, the rules of `isValidThemeValue`:
  never looser, and it refuses anything outside ASCII as well), then the conversion, which
  **refuses what this version cannot draw instead of guessing** (`hwb()`, `lab()`,
  `oklch()`, a colour name beyond `transparent`, `black` and `white`; `%` and the viewport
  units; a negative length, one over 200 points, a text size under 11). A refused value is
  the default's, and `refused` names the token, never the value. A view never reads a
  string of `TulaTheme`. **The grammar is a hand-kept copy**: a rule changed in
  `packages/contract/src/theme.ts` is changed in `TulaThemeValues.swift` in the same
  change, with a row in `ThemeGrammarTests`. Nothing generated holds the two together;
  one fixed corpus does, as far as it goes: `packages/contract/src/theme-cases.json`
  (ASCII values with the contract's verdicts), read by the contract's test and by the
  Swift one. A changed rule gets a value there; never edit a verdict to make one side
  pass. Keep the test that the default theme resolves with nothing refused, and
  `ThemeContrastTests` (every text of the default theme at 4.5:1 on what it is drawn on,
  from the resolved values).
- **Four slots, and none can take a label away** (`tulaAuthHeader`, `tulaAuthFooter`,
  `tulaAuthPrimaryButtonStyle`, `tulaAuthFieldStyle`). A field style is handed the text
  field already labelled, identified and bound to the focus. The title, the messages and
  the order of a form are not slots; a fifth slot is a decision in ADR 0057.
- **Accessibility is part of done**: a visible label above every field and the same label
  for VoiceOver; a problem in words ("Error: …") under its field, in what the field is
  read as, and announced; the focus asked to the title on a change of screen and to the
  first field with a problem on a failure; controls at least 44 points high, text that
  wraps, sizes through `ScaledMetric`. State is never a colour alone.
- **The UI tests are the native UI test seam** (`examples/swiftui/TulaExampleUITests`,
  run by `bun run native/swift/fixture/ui-tests.ts`): the example app in an iOS simulator
  against the real API on `native/swift/fixture/server.ts`, one API per test, the codes
  read from the emails it sent, and the system's accessibility audit on every screen
  reached. A new screen or state gets a test and an audit there. **Set-up, tear-down and
  the tests are synchronous** (`ScreenTestCase`; async work goes through the helper that
  waits on a semaphore): an `async` `setUp` on the main-actor test class ended the runner
  in the concurrency runtime on Xcode 16.4, so never make one `async`.
- **A screen is audited with the keyboard away, and the audit has one exclusion**
  (`auditIssues` in `Support.swift`): "text clipped" on the address field, **only while
  the address it holds is measured to fit the field** (`fits`: the system font at the
  default text size, taken a quarter wider; an address that does not measure as fitting
  keeps its finding, and a test holds the rule), with its reason beside it. The
  audit measures an element from the pixels at its frame, so the lines under a keyboard
  were measured as the keyboard (`putKeyboardAway`): never audit with it up, and **never
  leave a contrast finding out**. Never add an exclusion to get a test green without its
  sentence, never widen one to an element type or an audit type as a whole, and never
  word it as showing the finding wrong: nobody showed that.
  **The audit is not VoiceOver.** No test turns VoiceOver on; never say a screen was
  tested with it until someone has.
- **Every process the runner starts has a timeout, and the fixture does not outlive the
  run** (`ASK_TIMEOUT_MS`, `TEST_TIMEOUT_MS`, `FIXTURE_TIMEOUT_MS`): its first line is
  read by `readyPort` (whole however the pipe cuts it, within `READY_TIMEOUT_MS`, the
  rest read and dropped so a full pipe never stops it), and it is ended in a `finally`
  and on `SIGHUP`, `SIGINT` and `SIGTERM`. Never say more than those three: a `SIGKILL`
  of the runner runs none of that (its timeouts go with it), and the simulator is left booted by every run
  (`docs/swift.md` says what to end by hand). It is started with `TULA_NATIVE_FIXTURE=1`
  and nothing looser, and the simulator is the script's pick or the one named.
  `.claude/hooks/swift-journeys.test.ts` tests the pick, the arguments and `readyPort`,
  and **reads the runner's source** for the rest: every `Bun.spawn(` and
  `Bun.spawnSync(` call names a `…_TIMEOUT_MS` constant among its arguments, and the
  `finally` and the three signals are there. It does not start the runner: never word it as
  having seen a fixture ended.
- **`verify` runs none of it, and no workflow runs the simulator.** `swift test` (and the
  `Swift` workflow) builds `TulaAuthUI` and runs the model's tests; the coverage check
  holds `TulaAuthUI` alone to the unchanged thresholds over the files directly in its
  directory (`SWIFT_COVERED_MODULES`: never lower a threshold, and never move code into
  `Views/` to get under it). The simulator run is by hand until someone has seen it pass
  on a runner (ADR 0057): after a change under `Sources/TulaAuthUI` or `examples/swiftui`
  run it and write the run (Xcode, the simulator, the iOS version, the result line) in
  `docs/plans/phase-2-unverified.md`, "Step 2.14, the SwiftUI screens".
- **The example is `examples/swiftui`, an Xcode project and not a workspace package**: no
  `package.json`, excluded by `.dockerignore`, the package taken from the checkout by
  path. **It holds no key.** The API's address and the publishable key come from the
  scheme's environment variables or the app's setup screen; never commit either in a
  scheme, a plist or a source, and keep App Transport Security as shipped but for
  `NSAllowsLocalNetworking`.
