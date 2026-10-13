# ADR 0062 — Compose screens for the second step, the other ways to sign in and the account

- Status: accepted
- Ticket: TULA-61

## Context

The Compose screens ([ADR 0061](0061-compose-screens.md)) drew a sign-in with a password or an
emailed code, a sign-up and a password reset. Every other step the Kotlin client
([ADR 0054](0054-kotlin-client.md)) has a call for ended on "not supported": the second step,
an authenticator set up inside a sign-in, a texted code, a passkey, Google and the other
providers. And a signed-in person had no screen at all.

This ADR adds those screens and the account screen. It keeps ADR 0061's design (a model that
decides in plain Kotlin, composables that draw its content and call one door) and records
what is new: what is drawn of a way to sign in and when, what is kept of a setup key and of
backup codes, how a copy is made, how a recent authentication is asked for, and what the
client had to gain.

No server route and nothing of the contract changed.

## Decision

### The client gained the calls the screens needed, and one fixture route went

- `client.phone` (`request`, `verify`, `remove`): the three routes of `/v1/client/me/phone`.
- `client.revokeSession(id)` and `client.revokeOtherSessions()`, beside `client.sessions()`.
- `client.sheets` (`TulaSheets`: whether the client was given a passkey sheet, Google's sheet
  and a browser session). It answers booleans and hands out no sheet.

