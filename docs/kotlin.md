# Kotlin

The Kotlin client puts Tula into an Android app. The client itself is a **library with no
UI**: it signs a user up and in (with a password, a code, a passkey, Google's ID token or a
provider's page in the browser), asks for the second step, resets a password, and keeps and
refreshes the session, bound to a key the device keeps where the app passes a key store, and
it tells your screens which one the server is asking for. Beside it are **Compose screens**
for a sign-in, a sign-up and a password reset, for an app that does not want to draw its own
([Screens](#screens), below); they draw less than the client can do. The reasoning is in
[ADR 0054](adr/0054-kotlin-client.md) and [ADR 0061](adr/0061-compose-screens.md).

> **The screens ran on one emulator; nothing ran on a device.** The client is plain Kotlin
> and is tested on a JVM, against the real API, in CI, with a software authenticator, a
> scripted browser and a software key in the places of Credential Manager, a Custom Tab and
> the Keystore. The Compose screens, with the client and the Keystore-backed storage under
> them, were run by the example app's UI tests on one Android emulator, by hand; nothing
> ran on a phone, TalkBack was never turned on, and no test read a stored token back. The
> other Android adapters (the passkey sheet, Google's sheet, the browser session, the
> Keystore device key) are compiled and linted and have never run, on a device or an
> emulator. **No passkey sheet, no Google sheet and no browser has been opened by this
> library, and no key was made in a phone's Keystore or StrongBox.** Nothing is published
> to a Maven repository, and the names (`dev.tula:tula-auth`) are placeholders.
> What was not verified:
> [the client](plans/phase-2-unverified.md#step-215-the-kotlin-client-tula-38-adr-0054),
> [passkeys, providers and the device key](plans/phase-2-unverified.md#step-215-the-kotlin-client-passkeys-providers-and-a-device-key-tula-57-adr-0054),
> [the screens](plans/phase-2-unverified.md#step-215-the-compose-screens-tula-50-adr-0061).

## What this version does

| | |
| --- | --- |
| Sign-up | An address and a password (or no password, where the environment allows it), then the emailed code. |
| Sign-in | A password, an emailed code, a texted code to a phone number, a passkey, Google's ID token, or a provider's page in the browser. |
| The second step | An authenticator app's code, a backup code, a passkey or a texted code; enrolling an authenticator inside a sign-in where the environment requires one. |
| Password reset | The emailed code and the new password together. |
| An expired password | The new password, as the last step of the sign-in. |
| Session | Kept in the Android Keystore's care, refreshed when needed, ended by sign-out; bound to a device key where the app passes a key store. |
| The signed-in user | Step-up, the authenticator app and backup codes, a texted code as the second step, passkeys (list, add, remove), connected provider accounts, a password change, the session list. |

Not yet: an emailed link (the code in the same email is the way) and renaming a passkey
(both TULA-76: the rename is a `PATCH`, which the default HTTP engine cannot send), and a
phone number on the account (TULA-61). A step that offers only a way this
version cannot do is reported as "not supported" (below), never as an error.

**The Compose screens draw less than the client can do.** They have a form for a password,
an emailed code, a sign-up, a reset and the replacement of an expired password. The second
step and the enrolment of an authenticator, a passkey, Google and the other providers, a
texted code and the account's screens are not drawn yet (TULA-61): a step that needs one
of them opens the screens' "not supported", and an app that offers them draws its own
screen on the client.

## Two modules

| Module | What it holds | Needs |
| --- | --- | --- |
| `tula-auth` | `TulaClient`, the flows, `TokenStorage`, the four interfaces to the system (`PasskeySheet`, `GoogleSheet`, `BrowserSession`, `DeviceKeyStore`), the generated types. | Kotlin, `kotlinx.serialization`, `kotlinx.coroutines`. |
| `tula-auth-android` | `KeystoreTokenStorage`, `CredentialManagerPasskeySheet`, `CredentialManagerGoogleSheet`, `CustomTabsBrowserSession`, `KeystoreDeviceKeyStore`. | Android, API 28 (Android 9) or later; `androidx.credentials` (with `credentials-play-services-auth`) and Google's `googleid`. |
| `tula-auth-ui` | What the screens decide: `TulaAuthModel`, `TulaStrings`, the theme. No Compose and nothing of Android. | `tula-auth`. |
| `tula-auth-compose` | What draws them: `TulaAuth`, `TulaAuthSlots`. | `tula-auth-ui`, Compose's `ui` and `foundation` (no Material), API 28 or later. |

Two for the client, two for the screens. All of the client's logic is in `tula-auth` and is
what the tests run; `tula-auth-android` is the thin part that touches Android, one class per
interface. An app that draws its own screens takes the first two and nothing of Compose.

## Creating the client

One client for the life of the process, with the environment's **publishable** key:

```kotlin
val tula = TulaClient(
    publishableKey = "tula_pk_…",
    baseUrl = "https://auth.example.com",
    storage = KeystoreTokenStorage(applicationContext),
)

// Once, at start: restores the session the storage holds.
val state = tula.load()
```

`tula.state` is a `StateFlow<AuthState>`: `Loading` until `load()` or a sign-in has
finished, then `SignedOut` or `SignedIn` (with the session's id and the user).

`storage` has no default. `KeystoreTokenStorage` is the one for a device;
`MemoryTokenStorage` forgets the session when the process ends and is for tests.

The four ways that need the system are **off unless the app passes one**: `passkeys`,
`google`, `browser` and `deviceKeys` are `null` by default. A client without a sheet shows
none, and a client without a key store binds no session.

```kotlin
val front = { currentActivity }            // your app's own way to the activity in front
val browser = CustomTabsBrowserSession(front)
val tula = TulaClient(
    publishableKey = "tula_pk_…",
    baseUrl = "https://auth.example.com",
    storage = KeystoreTokenStorage(applicationContext),
    passkeys = CredentialManagerPasskeySheet(front),
    google = CredentialManagerGoogleSheet(serverClientId = "….apps.googleusercontent.com", activity = front),
    browser = browser,
    deviceKeys = KeystoreDeviceKeyStore(),
)
```

## A flow, step by step

Every flow returns the server's next step. `flow.screen` says which screen that is.

```kotlin
val flow = tula.signIn("maya@example.com")
when (flow.screen) {
    FlowScreen.NEEDS_PASSWORD -> flow.submitPassword(password)
    FlowScreen.NEEDS_FIRST_FACTOR -> {
        flow.prepareFirstFactor(CodeStrategy.EMAIL_CODE)      // sends the code
        flow.attemptFirstFactor(CodeStrategy.EMAIL_CODE, code)
    }
    FlowScreen.NEEDS_EMAIL_VERIFICATION -> flow.verifyEmail(code)
    FlowScreen.NEEDS_NEW_PASSWORD -> flow.submitNewPassword(newPassword)
    FlowScreen.COMPLETE -> Unit                               // tula.state is SignedIn
    FlowScreen.NOT_SUPPORTED -> Unit                          // say so, in words
}
```

`tula.signUp(email, password, firstName, lastName)` and `tula.resetPassword(email)` work the
same way (`verifyEmail`, `resendCode`, `submit(code, password)`).

- **`NOT_SUPPORTED` is a screen, not an error.** It is what a step this version has no
  action for looks like: a status from a newer server, or one that offers only ways this
  version cannot do. The step itself is kept as it was sent (`FlowStep.Unknown` holds the
  whole object). Tell the user this version of the app cannot continue; never draw a blank
  screen.
- **Leave a flow with `flow.discard()`.** It forgets the attempt, and an answer still on its
  way signs nobody in.
- **One action at a time.** A second call while one is running is refused with `flow.busy`.

## Errors

Every failure is a `TulaError` with a stable `code` (the contract's, such as
`auth.invalid_credentials`, or the client's own: `network.failed`, `network.timeout`,
`response.invalid`, `storage.failed`, `flow.busy`, `flow.invalid_step`, `passkey.unsupported`,
`passkey.already_on_device`, `passkey.failed`, `provider.unsupported`, `provider.failed`,
`device.key_failed`), a `message` for
that code, the HTTP `status`, `params`, the field `errors` of a validation failure and
`retryAfterMs` for a rate limit. Pass `messages` to the constructor to say them in your
app's words.

A `TulaError` holds nothing of the platform's own exception: no `cause`, none of its text.
Android writes an exception to the log with its whole chain, and a network exception can
name the address it was asked for. The `code` says what failed; if your app needs the
platform's reason, it has it in its own `HttpEngine` or `TokenStorage`.

## The session

```kotlin
val token = tula.session.getToken()   // refreshed first when it is about to expire
tula.session.signOut()
```

- **Calls made at once share one refresh.**
- **A refresh that gets no answer is repeated once**, at once. If that fails too,
  `getToken()` throws `network.failed` and **the session is kept**: the user is still
  signed in, and the next call tries again.
- **Only the server ends a session.** Offline, a timeout, a 5xx and a storage failure never
  sign the user out.
- **A failed sign-out is not a sign-out.** `signOut()` forgets the session on the device
  and throws when the server could not be told: the session may still be alive there. Leave
  the signed-in screen only after a `signOut()` that returned; offer "try again" otherwise
  (calling it again tells the server).

## The second step, and step-up

A sign-in of a user with two-step verification stops at `FlowScreen.NEEDS_SECOND_FACTOR`;
`flow.step` lists what the user can prove it with.

```kotlin
flow.submitTotp(code)                        // the authenticator app's code
flow.submitBackupCode(code)                  // .remaining says how many are left
flow.submitSecondFactorWithPasskey()         // shows the passkey sheet
flow.prepareSmsCode(); flow.submitSmsCode(code)
```

Where the environment requires a second step and the user has none, the step is
`NEEDS_FACTOR_ENROLMENT`: `flow.startTotpEnrolment()` gives the setup key and
`flow.confirmTotpEnrolment(code)` the backup codes, once. Show them before you leave the
screen; the client does not keep them.

A change to how an account is protected needs a recent sign-in. The server says so with
`auth.step_up_required`, and `error.stepUpMethods` lists what this user may step up with:

```kotlin
tula.stepUp.withPassword(password)
tula.stepUp.withTotp(code)                   // or withBackupCode(code)
tula.stepUp.withPasskey()
tula.stepUp.sendEmailCode(); tula.stepUp.withEmailCode(code)
```

Then repeat the call. A user who has a second factor steps up with it, never with the
password or an emailed code alone. A wrong code is the server's error and is counted there;
the session stays.

`tula.factors` (the authenticator app, backup codes, a texted code as the second step),
`tula.passkeys`, `tula.identities`, `tula.changePassword(…)` and `tula.sessions()` are the
signed-in user's own calls.

An account made by a provider that gives no address (X, Facebook) has no email address.
Its user gives it one with `tula.emailAddress.request(address)`, which emails a code and
answers where it went (masked) and when it expires, and `tula.emailAddress.verify(code)`,
which answers the user with the address on it; the client's state then shows it. Both need
a recent sign-in, an account that already has an address is answered `email.already_set`,
and an address another account holds is answered like a free one and confirms nothing.

## Passkeys

```kotlin
when (val result = tula.signInWithPasskey()) {
    is TulaCeremony.Finished -> result.value.screen   // a flow, usually COMPLETE
    TulaCeremony.Dismissed -> Unit                    // the user put the sheet away
}
tula.passkeys.add(name = "Pixel")                     // signed in, after a step-up
```

- **A dismissed sheet is a value**, `TulaCeremony.Dismissed`: not an error and not a
  sign-in. Nothing was sent to prove anything, and the same call works again. With
  `CredentialManagerSheets` only Credential Manager's own cancellation
  (`GetCredentialCancellationException`, `CreateCredentialCancellationException`) is a
  dismissal. A WebAuthn `NotAllowedError` is `passkey.failed`: the specification uses it
  for a cancel and for other refusals alike, and no device has shown this package which
  one Android means by it. The cost, if a device reports a plain cancel that way: an
  error is shown where a dismissal would have been.
- **One sheet at a time for the whole client.** A second passkey, Google or browser call
  while one is up is refused with `flow.busy` before any request. A sheet that never answers
  gives its place back after five minutes (a challenge's lifetime) as a dismissal, and what
  it says later is used by nobody.
- **Nothing of a ceremony is kept**: not the options, not the credential, and nothing of the
  system's own exception. A sheet's failure is one of `passkey.unsupported`,
  `passkey.already_on_device` and `passkey.failed`.
- **The server accepts an Android app's passkey only from an app the operator registered**
  (the package name and the SHA-256 fingerprint of its signing certificate), and Android
  offers a passkey of your domain only to an app that domain's `assetlinks.json` names:
  [native apps](native-apps.md). An unregistered app's sign-in fails like an unknown
  passkey, with `auth.invalid_credentials`.

## Sign in with Google

```kotlin
tula.signInWithGoogle()        // TulaCeremony<SignInFlow>: starts, shows Google's sheet, exchanges
```

The server makes a nonce, Google's sheet is given it as it is, and the ID token it answers
is exchanged once and kept nowhere. An attempt takes one token, right or wrong. To show the
sheet yourself, `tula.startIdTokenSignIn()` gives the nonce and `exchange(idToken)` finishes.

The token's audience has to be a client id the environment's Google provider has: its own
client id or one of its additional client ids. Every token the server does not accept is
`auth.invalid_credentials`.

Sign in with Apple and every other provider go through the browser on Android.

## A provider in the browser

```kotlin
when (val outcome = tula.signIn(OAuthProvider.Github, redirectUrl = "https://app.example.com/oauth")) {
    is ProviderOutcome.SignedIn -> Unit
    is ProviderOutcome.NeedsStep -> outcome.flow          // the second step, usually
    ProviderOutcome.Cancelled -> Unit                     // the user closed the browser
    is ProviderOutcome.Refused -> outcome.refusal         // why nothing was exchanged
    is ProviderOutcome.Linked -> Unit                     // only from tula.identities.link
}
```

The redirect URL is an entry of the environment's allowed redirect URLs, matched there
exactly: an **app link** (`https`) for any provider, or a **custom scheme** for a provider
that sends PKCE (not Apple, LinkedIn or Facebook, which the server refuses with
`request.redirect_not_allowed` and a reason before a browser is opened). The client never
judges the URL; the server's refusal is thrown as it is.

With `CustomTabsBrowserSession`, the activity your manifest opens for the redirect hands
the intent over, and the activity that asked says when it is in front again:

```kotlin
override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); browser.returned(intent) }
override fun onResume() { super.onResume(); browser.resumed() }   // closed with no redirect: cancelled
```

`returned(intent)` answers `true` only when it took the intent: one is being waited for,
and the intent's address starts with the redirect URL that was opened, character for
character, followed by `#`. For anything else (another link of your app, the same address
with a trailing slash or in another case, an address with no fragment) it answers `false`
and leaves the wait as it is, so hand it every intent and handle the ones it did not take
yourself. A return with no fragment is therefore not an answer: the wait ends as cancelled
at `resumed()`. The client still judges the whole address it is handed.

- **What the browser returns is read only when it is the redirect URL that was asked for,
  character for character, followed by `#`.** Anything else, a return with no answer, and a
  ticket for a sign-in this client did not start are refused without a request: Android
  opens an app with whatever matches its filter, and anybody can open an app with a URL.
- **The round trip is kept in memory and nowhere else**, and only a ticket whose exchange
  got no answer is kept at all, for at most a minute: `tula.retryProviderSignIn()` tries it
  again, `tula.discardProviderSignIn()` lets it go. If the process is ended while the
  browser is open, the sign-in is over and the user starts again.
- `tula.identities.link(provider, redirectUrl)` connects a provider account to the signed-in
  user the same way. It is a `web` attempt to the server, so its redirect URL is an app
  link, never a custom scheme.

## A session bound to a device key

With `deviceKeys`, a sign-in carries a proof signed by a key the device keeps, the session
is bound to that key, and every refresh carries a new proof. A copy of the stored refresh
token is of no use on another device.

- **The key is found, or made, when a sign-in starts.** Whether a sign-in may or must bring
  one is the environment's session profile: `device.binding_required` and
  `device.binding_not_supported` are the server's answers and are thrown as they are.
- **A refused proof does not sign the user out.** `device.proof_invalid` and every other
  `device.*` answer keep the session, with one exception: when the server refuses a
  refresh's proof **and** the key store, asked twice, says both times that it has no key,
  the key is gone and so is the session. It is ended on the device and the server is told.
- **A key that could not be had is never read as gone.** A store that throws is
  `device.key_failed`, one that never answers is `network.timeout`, and both keep the
  session; nothing is sent without the proof.
- **A refused proof can take about three refresh timeouts to answer.** After
  `device.proof_invalid` the client asks the key store twice (one refresh timeout at
  most), and where the key is gone removes the stored token (one more) and tells the
  server (one more): about 24 seconds at the default of 8, all inside the one shared
  refresh, so every call waiting for a token waits that long. The three are not given one
  budget on purpose: a shorter one would be taken from the sign-out, and the server would
  be told less often that the session ended. Only a store or a server that does not
  answer comes near it.
- **Sign-out sends no proof**, so a device that lost its key can still end its session.
- `KeystoreDeviceKeyStore` asks the Android Keystore for a P-256 signing key, StrongBox
  first and the Keystore's default where the device has none. The Keystore has no call that
  exports a private key it made. Which of the two a device used is not recorded. On a JVM
  (`SoftwareDeviceKeyStore`, for tests) the key is a software key in memory.
- A reinstalled app has a new key and is a new device to the server. `tula.removeDeviceKey()`
  removes the key; call it only after a sign-out.

## Where the token is kept

`KeystoreTokenStorage` encrypts the refresh token with a key the Android Keystore generates
and never hands out, and keeps only the ciphertext, in a private preferences file. Nothing
readable is written to preferences, a file, a log or a URL.

- **A stored value whose key is gone is no token.** The entry is removed and the user signs
  in again. The same holds for an entry the storage did not write.
- **A stored value that does not open while the key exists is a failure, not "no token".**
  The client says `storage.failed`, deletes nothing and keeps the session it has. A
  Keystore that answers wrongly once must not cost the user their session. Such an entry
  goes when the user signs out or signs in again; until then every start of the app says
  `storage.failed` and shows nobody as signed in.
- A Keystore or a preferences file that fails in any other way is not a sign-out either:
  the client says `storage.failed` and keeps the session while the app runs. A token the
  server has since replaced may then be what is stored, so an app ended in that state can
  find itself signed out at its next start.
- **A key the Keystore can no longer load is replaced the next time a token is saved**,
  and only then: the old key is deleted and a new one made, because the token being saved
  is the only thing kept under it. Reading never replaces or deletes anything. If the save
  that follows fails, the entry saved before stays and does not open: `storage.failed` at
  a start, until the next save that succeeds or a sign-out. None of this has run on a
  device.
- **A storage call that never returns is `storage.failed` too**, after the time a refresh is
  given (8 seconds at most): the session is kept, `load()` leaves the state `Loading`, and a
  sign-out does not wait for it without end. The stuck call is not stopped; it is no longer
  waited for.
- The key asks for no fingerprint or PIN: a refresh happens in the background.

### Keep the file out of backups

Android's Auto Backup and its device-to-device transfer copy an app's preferences files
unless the app says otherwise, and the file of sealed tokens is one of them
(`dev.tula.auth.tokens`, unless the app names another). The key never leaves the device, so
the copy is of no use on another one. Exclude the file. Both rule files are needed: the
first is read by Android 12 and later, the second by Android 11 and earlier.

`res/xml/data_extraction_rules.xml`:

```xml
<data-extraction-rules>
    <cloud-backup>
        <exclude domain="sharedpref" path="dev.tula.auth.tokens.xml" />
    </cloud-backup>
    <device-transfer>
        <exclude domain="sharedpref" path="dev.tula.auth.tokens.xml" />
    </device-transfer>
</data-extraction-rules>
```

`res/xml/backup_rules.xml`:

```xml
<full-backup-content>
    <exclude domain="sharedpref" path="dev.tula.auth.tokens.xml" />
</full-backup-content>
```

And on the `<application>` element of the manifest:
`android:dataExtractionRules="@xml/data_extraction_rules"` and
`android:fullBackupContent="@xml/backup_rules"`. An app that passes its own
`preferencesName` writes that name, with `.xml`, in the three places.

**After a restore or a transfer the user is signed out, by design**: with the rules the
file is not copied, and without them the copy has no key on the new device and is read as
no token. Neither was tried on a device
([what was not verified](plans/phase-2-unverified.md#step-215-the-kotlin-client-tula-38-adr-0054)).

## Requests

The client sends its requests with the platform's own `HttpURLConnection`, so the library
adds no HTTP dependency. That was tested on a desktop JVM only. Android's class of that
name is a different implementation, and one case is worth trying on a device before an app
relies on it: the API refuses a sign-in, and ends a session, with a `401` that carries no
`WWW-Authenticate` header, and the client needs that answer's status and body. If Android's
connection does not hand them over, a wrong password reads as `network.failed` and a
session the server ended is never seen as ended.

An app that would rather not depend on that passes an engine of its own:
`TulaClient(…, http = …)` takes an `HttpEngine`, which is one `suspend` function from a
request to an answer. Over OkHttp it follows no redirect, keeps no cookie, and hands back
every status with its body, a `401` included.

## Screens

`TulaAuth` is one composable that draws whichever screen the server asks for: the sign-in
(a password or an emailed code), the sign-up, the emailed code that proves an address, the
password reset and the replacement of an expired password. A step it has no form for (a
second factor, a passkey, a provider, a texted code, a step this version does not know) is
a "not supported" screen with a way back to the start, never a blank one.

```kotlin
setContent {
    TulaAuth(
        client = client,
        onSignedIn = { /* show your app */ },
    )
}
```

`mode = TulaAuthMode.SIGN_UP` opens on the sign-up. **Where the user goes after signing in
is your callback and nothing else**: the screens read no destination from the server, a
link or an intent. The session is the client's (`client.session`); the screens hold no
token.

### What is kept, and what a rotation costs

A password, a code and a new password are emptied when their screen is left, when the
sign-in completes and when the composable leaves the composition. The flow that was open is
discarded then, so an answer that arrives late signs nobody in.

The screens keep their state with a plain `remember`, **never in saved instance state**
(Android writes that to disk). So an activity that is destroyed and made again, which is
what a rotation does by default, starts the screens over: the open flow is discarded and
what was typed is gone. An app that does not want that either handles the configuration
change itself (`android:configChanges` on the activity, as the example does), or holds the
model where it survives and hands it over:

```kotlin
val model = remember { TulaAuthModel(client, onSignedIn = { /* … */ }) }
TulaAuth(model = model)
// and, when the screens are left for good:
model.close()
```

Do not put a `TulaAuthModel`, or anything read from its `state`, into `rememberSaveable`, a
`SavedStateHandle` or a `Bundle`.

### Screenshots

The library sets no window flag. If your app wants the system to keep the sign-in out of
screenshots, screen recordings and the recent-apps preview, that is one line in the
activity that shows it, and it is your decision (it also blanks the screen for a user who
is being helped over a screen share):

```kotlin
window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
```

### Words

Every string the screens show or announce is a property of `TulaStrings`; the defaults are
English. Name only what you change:

```kotlin
TulaAuth(
    client = client,
    strings = TulaStrings(
        signInTitle = "Welcome back",
        errors = mapOf("auth.invalid_credentials" to "That did not match. Try again."),
    ),
    onSignedIn = { },
)
```

A failed call is said by its **code**: your sentence in `errors`, else the built-in English
sentence for a code this version knows, else `unknownError`. Text the server wrote is never
shown.

The table is Kotlin, not `strings.xml`, because what decides the screens runs without
Android (that is what lets it be tested on a JVM). The cost: **nothing follows the device's
language by itself.** A translated app builds the table from its own resources:

```kotlin
val strings = TulaStrings(
    signInTitle = stringResource(R.string.sign_in_title),
    continueButton = stringResource(R.string.continue_button),
    // … the rest of what your app translates
)
```

### Colours and sizes

`theme` takes a `TulaTheme`, the same tokens as the web components
(`TulaThemeDefaults.theme` is the default, with a light and a dark scheme; the screens
follow the system's). A value is checked before it is drawn, because a theme is often a
tenant's: one that is not a colour, a length or a typeface this version can draw is
replaced by the default's, never guessed at.

### Your own parts

Three parts of every screen can be replaced, each a composable lambda of `TulaAuthSlots`:
`header` (the title and what is under it), `primaryButton` and `footer`.

```kotlin
TulaAuth(
    client = client,
    slots = TulaAuthSlots(
        footer = { footer -> BasicText("Acme · ${footer.text}") },
    ),
    onSignedIn = { },
)
```

A header slot is handed `titleModifier` and a button slot `modifier`: put them on the title
and the button you draw. They are what makes the title a heading a screen reader is moved
to when the step changes. Fields, links and error messages are not replaceable: a field's
label and its error are what make the screens usable with TalkBack.

### Accessibility

Every field has a visible label and the same words for a screen reader; a problem is said
in words under its field ("Error: …"), is the field's error for a screen reader (and not
a second time in its label), and is announced; when the step changes the focus is asked to
the new title, and after a failure to the first field with a problem; a field, a link and
a button are at least 48 dp high, a link and the button that shows a password at least
48 dp wide too; the main button, the links and that button have an edge in the theme's
focus colour while they have the focus (a `primaryButton` slot of your own draws its own);
sizes follow the system's font scale. **This was checked against the semantics tree in UI tests and never
with TalkBack switched on.**

### The example and its UI tests

[`examples/compose`](../examples/compose/README.md) is an app whose sign-in is `TulaAuth`.
Its UI tests run the screens on an emulator or a device against the real API on your
machine:

```bash
bun run native/android/fixture/ui-tests.ts --avd <name of an emulator>
```

The script refuses a device that is not an emulator unless it is given `--allow-physical`:
`adb reverse` puts the API's port on the device's own loopback address, where every app
installed on a phone can reach it. They are run by hand: no workflow starts an emulator. CI compiles and lints the screens,
the example and the tests.

## Running its tests

```bash
bun run native:kotlin:test
```

It starts the real API on this machine and runs the tests and the coverage check of the
client and of what the screens decide (`tula-auth`, `tula-auth-ui`) against it. It needs a JDK (17 or later); the Gradle wrapper downloads Gradle and the
pinned dependencies. More in [`native/android/README.md`](../native/android/README.md).
