---
paths:
  - "native/android/**"
  - "examples/compose/**"
  - "e2e/kotlin-fixture.ts"
  - ".claude/hooks/kotlin-journeys.test.ts"
  - ".claude/hooks/compose-ui-tests.test.ts"
---

# Kotlin client and Compose screens

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## Kotlin client (`native/android`, see ADR 0054)

- **It behaves as `@tula-tech/core` does, rule for rule**: one refresh at a time, given up after
  `REFRESH_TIMEOUT_MS` (held equal to `@tula-tech/core`'s by `.claude/hooks/kotlin-journeys.test.ts`),
  one repeat of a refresh that got no answer, a session ended only by the server's
  `session.*`, `auth.unauthenticated` or `auth.user_banned`, a sign-out that throws when the
  server could not be told, a discarded flow whose late answer signs nobody in. A change to
  one of those rules in `@tula-tech/core` is made in `Session.kt` or `Flows.kt` in the same
  change; only the one constant is held by a test.
- **`tula-auth` is plain Kotlin on the JVM and imports nothing of Android**; what needs a
  device (`KeystoreTokenStorage`, and one adapter per interface: `CredentialManagerPasskeySheet`,
  `CredentialManagerGoogleSheet`, `CustomTabsBrowserSession`, `KeystoreDeviceKeyStore`) is in
  `tula-auth-android` and nothing else goes there. **An adapter holds no rule**: it calls the
  system, maps its exception to a `SheetFailure` and drops the rest, and what a dismissal, a
  returned address or a lost key means is decided in the JVM module, where it is tested.
  **No tool checks that `tula-auth` uses only Java APIs Android has at API 28**: look up the
  API level of one you add, and never use `java.net.http`.
- **A deadline never rests on the engine honouring cancellation** (`Transport.call`: the
  request runs in the client's scope and the call waits for it, for the timeout at most).
  Never put `http.send` back inside the `withTimeout`: a suspended call that ignores
  cancellation is waited for there. Keep the test with an engine that ignores it.
- **Every call of the storage is inside a deadline too, and that one does not rest on
  cancellation either** (`stored` in `Session.kt`, the refresh's timeout): a storage call
  that never returns (a blocked Keystore call does not end when cancelled) is
  `storage.failed` with the session kept, and `load()` stays `Loading`, exactly as for one
  that throws. Never await `storage.get`, `set` or `remove` in the session another way.
  **A sign-out waits for a refresh in flight for the refresh's timeout at most**, then goes
  on with the newest token it has. A call left behind is not stopped and may still land;
  never word the deadline as ending it. Keep the three tests on `StallingStorage`.
- **`TulaError` keeps nothing of what the platform threw**: no `cause`, no suppressed
  exception, none of its text; `clientError` takes a code and no exception. This differs
  from `@tula-tech/core` and `@tula-tech/expo`, whose errors keep a `cause`, on purpose: Android writes
  an exception to the log with its whole chain, and an engine's exception names the address
  it was asked for, which holds an attempt's id. It is the Swift client's rule. Never give
  the type a cause back; keep the canary test in `TransportTest`.
- **A path parameter is one path segment or no request is made**: empty, `.`, `..`, a
  slash or a control character is `response.invalid` before anything is sent
  (`isOnePathSegment`, the rule of `@tula-tech/admin` and the Swift client).
- **The client's state is touched on one confined dispatcher** (`limitedParallelism(1)`).
  Never add a lock held across a suspension or a second place that starts a refresh.
- **Nothing is logged and nothing prints a secret**: the module has no logger; `HttpRequest`,
  `HttpResponse`, a flow and `TulaError` print no header, body, token or attempt secret; an
  `IllegalArgumentException` of the constructor never repeats a value it was given.
- **`TulaClient` has no default storage.** `KeystoreTokenStorage` seals with a Keystore key
  that asks for no user authentication (a refresh runs in the background). **A value is "no
  token", and removed, in two cases only: the key does not exist, or the bytes are not the
  storage's writing.** Every other failure is thrown and is `storage.failed` with the
  session kept and nothing deleted, **a failed tag while the key exists among them**: never
  catch `AEADBadTagException` into "no token" again (a key store that answers wrongly once
  would sign the user out). That decision is `AesGcmSealer`'s, in the JVM module, so that
  it is tested; the Android module supplies the key and nothing else (`AndroidKeystoreKeys`).
  A sign-out removes the entry whatever the read said, and a sign-in writes over it:
  `remove` and `set` never open what is stored, and the three run one at a time (a read
  that removes is two steps; a token written between them must not go with the entry).
  Keep the tests of each in `StorageTest`.
  **A sealing key that cannot be had is replaced where a value is sealed, and nowhere
  else** (`AesGcmSealer.seal` → `SealingKeys.replace`: delete the alias, generate): what is
  being written is the only value under the key, and without that a device whose key no
  longer loads could never keep a session again. `open` and `existing()` never replace and
  never delete. The cost is said in the docs: a write that fails after a replacement
  leaves an entry whose tag fails until the next write or a sign-out. The Android half
  (`AndroidKeystoreKeys.replace`) has never run.
- **The sealed tokens' preferences file is in Android's backups unless the app excludes
  it**, and only the app can. `docs/kotlin.md` gives the two rule files;
  `.claude/hooks/kotlin-journeys.test.ts` holds the name in them to
  `DEFAULT_PREFERENCES_NAME`. Change the constant and the docs together.
- **The default HTTP engine never streams a request body** (the JDK then drops the body of
  a 401, which holds the code), follows no redirect and caps an answer. Keep its 401 test,
  and never word it as covering Android: it runs the JDK's `HttpURLConnection`, Android's
  is another implementation, and the API's 401 has no `WWW-Authenticate`. Docs name the
  case to try on a device and an `HttpEngine` over OkHttp as the app's way out.
- **A step with no action is `FlowScreen.NOT_SUPPORTED`, never an exception**: an unknown
  status, and a known one that offers only what this version cannot do. A new action widens
  `flowScreen` in the same change. **The Kotlin client has a call for a texted first-factor
  code (`CodeStrategy.SMS_CODE`)**, as the Swift client has since TULA-60, so a step that
  offers only `sms_code` is not `NOT_SUPPORTED` here.
- **The journeys run over HTTP against `e2e/kotlin-fixture.ts`, a world per journey, and
  fail without it**: never skip one, never an `@Ignore` or an assumption in the suite. The
  fixture needs `KOTLIN_FIXTURE=1`, listens on 127.0.0.1 and keeps its `/__test/*` routes
  behind `e2e/guard.ts`. A journey sets things up as an operator would (the admin API),
  **and a world's secret key never leaves the fixture's process**: the answer that makes a
  world holds no secret key, and an admin call is relayed (`POST /__test/worlds/<id>/admin`,
  a path under `/v1/admin/` as written, never with a caller's own `Authorization`), as the
  Swift fixture relays. `.claude/hooks/kotlin-journeys.test.ts` holds it. A fixture route that does what the client cannot yet
  is named in the journey that uses it and goes when the client gains the call (there is
  none today: `phone` went with `client.phone`).
- **`JourneysTest.kt` has no block comment but documentation and no raw string that spans
  lines** (`unscannable` in the hook test: a test commented out would otherwise count as
  one that runs). Reword what it refuses, never the rule.
- **A journey is a `@Test` of `JourneysTest` with `@Journey("…")` or `@Behaviour("…")` on a
  line of its own directly above the function**: `.claude/hooks/kotlin-journeys.test.ts`
  reads the file's text and runs the real list checks in `verify`; `GuardTest` does the same
  by reflection in the suite. Both hold the `not_built` count per ticket. **`verify` shows
  the declarations and the list agree; only CI's `kotlin` job shows the journeys pass**, so
  run `bun run native:kotlin:test` before saying a change to the client works.
- **Every version is exact and in `gradle/libs.versions.toml`**; the wrapper pins its
  distribution with a SHA-256. Dependabot watches the build from `/native/android`
  (`.claude/hooks/dependabot.test.ts` fails for a build manifest of any ecosystem that no
  entry of `.github/dependabot.yml` covers). **Nothing verifies what Gradle downloads**:
  there is no `gradle/verification-metadata.xml`, and no doc may say the dependencies are
  checksum-verified until there is. **The JVM tests and the Android build are two jobs**
  (`kotlin`, with the Android SDK variables emptied so the build has the JVM module alone;
  `kotlin-android`, which installs the pinned platform and build tools with `sdkmanager`
  before it builds): never merge them, and change the names it installs with the module's
  `compileSdk` and `buildToolsVersion` (`ci.test.ts` holds both). Neither job caches anything (`ci.test.ts`'s rule that a
  push does all the work). The coverage bound is Kover's, on the hand-written sources.
- **The system is behind four interfaces, and all four are `null` unless the app passes
  one** (`PasskeySheet`, `GoogleSheet`, `BrowserSession`, `DeviceKeyStore`; TULA-57). Never
  give one a default that touches the system: a client that was handed no key store binds
  no session, and one with no sheet answers `passkey.unsupported` or `provider.unsupported`
  before any request. **No test shows a sheet, opens a browser or asks a Keystore**: the
  journeys put a software authenticator, a scripted browser and a software key behind the
  interfaces (`journeys/Native.kt`).
- **A dismissed sheet and a closed browser are values, never an error and never a
  sign-in** (`TulaCeremony.Dismissed`, `ProviderOutcome.Cancelled`). A sheet's failure is
  one of four words (`SheetFailure`, thrown as `TulaSheetException`) and becomes one of the
  client's codes in `CeremonyGate.sheet`; **whatever else a sheet throws is `*.failed` with
  none of its text**. **Which of Credential Manager's exceptions is which word is one
  function of the JVM module** (`sheetFailureOf`, over `CredentialFailureKind`; the adapter
  only names the kind): a dismissal is Credential Manager's own cancellation and nothing
  else, and a WebAuthn `NotAllowedError` is `FAILED` until a device shows it is purely a
  cancel. Never widen what is a dismissal without that, and keep the table in
  `NativeWaysTest`. Nothing of a ceremony (options, a credential, an ID token, a nonce)
  outlives its call, except a provider's binding and a ticket whose exchange got no
  answer, in memory, for at most a minute (`ProviderRoundTrip`, `TICKET_HOLD_MS`); what
  holds a ticket prints as its type's name (`ProviderRoundTrip.Answer`: never a data
  class).
- **One sheet at a time for a whole client** (`CeremonyGate`): a second passkey, Google or
  browser call is `flow.busy` before any request, never joined and never queued; a sheet
  that never answers gives its place back after `SHEET_CEILING_MS` (300 s, a challenge's
  lifetime) as a dismissal, and a later answer is dropped.
- **What the browser returns is read only when it is the redirect URL that was asked for,
  character for character, followed by `#`** (`ProviderRoundTrip.read`). Never normalise
  either side, never judge the redirect URL in the client (the server's
  `request.redirect_not_allowed` is thrown as it is), and a return for an attempt this
  client did not start is refused without a request. An error code in the returned address
  is passed on only when the contract defines it. A new refused form gets a row in
  `NativeWaysTest`. **A held ticket is forgotten only on an answer about it** (and after a
  minute, at a sign-out, by a new round trip): a client error raised before it was
  presented keeps it (`RETRYABLE`). **`CustomTabsBrowserSession.returned(intent)` takes an
  intent only when its address starts with the redirect URL it opened, followed by `#`**
  (`BrowserReturn.isReturnTo`, in the JVM module so that it is tested): for any other
  intent it answers `false` and leaves the wait alone, so a foreign link cannot end a
  round trip. It is a first filter, never the judgement: the client still reads the whole
  address.
- **Google's sheet gets the server's nonce as it is, and the client never hashes**: Apple's
  hashed nonce is the iOS sheet's business, and on Android Apple goes through the browser
  like every provider but Google. An attempt takes one token (`IdTokenSignIn.exchange`
  refuses a second without a request).
- **Proofs are made in the transport, for the six starts and the refresh**
  (`DeviceProofs.PROVEN`), the nonce is kept in memory, and a request is repeated once after
  `device.nonce_required`, inside the same call and deadline. **A `device.*` answer never
  ends the session, with one exception**: a refresh refused `device.proof_invalid` while
  the key store, asked twice, said both times it has no key (`DeviceProofs.verdict`: only
  `GONE`) ends it locally and tells the server. A look that finds the key, throws or
  contradicts the first keeps the session (`device.key_failed` for a contradiction). Never
  end a session on one look, and never read a store that threw or did not answer as "no
  key". Sign-out sends no proof. Keep the verdict table in `NativeWaysTest` and the
  lost-key journey.
- **Everything a call waits for outside the client is inside its deadline, and the key
  store is asked one thing at a time** (`DeviceProofs.Flight`: a caller that finds a look
  or a making out joins it under its own deadline, so a store that never answers is asked
  once and every caller gets `network.timeout`). A removal drops the flights. The client
  removes a key by itself only at a sign-out and only for `DeviceKeyUnusableException`,
  which `KeystoreDeviceKeyStore` throws for nothing (no Keystore exception is documented to
  mean it): making it throw that is a decision in ADR 0054. **A refused proof's path has
  three waits, each the refresh's timeout at most** (the verdict's looks, the stored
  token's removal, the sign-out), inside the one shared refresh: about three timeouts for
  every waiter in the worst case, said in `docs/kotlin.md`. They are not given one budget:
  it would be taken from the sign-out, the one call that tells the server.
- **`KeystoreDeviceKeyStore.existing()` answers `null` only for "no entry under the
  alias"** and throws for everything else, and the key is "a key the Keystore keeps, with
  no call that exports it": never "verified", never "hardware-backed" as a fact (StrongBox
  is asked for first and which was used is not recorded).
- **The Android module's libraries are Credential Manager's and nothing else**
  (`androidx.credentials`, its `credentials-play-services-auth`, Google's `googleid`). The
  Custom Tab is opened with the protocol's own intent extra: never add `androidx.browser`,
  OkHttp, Google's sign-in SDK or any other library without a line in ADR 0054.
- **Not built, and said so in the list and the docs**: an emailed link (no call asks for
  one; `not_built` under TULA-76, the native clients' emailed link), a passkey's rename
  (`HttpURLConnection` has no `PATCH`; TULA-76 too). **An account with no address gets one through `client.emailAddress`**
  (`request`, `verify`: ADR 0059's two routes and nothing more; no call changes an
  address).
- **Never say more of Android than was run.** What ran (a JVM; a compile and a lint of the
  Android modules; the screens, with the client and `KeystoreTokenStorage` under them, on
  one emulator by the example's UI tests) and what did not is
  `docs/plans/phase-2-unverified.md`, the two sections of "Step 2.15, the Kotlin client"
  and "Step 2.15, the Compose screens". **Nothing ran on a device, and no test read a
  stored token back or started the app again to load a session**: never word the Keystore
  storage, or a session kept across a start, as working on Android until one has. **No
  passkey sheet, no Google sheet and no browser has been opened by this library, on a
  device or an emulator, and no key was made in a Keystore or StrongBox**: never word a
  passkey, a Google or provider sign-in or the device key as working on Android, in a doc,
  a README, a KDoc or a changeset, until one has.

## Compose screens (`native/android/tula-auth-ui`, `tula-auth-compose`, see ADR 0061 and ADR 0062)

Compose screens on the Kotlin client for a sign-in with a password or an emailed code, a
sign-up, the emailed code that proves an address, a password reset and the replacement of
an expired password (TULA-50), and for the second step, an authenticator set up inside a
sign-in, a passkey, Google and the other providers, a texted code and the signed-in user's
account (TULA-61, `TulaAccount`). They are the SwiftUI screens' design ("SwiftUI screens"
above) on Android, and both libraries draw the same steps and the same account
([ADR 0060](../../docs/adr/0060-swiftui-second-step-and-account.md),
[ADR 0062](../../docs/adr/0062-compose-second-step-and-account.md)): **a rule of the model
changed in one library is changed in the other in the same change**, or the ADR of the one
that differs says why.

- **Two modules, and the split is the rule.** `tula-auth-ui` (package `dev.tula.auth.ui`)
  is plain Kotlin on the JVM: `TulaAuthModel` and `TulaAccountModel`, `TulaAuthContent` and
  `TulaAccountContent`, `TulaStrings`, `TulaThemeValues.kt`, `TulaQr.kt`. It imports no Compose and nothing of Android, and nothing of
  `tula-auth` is made public or changed for it. `tula-auth-compose`
  (`dev.tula.auth.compose`) is an Android library on Compose's `ui` and `foundation`,
  **with no Material** and no other library. **Never put a decision in a composable**: one
  runs only when Compose draws it, and nothing in `verify` or in CI's `kotlin` job draws. A
  branch that is more than "which part is drawn for this state" belongs in the model, with
  a test in `tula-auth-ui/src/test`.
- **What a screen offers is data, and one door performs it**: a composable iterates
  `model.content` and calls `model.perform(action)`, which does nothing for an action the
  open screen does not offer. Never a `when` over the screen in a composable, a control
  with an action of its own, or a label composed there: a new control is an offer in
  `TulaAuthContent` or `TulaAccountContent`, with its row in the content test. Both screens
  are drawn from the same parts (`TulaParts.kt`).
- **A screen per step, and "not supported" for every other one** (`TulaAuthScreen`, from
  the client's `FlowScreen` in one function): an unknown status, a step the client has a
  step that offers only ways this client cannot take here (no sheet for them). The second
  step, the enrolment and a step that offers only `sms_code` have screens since TULA-61.
  The mapping has no `else`:
  a value `FlowScreen` gains does not compile until it is decided here, with its row in the
  model's test "a step with no screen is not supported and never blank". Never blank, never
  an error, never a request on a guess.
- **Nothing is emailed by arriving at a step that offers another way**; a code is asked for
  at once only where an emailed code is the step's one strategy. **Nothing is ever texted
  by arriving**, also where a texted code is the only way: a button asks, the code field is
  there only after a send of that screen succeeded, a first factor's words never claim a
  message was sent, and a refusal an operator's setting causes takes the button away. The
  field is `ContentType.SmsOtpCode` and that is all: **no SMS permission, no SMS Retriever
  or User Consent API** (a decision in ADR 0062, with what each would need).
- **A way to sign in is in the content only where the environment lists it and
  `client.sheets` says the client was given what it needs** (a passkey sheet, Google's
  sheet, a browser session with `TulaAuth`'s `redirectUrl`), and no way is drawn before the
  configuration was read. So a control is never drawn and then taken away: never draw one
  on a guess, and never ask a sheet during composition. Where that leaves no way, the
  screen says so in words (`ways.noWayHere`). `client.sheets` is booleans: it never hands a
  sheet to the screens, and it does not say the device can show one.
- **A provider's ticket never outlives the screen that could present it again.** The
  client keeps one for more failures than the screen offers "Try again" for
  (`ProviderRoundTrip.RETRYABLE` against the model's `NO_ANSWER`), so the model never asks
  its own state whether one is held: `leave()` (every close, every change of mode,
  "Start again", a completion) and `show()` (going on from the start: a passkey that
  signed in, a step) call `client.discardProviderSignIn()` unconditionally, and a failure
  the screen has no button for discards at once. Never guard that call on
  `canRetryProvider`. `WaysAndSecondStepTest` has the test of each.
- **A sheet or a page that was closed is `notice`**: never `formError`, never `status`,
  nobody signed in, the button works again. A sheet that failed and a passkey the server
  refused are problems in their own words. **One ceremony at a time**: the client's
  `flow.busy` is said as a notice (`sheetBusy`), and the model starts no second sheet and
  queues none. Keep the tests of each (`WaysAndSecondStepTest`, `AccountTest`).
- **A setup key, its QR code and backup codes are state only while their screen is open**:
  emptied by the next screen, by `close()` and for an answer that arrives after the screen
  went; the content is built from the state at each draw and never remembered; nothing of
  them in `rememberSaveable`, a `Bundle`, a log or `toString`. **A copy is made only on a
  press, through the model's `copy`, which `tulaSensitiveCopy` marks
  `EXTRA_IS_SENSITIVE`; the library never clears the clipboard** (it cannot tell its own
  clip from a later one). Never word the mark as protecting the clip: what Android does
  with it (13 and later: hidden in the preview, cleared after a while) is Android's, was
  not observed, and `docs/kotlin.md` says so.
- **The QR code is `TulaQr.kt`, a port of `packages/react/src/qr`, and no dependency.** The
  two are held together by `packages/react/src/qr/qr-cases.json`, read by `corpus.test.ts`
  and by `QrTest`: a change to either encoder keeps both green, a new case is a row there,
  and a matrix in it is never edited to make a side pass. Drawn dark on white whatever the
  theme, four modules of quiet zone. Nobody scanned one: never say it was.
- **An app leaves `TulaAuth` on `onSignedIn` and `TulaAccount` on `onSignedOut`, never on
  `client.state` alone.** An authenticator set up inside a sign-in signs the client in
  before the backup codes were shown, and `onSignedIn` waits for "I have saved these
  codes"; a sign-out the server could not be told of signs the client out locally, **is
  not a sign-out**, is said so with the sign-out offered again, and never calls
  `onSignedOut`. The example and every sample in a KDoc or a doc follow that (an emulator
  test failed on the first until the example did): never write a sample that swaps the
  two on the client's state.
- **The account screen** (`TulaAccountModel`): sections each read by their own request (one
  that failed says so and can be read again), a form in place of the overview for a change,
  a question before anything is removed. A session is marked "This device" and, where
  `deviceBound`, **"Bound to a device key", in those words**: the string tables' test
  fails for "trusted" or "verified" of a device. **A passkey cannot be renamed and the
  screen says so** (`renameUnavailable`; TULA-76): never draw a rename that does nothing.
  Connected provider accounts, an address for an account without one and account deletion
  are not on it (TULA-78); each is a decision.
- **The account is the session's it was read for, and a session that ended elsewhere is
  told once** (ADR 0060's rule, `AccountSessionTest`). The model asks the client whose
  session it is when the account is read, when an act is asked for and when an answer
  arrives (`sync()`, and `current()` in place of the bare generation: never compare an
  answer's `asked` with `generation` directly). Another session than the one drawn means
  everything read or typed is dropped, an owed step-up included, and an answer asked as
  the old session is nobody's. No session, and not by this screen's doing
  (`endedElsewhere()`): the screen is emptied, no section says "could not be read", and
  `onSignedOut` is called **once per ended session** (the latch is `signedOut`, reset when
  a session exists again), never after the screen's own sign-out, never while that one is
  on its way or failed. **And only for a session this screen saw** (`shownFor`, set when
  the model first meets a signed-in client): a model on a client nobody signed in to
  reports no sign-out, asks the server nothing and draws nothing as failed. The model has
  no subscription to the client: it finds out at its next call, and the docs say so.
- **"Confirm it is you" is drawn from `auth.step_up_required`'s `params.methods`** (the
  client's `stepUpMethods`), filtered only by "this client has a form and a sheet for
  it": the model never decides which call needs one or what an account may step up with.
  An emailed and a texted code are asked for with a button. With no method, and for a
  step-up call that is itself answered `auth.step_up_required`, the screen says to sign
  out and in again and opens nothing. **Afterwards the act that was refused is carried
  out once, without a press; a password change is not** (its passwords were emptied as
  they were sent and are held nowhere: its form is shown again, empty). Never keep a
  secret to repeat a call. A new account action says which it is (`Owed`'s `again`), with
  a row in `AccountTest`. **The repeat goes through `repeat(again, proved)` and never
  straight to `execute`**: it is made only while the generation the proof was accepted
  under still holds (no `close()`, no cancel, no other session since) and what is drawn
  still offers the act.
- **Only a number or a boolean of a server's `params` fills a placeholder** (a wait, a
  count); a masked destination from an answer's body is the one string of the server's
  that is drawn.
- **The screens hold no token, and nothing secret outlives its screen.** `password`, `code`
  and `newPassword` are emptied by every change of screen, by a completion and by
  `close()`; what is emptied **as it is sent** is ADR 0057's table, repeated in ADR 0061 (a
  sign-in's password and a code that travels alone always; a password being chosen only
  when it was taken; a reset's code when the refusal is said at the code field). Whether a
  password is drawn in the clear is the model's (`revealed`), emptied with the fields.
  **The model is held with a plain `remember`: never `rememberSaveable`, a
  `SavedStateHandle`, a `Bundle` or anything else the system writes to disk**, and the
  mirror of a field's text in Compose state is of the composition only. The stated cost: an
  activity made again (a rotation it does not handle) starts the screens over and discards
  the open flow. Never "fix" that by saving state; the ways out are the app's
  (`configChanges`, or a model of its own passed to `TulaAuth(model = …)`), and
  `docs/kotlin.md` says so. `TulaAuthState` and `TulaAuthModel` print as their names
  (`toString` overridden on the data class): keep the test, and a new type that holds a
  field's text does the same. Nothing is logged.
- **A flow that is left is discarded, and a late answer changes nothing** (`close()`, which
  `TulaAuth(client, …)` calls when it leaves the composition; a move to another flow;
  "Start again"; every action notes the model's generation). **The one answer that is not
  dropped is a completion**: `SignedIn`, and `onSignedIn` once per completion, also after
  `close()`. A flow that completed is signed in also when its session could not be stored
  (`storage.failed`): `SignedIn` with `strings.sessionNotSaved`, never the error on the
  form the flow left. No action is silent: one whose flow is gone opens the start with
  `strings.flowLost`.
- **The destination after a sign-in is the `onSignedIn` callback and nothing else**: no URL,
  intent or deep link is read or followed by the screens.
- **Every string a person reads is a property of `TulaStrings`** (a Kotlin table whose
  defaults are English, **not Android resources**: the model that needs the words runs
  without Android; the cost, said in the docs, is that nothing follows the device's
  language unless the app builds the table from its own resources). No string literal a
  person reads in `tula-auth-compose` or the model. A failed call is `errors[code]`, else
  the contract's sentence for a code this version knows, else `unknownError`: **text a
  server wrote is never drawn or announced** (the canary test holds it). A value is put
  into a `{placeholder}` once and never read again.
- **A theme value is untrusted and reaches a composable only as a `TulaResolvedTheme`**:
  the contract's grammar first (`TulaThemeGrammar`, never looser), then a conversion that
  refuses what this version cannot draw instead of guessing; a refused value is the
  default's and `refused` names the token, never the value. **The grammar is a hand-kept
  copy**, held to the contract by `packages/contract/src/theme-cases.json`, which the
  Kotlin test reads: a rule changed in `packages/contract/src/theme.ts` is changed in
  `TulaThemeValues.kt` (and the Swift copy) in the same change, with a value in the
  corpus; never edit a verdict to make a side pass. Keep the tests that the default theme
  resolves with nothing refused and has 4.5:1 for every text in both schemes.
- **Three slots, and none can take a label away** (`TulaAuthSlots`: `header`,
  `primaryButton`, `footer`, composable lambdas with defaults). A header is handed
  `titleModifier` and a button `modifier`. **Fields, links and problems are not slots**; a
  field slot is a decision in ADR 0061.
- **Accessibility is part of done**: a visible label above every field and the same words,
  **and no others**, as its content description; a problem in words ("Error: …") under its
  field, as the field's `error` semantics and in one live region (**never
  `announceForAccessibility`**, which Android deprecated), and **not in the content
  description as well** (the model's `spokenLabel` is for a view with no `error` of its
  own: a third saying is not put back); the title a heading, the focus asked to it on a
  change of screen and to the first field with a problem on a failure; controls at least
  48 dp high, a link and the button that shows a password 48 dp wide too (`MIN_TOUCH`, on
  both `widthIn` and `heightIn`); **what takes the focus shows it** (`focusEdge`: the
  theme's focus colour on the main button, the links and that button, a transparent edge
  that is always in the chain, never a modifier added only when focused; a replaced
  `primaryButton` slot draws its own); sizes in `sp`, state never a colour alone. **No test
  turns TalkBack on and no accessibility checker runs**: the UI tests read the semantics
  tree. Never say a screen was tested with TalkBack until someone has.
- **The UI tests are `examples/compose/src/androidTest`, run by
  `bun run native/android/fixture/ui-tests.ts`**: the example app on an emulator or a
  device against the real API on `e2e/kotlin-fixture.ts`, a world per test, the codes read
  from the emails it sent, an authenticator's code computed from the setup key by the
  server's clock (`World.totp`). A new screen or state gets a test there. **A press in
  `AccountScreensTest` goes through `still`**: the control is brought into sight and
  pressed only once it is whole in sight, has not moved for `STILL_MS` and the keyboard
  is up exactly when a text field has the focus (asked of the window from API 30; given
  up on after `KEYBOARD_MS` where no keyboard comes). The keyboard is the system's and
  shortens the screen some time after a field took the focus: a press sent before that
  reached nothing on a long form. Never press there with a bare `performClick()`, **never
  raise `WAIT_MS` for a press that was lost**, and keep the failure message saying the
  main button's words, how many characters a code field holds (never the characters) and
  whether the button is out of sight: that is what told a lost press from a slow answer.
  **What a test
  cannot drive is scripted through `ExampleSheets`, a seam of the example and never of the
  library**: one test gives the app a passkey sheet that is closed. **The seam is in the
  example's `debug` source set** (what the UI tests run against); `src/release` has an
  object of the same name whose four properties are `null` and have no setter. Never move
  the settable one back to `main`, and never give the release one a setter. No UI test opens a
  passkey sheet, Google's chooser or a browser, receives a text message or adds a phone
  number, and no doc may say one does. **The fixture is not
  loosened for it**: it stays bound to 127.0.0.1 behind `e2e/guard.ts` and is reached from
  the device through `adb reverse`; never bind it wider, never add `10.0.2.2` to the
  runner, and a test that meets a limit moves the fixture's clock (`World.advance`), as
  the JVM journeys do, never the limit. **A device that is no emulator is refused unless
  `--allow-physical` is given** (`pickDevice`, for the one device `adb` sees as for a named
  one; the refusal says why and repeats no serial): forwarded into a phone, the fixture
  and its relay to the admin API are open to every app installed on it. Never make the
  flag the default, and never run on a serial `pickDevice` did not hand back. **Every
  process the runner starts has a timeout,
  and what it started is ended in a `finally` and on `SIGHUP`, `SIGINT` and `SIGTERM`**
  (never say more than those three: a `SIGKILL` runs none of it).
  `.claude/hooks/compose-ui-tests.test.ts` tests the runner's pure functions and **reads
  its source** for the rest (every `Bun.spawn(` and `Bun.spawnSync(` names a
  `…_TIMEOUT_MS`, `KOTLIN_FIXTURE: '1'`, the `finally`, the three signals); it does not
  start it.
- **`verify` and CI run none of it on a device.** `bun run native:kotlin:test` (and CI's
  `kotlin` job) runs the model's tests and Kover's bound on `tula-auth-ui` (90% of lines,
  the client's bound: never lower it, and never move a decision into `tula-auth-compose`
  to get under it). `kotlin-android` compiles and lints `tula-auth-compose`, the example
  and its UI tests; `.claude/hooks/ci.test.ts` holds the task list, that every Android
  module's `compileSdk` and build tools are what the job installs, and **that no job runs
  a connected test or starts an emulator**: adding the run to a workflow is a decision
  (ADR 0061). After a change under `tula-auth-compose` or `examples/compose` run the UI
  tests by hand and write the run (the image, the result line) in
  `docs/plans/phase-2-unverified.md`, "Step 2.15, the Compose screens".
- **Compose is the newest line that compiles against the build's `compileSdk`** (1.11 at
  36.1), and Espresso is pinned in the catalog because the one Compose's test library
  brings does not start on a current image. Versions stay exact and in
  `gradle/libs.versions.toml`.
- **The example is `examples/compose`, a module of the Gradle build and not a workspace
  package**: no `package.json`, excluded by `.dockerignore`. Its build file names every
  plugin and library through the catalog; `.claude/hooks/dependabot.test.ts` lets a Gradle
  build script outside `/native/android` pass only while it names no version of its own
  (`namesNoVersion`, which fails closed: no quoted `group:artifact:version`, and no
  `version` given a string as an infix word, a call or an assignment, whatever names the
  plugin; a new spelling that must pass is a row of its test, never a narrower pattern). **It holds no key**: the API's address and the publishable key come
  from the launch intent's extras or its setup screen; never commit either. **The extras
  are read by a debuggable build only**: the activity is exported, and any app can start
  it with an address of its own. Plain `http`
  is allowed to `127.0.0.1`, `localhost` and `10.0.2.2` only, and it does not set
  `FLAG_SECURE`, which is an app's choice and never the library's.