With `client.phone` the journeys add a phone number as an app does, so the fixture's `phone`
route (which did it on the client's behalf) is removed, and the four scenarios the Kotlin
column listed as `not_built` under TULA-61 are journeys. What is left `not_built` there is
the emailed link (TULA-76).

### Two models, one design

`TulaAuthModel` gained the screens of a flow; `TulaAccountModel` is new and is the account's.
Both are plain Kotlin in `tula-auth-ui`, both hand a composable its `content` as data
(`TulaAuthContent`, `TulaAccountContent`) and take every press through `perform(action)`,
which does nothing for an action the open screen does not offer. `tula-auth-compose` gained
`TulaAccount` and the parts both screens are drawn from (`TulaParts.kt`); it still decides
nothing.

The mapping from the client's `FlowScreen` to a screen still has no `else`. A second step, an
enrolment and a step that offers only a texted code now have screens; a step that offers only
ways this client cannot take here is still "not supported", in words.

### A way to sign in is drawn only where this client can take it, and that is known before the first frame

A passkey button, Google's button and a provider's button are offered where the environment's
configuration lists the method **and** `client.sheets` says the client was given what it
needs: a passkey sheet, Google's sheet, or a browser session together with a `redirectUrl`
(`TulaAuth`'s new parameter). A way that fails either test is not in the content at all.

`@tula/react` has to ask the browser after mount and so draws a passkey link one commit late.
Here both facts exist before anything is drawn (the sheets when the client is made, the
configuration before the first screen offers a way), so a control is never drawn and then
taken away. What this does **not** know is whether the device can show the sheet: a client
given `CredentialManagerPasskeySheet` on a device with no credential provider offers the
button, and the sheet's failure is then said in words. Asking Credential Manager at start was
not built; no device was at hand to see what it answers.

Where a method is the only one and this client cannot take it, the screen says so
(`ways.noWayHere`) instead of drawing a form that can only fail. Where a passkey is the only
second step it is the screen's main button, with its sentence.

### A closed sheet is a notice; one sheet at a time

A passkey sheet, Google's chooser or a provider's page that was closed is `notice` (its own
text style and tag, a live region that is polite): never the form's problem and never a
success. Nothing was sent to prove anything, nobody is signed in, and the button works again.
A sheet that failed and a passkey the server refused are problems, each in its own words.
While another sheet of the client is out the client answers `flow.busy`, and the screen says
that as a notice too (`sheetBusy`): the model starts no second ceremony and queues none.

### Nothing is texted by arriving, and the code field is filled by the keyboard, not by the app

A texted code, as a first factor and as a second step, is asked for with a button; the code
field is there only after a send of that screen succeeded, and the words never claim a
message was sent to a first-factor number ("if you can sign in with this number…"). A
refusal an operator's setting causes takes the button away and leaves the sentence.

The code field's content type is `ContentType.SmsOtpCode`, which lets the keyboard or the
autofill service offer the code it saw arrive. **The library asks for no SMS permission and
does not use the SMS Retriever or User Consent APIs**: those need Google Play services'
`play-services-auth-api-phone`, and the Retriever needs an app hash in the message's text,
which the server's template has no place for (ADR 0042 gives the last line to the
origin-bound `@host #code` form). Adding either is a decision of its own.

### A setup key, its QR code and backup codes exist only while their screen is open

They are fields of the model's state, set when the server answers and emptied when the screen
is left: by the next screen, by `close()`, and by a late answer that arrives after the screen
went (which shows no key and no codes). The content is built again from the state at each
draw and is not remembered. Nothing of them is in `rememberSaveable`, a `SavedStateHandle` or
a `Bundle`, and the state and the model print as their type's name. The cost is ADR 0061's,
and sharper here: an activity that is made again while backup codes are shown loses them, and
they are not shown a second time (new ones can be made from the account screen).

**The QR code is drawn by the library's own encoder** (`TulaQr.kt`), a Kotlin port of
`packages/react/src/qr`. No dependency was added. The two are held together by one corpus,
`packages/react/src/qr/qr-cases.json` (texts with the matrices the TypeScript encoder makes),
read by the TypeScript test and by the Kotlin one: a change to either encoder keeps both
tests green, and a verdict in the corpus is never edited to make one side pass. It is drawn
dark on white whatever the theme, with a four-module quiet zone, and is read to a screen
reader as a sentence that points to the setup key. **No test scanned it with a camera or
decoded it from the screen**; the corpus is what says the modules are right.

### A copy is made on a press, and marked sensitive; the library does not clear the clipboard

The setup key and the backup codes each have a "Copy" control. Nothing is copied otherwise.
The clip is made by `tulaSensitiveCopy(context)` with `ClipDescription.EXTRA_IS_SENSITIVE`
(written by its string, so that it is set below API 33 too, where nothing reads it).

What Android does with that, and what it does not:

- From Android 13 the system hides a sensitive clip's content in the clipboard preview, and
  clears the clipboard by itself some time after the copy. Neither is this library's doing or
  under its control, and below Android 13 neither happens.
- **The library never clears the clipboard.** It cannot know that what is there later is
  still its own clip, and clearing would take whatever the person copied since.
- A keyboard or another app with clipboard access can read the clip while it is there.

So a copy leaves the secret where the library cannot take it back, and the screens say only
"Copied.". An app that wants no copy at all gives the model a `copy` that does nothing.

### Backup codes inside a sign-in: the screens stay until `onSignedIn`

Where an authenticator is set up inside a sign-in, the server completes the sign-in when the
code is taken. The client is signed in from then, and the backup codes are still to be shown.
The model shows them and calls `onSignedIn` only when the person said they saved them.

**An app must keep `TulaAuth` until `onSignedIn`, not until `client.state` says signed in.**
The example swapped on the client's state, and the emulator test of this path failed: the
account screen replaced the codes before they were drawn. The example now keeps the sign-in
screens until the callback, and the samples in the KDoc and `docs/kotlin.md` say so.
`@tula/react` avoids the trap by having its provider own that dialog; a composable has no
provider, so here it is a rule the app follows. A wrapper that owns both screens was not
built: where an app goes after a sign-in is the app's (ADR 0061).

### The account screen

One screen, `TulaAccount`, whose overview is sections (profile, password, phone number,
sessions, two-step verification, passkeys), each read by its own request so that one that
failed says so and offers to be read again while the others stand. A change opens a form in
place of the overview (a password change, an authenticator's setup, backup codes, a phone
number and its code, a question before something is removed).

- **Sessions.** The one this client holds is marked "This device"; one whose `deviceBound`
  is true is marked "Bound to a device key", in those words. No string says a device is
  trusted or verified, and a test of the string tables fails for one that does. One other
  session, and all others, can be ended; neither asks for a recent authentication
  (ADR 0043).
- **Two-step verification.** An authenticator is turned on (key, QR code, code, backup
  codes) and off, backup codes are made again, and a texted code is switched on and off where
  the server says it is available. A texted code that is dormant beside a stronger factor is
  said to be so.
- **Passkeys.** Listed, added through the client's passkey sheet and removed after a
  question. **A passkey cannot be renamed here, and the screen says so**: the client has no
  call for it (`HttpURLConnection` sends no `PATCH`; TULA-76). Without a passkey sheet no
  "Add" is drawn and that is said in words.
- **Phone number.** Added (a number, then the texted code), and removed after a question.
- **Sign-out.** See below.

Not on the screen: connected provider accounts, an address for an account without one, a
change of address and the deletion of the account. The client has calls for the first two;
each is a screen of its own to decide.

### "Confirm it is you" is drawn from what the server answered, and then the act goes on

When a call is answered `auth.step_up_required`, the model opens the step-up form for the
first of `params.methods` it has a form for (a password, an authenticator's code, a backup
code, an emailed code, a texted code, a passkey), with links to the others. The methods are
the server's: the model never decides which calls need one or what an account may step up
with. An emailed and a texted code are asked for with a button. With no method the screen
says to sign out and sign in again and offers nothing that could only be refused.

After a step-up that went through, the screen goes back to where it was asked from. **The act
that was refused is then carried out, once, without being pressed again** (turning an
authenticator on, new backup codes, adding or removing a passkey, a phone number, which is
not a secret and is sent again as it was typed). **A password change is the exception**: its
passwords were emptied as they were sent and are held nowhere, so its form is shown again,
empty, with a sentence that says to go on. The step-up's own call answered
`auth.step_up_required` opens no second form: it is said as "sign out and sign in again".
Leaving the form says "Nothing was changed.". A wrong guess is said at its field, and the
server's lockout as its wait.

### A failed sign-out is not a sign-out

`session.signOut()` signs the client out locally and throws when the server could not be
told. The account screen then says the session may still be active on this device, offers the
sign-out again (the client presents the token it could not revoke), and does **not** call
`onSignedOut`. The client's state says signed out by then, so an app keeps `TulaAccount`
until `onSignedOut`, as it keeps `TulaAuth` until `onSignedIn`. The example does.

### Words, errors and accessibility are ADR 0061's

Every string is in `TulaStrings` (three nested tables were added: the ways, the second step,
the account). A failed call is said by its code; of a server's `params` only a number or a
boolean fills a placeholder (a wait, a count), and a masked destination is the one string
taken from an answer's body, as the React screens take it. A problem is under its field, in
the field's `error` semantics and in one live region; the focus goes to the title on a change
of screen or form and to the first field with a problem on a failure; every control is at
least 48 dp both ways and shows its focus; a mark of a row ("This device") is text.

### Tests

- **The model** (`tula-auth-ui/src/test`, on the JVM, part of `bun run native:kotlin:test`
  with Kover's 90% bound): `WaysAndSecondStepTest`, `AccountTest`, `QrTest`, on a scripted
  HTTP engine and fake sheets.
- **The client** (`tula-auth/src/test`): `AccountTest` for the new calls, and the journeys
  that were `not_built`.
- **The screens** (`examples/compose/src/androidTest`, by hand:
  `bun run native/android/fixture/ui-tests.ts`): `AccountScreensTest` on one emulator
  against the real API. The second step with an authenticator's code (wrong, then right) and
  with a backup code; an authenticator set up inside a sign-in; the account's sessions with
  another one ended; an authenticator turned on from the account; a step-up by password after
  the server's clock was moved past ten minutes; a sign-out.
- **A passkey sheet cannot be driven by a test.** One UI test gives the example a scripted
  sheet that is closed (`ExampleSheets`, a seam in the example and not in the library) and
  reads what the screen says. The request for the challenge is the real API's; the sheet is
  not Credential Manager's. No UI test covers Google's chooser, a provider's page, a texted
  code or a phone number: those are the model's tests.

CI is unchanged: `kotlin` runs the JVM tests, `kotlin-android` compiles and lints the Android
modules, the example and its UI tests, and no job starts an emulator.

## Consequences

- An Android app has screens for every step the client has a call for, and an account
  screen, with no dependency beyond ADR 0061's.
- Two rules are now the app's to follow and are easy to miss: keep `TulaAuth` until
  `onSignedIn`, and `TulaAccount` until `onSignedOut`.
- A provider in the browser needs the app's manifest and activity to be wired
  (`CustomTabsBrowserSession`, ADR 0054). The example wires none, so its screens offer no
  such provider unless a test scripts one.
- The QR encoder exists twice (TypeScript, Kotlin), held together by a corpus.

## Not verified

- Nothing ran on a device. The UI tests ran on one emulator image.
- No test turned TalkBack on, and no accessibility checker ran: the UI tests read the
  semantics tree.
- No passkey sheet, no Google account chooser and no browser was opened, on a device or an
  emulator. `ContentType.SmsOtpCode` was set and no message was received: whether a keyboard
  offers a code was not seen.
- No copy was read back from a clipboard, and nothing of Android's handling of a sensitive
  clip was observed; what is said of it above is Android's documentation.
- The QR code was not scanned.

## Not decided here

- Renaming a passkey and an emailed link in the Kotlin client: TULA-76.
- Connected provider accounts, an address for an account without one and account deletion
  on the account screen.
- The SMS Retriever or User Consent API.
- Asking the device whether it can show a passkey sheet before the button is drawn.
- Running the UI tests in a workflow (ADR 0061).
