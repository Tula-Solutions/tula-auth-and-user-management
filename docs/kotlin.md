# Kotlin

The Kotlin client puts Tula into an Android app. The client itself is a **library with no
UI**: it signs a user up and in (with a password, a code, a passkey, Google's ID token or a
provider's page in the browser), asks for the second step, resets a password, and keeps and
refreshes the session, bound to a key the device keeps where the app passes a key store, and
it tells your screens which one the server is asking for. Beside it are **Compose screens**
for a sign-in, a sign-up, a password reset and the signed-in user's account, for an app that
does not want to draw its own ([Screens](#screens), below). The reasoning is in
[ADR 0054](adr/0054-kotlin-client.md), [ADR 0061](adr/0061-compose-screens.md) and
[ADR 0062](adr/0062-compose-second-step-and-account.md).

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
> [the screens](plans/phase-2-unverified.md#step-215-the-compose-screens-tula-50-adr-0061),
> [the second step, the other ways and the account](plans/phase-2-unverified.md#step-215-the-compose-screens-the-second-step-the-other-ways-and-the-account-tula-61-adr-0062).

## What this version does

| | |
| --- | --- |
| Sign-up | An address and a password (or no password, where the environment allows it), then the emailed code. |
| Sign-in | A password, an emailed code, a texted code to a phone number, a passkey, Google's ID token, or a provider's page in the browser. |
| The second step | An authenticator app's code, a backup code, a passkey or a texted code; enrolling an authenticator inside a sign-in where the environment requires one. |
| Password reset | The emailed code and the new password together. |
| An expired password | The new password, as the last step of the sign-in. |
| Session | Kept in the Android Keystore's care, refreshed when needed, ended by sign-out; bound to a device key where the app passes a key store. |
| The signed-in user | Step-up, the authenticator app and backup codes, a texted code as the second step, passkeys (list, add, remove), a phone number (add, prove, remove), connected provider accounts, a password change, the session list, ending one session or all the others. |
| Organizations | The user's organizations, creating, renaming, leaving or deleting one, the active organization and its claims, its members and roles, its domains, an invitation (preview, accept, decline), the organizations a verified address is offered. |

Not yet: an emailed link (the code in the same email is the way) and renaming a passkey
(both TULA-76: the rename is a `PATCH`, which the default HTTP engine cannot send). A step
that offers only a way this version cannot do is reported as "not supported" (below), never
as an error.

**The Compose screens** ([Screens](#screens)) draw every step above and an account screen.
What the account screen leaves out: connected provider accounts, an address for an account
that has none, and renaming a passkey (which the client cannot do either).

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

To start from a project that already has the stack and an app, see [the native path of the
quickstart](quickstart.md#the-native-path) (`create-tula --framework compose`). An emulator
needs no account; a passkey, Sign in with Google and an app link each need a signing
certificate, a package name and, for Google, a Google Cloud project of your own, and [one
table](native-apps.md#what-needs-your-own-accounts) says which needs what.

## Creating the client

One client for the life of the process, with the environment's **publishable** key:

<!-- snippet: examples/compose/src/androidTest/kotlin/dev/tula/example/compose/DocsSnippets.kt#client -->
```kotlin
val tula = TulaClient(
    publishableKey = "tula_pk_…",
    baseUrl = "https://auth.example.com",
    storage = KeystoreTokenStorage(applicationContext),
)
```
<!-- /snippet -->

`tula.state` is a `StateFlow<AuthState>`: `Loading` until `load()` or a sign-in has
finished, then `SignedOut` or `SignedIn` (with the session's id and the user).

`storage` has no default. `KeystoreTokenStorage` is the one for a device;
`MemoryTokenStorage` forgets the session when the process ends and is for tests.

The four ways that need the system are **off unless the app passes one**: `passkeys`,
`google`, `browser` and `deviceKeys` are `null` by default. A client without a sheet shows
none, and a client without a key store binds no session.

<!-- snippet: examples/compose/src/androidTest/kotlin/dev/tula/example/compose/DocsSnippets.kt#client-sheets -->
```kotlin
val front = currentActivity // your app's own way to the activity in front
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
<!-- /snippet -->

## A flow, step by step

Every flow returns the server's next step. `flow.screen` says which screen that is.

<!-- snippet: native/android/tula-auth/src/test/kotlin/dev/tula/auth/DocsSnippets.kt#sign-in -->
```kotlin
val flow = tula.signIn("maya@example.com")
when (flow.screen) {
    FlowScreen.NEEDS_PASSWORD -> flow.submitPassword(password)
    FlowScreen.NEEDS_FIRST_FACTOR -> {
        flow.prepareFirstFactor(CodeStrategy.EMAIL_CODE) // sends the code
        flow.attemptFirstFactor(CodeStrategy.EMAIL_CODE, code)
    }
    FlowScreen.NEEDS_EMAIL_VERIFICATION -> flow.verifyEmail(code)
    FlowScreen.NEEDS_NEW_PASSWORD -> flow.submitNewPassword(newPassword)
    FlowScreen.NEEDS_SECOND_FACTOR -> flow.submitTotp(code)
    FlowScreen.NEEDS_FACTOR_ENROLMENT -> flow.startTotpEnrolment()
    FlowScreen.COMPLETE -> Unit // tula.state is SignedIn
    FlowScreen.NOT_SUPPORTED -> Unit // say so, in words
}
```
<!-- /snippet -->

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

<!-- snippet: native/android/tula-auth/src/test/kotlin/dev/tula/auth/DocsSnippets.kt#session -->
```kotlin
val token = tula.session.getToken() // refreshed first when it is about to expire
App.callBackend(token)
tula.session.signOut() // throws when the server could not be told
```
<!-- /snippet -->

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

<!-- snippet: native/android/tula-auth/src/test/kotlin/dev/tula/auth/DocsSnippets.kt#second-step -->
```kotlin
flow.submitTotp(code) // the authenticator app's code
flow.submitBackupCode(code) // .remaining says how many are left
flow.submitSecondFactorWithPasskey() // shows the passkey sheet
flow.prepareSmsCode() // nothing is texted until this is called
flow.submitSmsCode(code)
```
<!-- /snippet -->

Where the environment requires a second step and the user has none, the step is
`NEEDS_FACTOR_ENROLMENT`: `flow.startTotpEnrolment()` gives the setup key and
`flow.confirmTotpEnrolment(code)` the backup codes, once. Show them before you leave the
screen; the client does not keep them.

A change to how an account is protected needs a recent sign-in. The server says so with
`auth.step_up_required`, and `error.stepUpMethods` lists what this user may step up with:

<!-- snippet: native/android/tula-auth/src/test/kotlin/dev/tula/auth/DocsSnippets.kt#step-up -->
```kotlin
tula.stepUp.withPassword(password)
tula.stepUp.withTotp(code) // or withBackupCode(code)
tula.stepUp.withPasskey()
tula.stepUp.sendEmailCode()
tula.stepUp.withEmailCode(code)
```
<!-- /snippet -->

Then repeat the call. A user who has a second factor steps up with it, never with the
password or an emailed code alone. A wrong code is the server's error and is counted there;
the session stays.

`tula.factors` (the authenticator app, backup codes, a texted code as the second step),
`tula.passkeys`, `tula.identities`, `tula.changePassword(…)` and `tula.sessions()` are the
signed-in user's own calls. `tula.revokeSession(id)` ends one other session and
`tula.revokeOtherSessions()` all of them (it answers how many); neither needs a recent
sign-in.

A phone number is added with `tula.phone.request(number)`, which texts a code and answers
where it went (masked), and `tula.phone.verify(code)`, which answers the user with the number
on it; `tula.phone.remove()` takes it away. All three need a recent sign-in. An account has
no unproven number: nothing is stored until the code was taken.

`tula.sheets` says which of the system's sheets the client was given (a passkey sheet,
Google's, a browser session), as three booleans. It is what a screen reads to decide whether
a button can be drawn; it does not say the device can show the sheet.

An account made by a provider that gives no address (X, Facebook) has no email address.
Its user gives it one with `tula.emailAddress.request(address)`, which emails a code and
answers where it went (masked) and when it expires, and `tula.emailAddress.verify(code)`,
which answers the user with the address on it; the client's state then shows it. Both need
a recent sign-in, an account that already has an address is answered `email.already_set`,
and an address another account holds is answered like a free one and confirms nothing.

## Passkeys

<!-- snippet: native/android/tula-auth/src/test/kotlin/dev/tula/auth/DocsSnippets.kt#passkey -->
```kotlin
when (val result = tula.signInWithPasskey()) {
    is TulaCeremony.Finished -> App.proceed(result.value) // a flow, usually COMPLETE
    TulaCeremony.Dismissed -> Unit // the user put the sheet away
}
tula.passkeys.add(name = "Pixel") // signed in, after a step-up
```
<!-- /snippet -->

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

<!-- snippet: native/android/tula-auth/src/test/kotlin/dev/tula/auth/DocsSnippets.kt#google -->
```kotlin
tula.signInWithGoogle() // TulaCeremony<SignInFlow>: starts, shows Google's sheet, exchanges
```
<!-- /snippet -->

The server makes a nonce, Google's sheet is given it as it is, and the ID token it answers
is exchanged once and kept nowhere. An attempt takes one token, right or wrong. To show the
sheet yourself, `tula.startIdTokenSignIn()` gives the nonce and `exchange(idToken)` finishes.

The token's audience has to be a client id the environment's Google provider has: its own
client id or one of its additional client ids. Every token the server does not accept is
`auth.invalid_credentials`.

Sign in with Apple and every other provider go through the browser on Android.

## A provider in the browser

<!-- snippet: native/android/tula-auth/src/test/kotlin/dev/tula/auth/DocsSnippets.kt#provider -->
```kotlin
when (val outcome = tula.signIn(OAuthProvider.Github, redirectUrl = "https://app.example.com/oauth")) {
    is ProviderOutcome.SignedIn -> Unit
    is ProviderOutcome.NeedsStep -> App.proceed(outcome.flow) // the second step, usually
    ProviderOutcome.Cancelled -> Unit // the user closed the browser
    is ProviderOutcome.Refused -> App.explain(outcome.refusal) // why nothing was exchanged
    is ProviderOutcome.Linked -> Unit // only from tula.identities.link
}
```
<!-- /snippet -->

The redirect URL is an entry of the environment's allowed redirect URLs, matched there
exactly: an **app link** (`https`) for any provider, or a **custom scheme** for a provider
that sends PKCE (not Apple, LinkedIn or Facebook, which the server refuses with
`request.redirect_not_allowed` and a reason before a browser is opened). The client never
judges the URL; the server's refusal is thrown as it is.

With `CustomTabsBrowserSession`, the activity your manifest opens for the redirect hands
the intent over, and the activity that asked says when it is in front again:

<!-- snippet: examples/compose/src/androidTest/kotlin/dev/tula/example/compose/DocsSnippets.kt#activity -->
```kotlin
override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    browser.returned(intent)
}

// Closed with no redirect: cancelled.
override fun onResume() {
    super.onResume()
    browser.resumed()
}
```
<!-- /snippet -->

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

## Organizations

An environment with organizations switched on lets a user belong to several, and a session
works in one of them at a time: the **active organization**
([ADR 0065](adr/0065-organizations.md)). `tula.organizations` lists the user's
organizations, creates one where the environment lets users, and sets or clears the active
one. Setting it asks the server for a new access token that carries the organization's
claims (`org_id`, `org_role`, `org_perms`); the refresh token does not change.

<!-- snippet: native/android/tula-auth/src/test/kotlin/dev/tula/auth/DocsSnippets.kt#organizations -->
```kotlin
val page = tula.organizations.list() // each with the user's role and its permissions
if (page.data.isEmpty()) {
    val acme = tula.organizations.create(name = "Acme", slug = "acme")
    tula.organizations.setActive(acme.id) // the next access token carries the claims
}
tula.organizations.active()?.let { organization ->
    // Read from the access token, to decide what to draw: your server checks the same keys.
    if (organization.hasPermission("org:billing:read")) {
        // show the billing tab
    }
    if (organization.hasRole("admin")) {
        // show the admin tab
    }
}
tula.organizations.clearActive() // back to the personal account
```
<!-- /snippet -->

`active()` reads the claims from the access token the client holds, without checking its
signature: that is for drawing the right screen, never for deciding what a user may do.
Your server verifies the token and checks the same permission. The claims are all three or
none: a token whose organization claims do not satisfy the contract's grammar has no active
organization here, as in `@tula-tech/core`. Kotlin cannot overload on a parameter's name, so
the two checks are `hasPermission` and `hasRole` (`has(permission:)` and `has(role:)` in the
Swift client).

An invitation arrives as an emailed link whose address carries the token in its
**fragment** (`#tula_invitation=...`), which no server sees. Open it in the app (an app
link) and read it with `TulaInvitationLink`. Previewing needs no session; accepting and
declining need one, and accepting needs the address the invitation was sent to, verified.

<!-- snippet: native/android/tula-auth/src/test/kotlin/dev/tula/auth/DocsSnippets.kt#invitation -->
```kotlin
// The app was opened by the link in the emailed invitation (an app link, say).
val link = TulaInvitationLink.read(openedWith) ?: return
// The token is a secret. It was in the address's fragment, which no server saw.
val preview = tula.organizations.invitations.preview(link.token)
// preview.organizationName, preview.role and preview.email, to prefill a sign-up.
// Once the user is signed in as preview.email, with its address verified:
val joined = tula.organizations.invitations.accept(link.token)
tula.organizations.setActive(joined.id)
// or: tula.organizations.invitations.decline(link.token)
```
<!-- /snippet -->

The token is a credential: the client never logs it, prints it or puts it in an error, and
`TulaInvitationLink` prints as its name only. Keep `link.cleanUrl`, not the address the
token came in.

When an environment verifies an organization's domain, a user whose verified address is on
it is offered that organization, and joins it with the environment's default role:

<!-- snippet: native/android/tula-auth/src/test/kotlin/dev/tula/auth/DocsSnippets.kt#organization-suggestions -->
```kotlin
// Organizations whose verified domain is the one of the user's verified address:
val offered = tula.organizations.suggestions()
offered.data.firstOrNull()?.let { first ->
    tula.organizations.join(first.id) // with the environment's default role
}
```
<!-- /snippet -->

A member manages an organization with the role they hold: the server decides, from the
membership it reads on every call, and answers `organization.permission_required` (or
`auth.forbidden` for the domain routes) for what the role may not do. A role you changed is
carried by the member's sessions from their next refresh.

<!-- snippet: native/android/tula-auth/src/test/kotlin/dev/tula/auth/DocsSnippets.kt#organization-members -->
```kotlin
// The server decides from the role the user holds now, on every call.
val members = tula.organizations.members.list(organizationId)
val roles = tula.organizations.roles(organizationId) // the roles the user may give
val first = members.data.firstOrNull()
if (first != null && roles.data.any { it.key == "admin" }) {
    tula.organizations.members.changeRole(organizationId, first.userId, "admin")
}
tula.organizations.update(organizationId, name = "Acme Inc")
tula.organizations.leave(organizationId) // refused for the last manager
tula.organizations.remove(organizationId) // deletes it for good
```
<!-- /snippet -->

**Renaming an organization, giving a member another role and changing a domain's mode are
`PATCH` calls, and the default engine cannot send one**: `HttpURLConnection` has no `PATCH`,
so they fail with `network.failed` until the client is given an `HttpEngine` that can (over
OkHttp, say; see "Requests"). The journeys run them with such an engine.

`members.list` is the first page only. `leave` is refused with `organization.last_manager`
for the one member who can manage members, and the same code refuses demoting or removing
that member. Deleting an organization removes its memberships, invitations and domains; a
session that had it active keeps working and reads the personal account (or the next
organization you choose) from its next refresh.

An administrator claims a domain by a code emailed to an address on it; a verified domain
suggests the organization to people whose verified address is on it, or joins them
(`mode`). A row's `status` is pending, verified or needs-reverification; a verified claim
must be proved again after `expiresAt`:

<!-- snippet: native/android/tula-auth/src/test/kotlin/dev/tula/auth/DocsSnippets.kt#organization-domains -->
```kotlin
// Claim a domain: a code is emailed to an address on it.
val claim = tula.organizations.domains.start(organizationId, "acme.com", "ada@acme.com", OrganizationDomainMode.Suggest)
val proved = tula.organizations.domains.verify(organizationId, claim.id, typed)
// proved.status is Verified until proved.expiresAt; later NeedsReverification.
tula.organizations.domains.update(organizationId, proved.id, OrganizationDomainMode.AutoJoin)
tula.organizations.domains.remove(organizationId, proved.id)
```
<!-- /snippet -->

`tula.organizations.invitations` also has `list`, `invite` and `revoke` for a signed-in
member whose role may do it; the server decides. The journeys of these calls ran against
the real API from a JVM; nothing here was run on a device.

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
every status with its body, a `401` included. `HttpURLConnection` also has no `PATCH`: an
engine of your own is how the calls that rename an organization, change a member's role or
change a domain's mode (the three `PATCH` routes) are sent.

## Screens

`TulaAuth` is one composable that draws whichever screen the server asks for: the sign-in
(a password, an emailed code, a texted code, a passkey, Google, a provider's page), the
sign-up, the emailed code that proves an address, the second step (an authenticator's code,
a backup code, a texted code, a passkey), an authenticator set up inside a sign-in, the
password reset and the replacement of an expired password. A step it has no form for (one
this version does not know, or one that offers only ways this client cannot take) is a "not
supported" screen with a way back to the start, never a blank one.

`TulaAccount` is the signed-in user's screen: the profile, the password, a phone number,
where they are signed in, two-step verification and passkeys.

<!-- snippet: examples/compose/src/androidTest/kotlin/dev/tula/example/compose/DocsSnippets.kt#screens -->
```kotlin
setContent {
    var signedIn by remember { mutableStateOf(false) }
    if (signedIn) {
        TulaAccount(client = client, onSignedOut = { signedIn = false })
    } else {
        TulaAuth(client = client, onSignedIn = { signedIn = true })
    }
}
```
<!-- /snippet -->

`mode = TulaAuthMode.SIGN_UP` opens on the sign-up. **Where the user goes after signing in
is your callback and nothing else**: the screens read no destination from the server, a
link or an intent. The session is the client's (`client.session`); the screens hold no
token.

**Leave each screen on its callback, not on `client.state`.** Two cases are lost otherwise:

- Where an authenticator app is set up inside a sign-in, the client is signed in as soon as
  the code was taken, and the backup codes are still to be shown, once. `onSignedIn` is
  called when the person said they saved them. An app that swaps `TulaAuth` out the moment
  the client is signed in never shows them.
- A sign-out the server could not be told of signs the client out locally all the same.
  `TulaAccount` then says the session may still be active on this device and offers the
  sign-out again; `onSignedOut` is called only for one the server was told of.

`onSignedOut` is also called when the account screen finds that the session ended somewhere
else (it was revoked, or its refresh was refused): once for that session, however often the
account is read afterwards, with the screen emptied instead of every section saying it could
not be read. It is never called for a sign-out that failed, and never by an account screen
that was shown while nobody was signed in: there was no session to end.

An app that starts with a stored session reads `client.state` once, after `client.load()`,
to choose which of the two to open on ([the example](../examples/compose/README.md) does).

### What the screens look like

:::native-screens{platform="android"}

These are `TulaAuth` and `TulaAccount` as [the example app](#the-example-and-its-ui-tests)
draws them on an Android emulator against the real API: pick a screen and a step, the scheme
and whether to show a device frame. Each picture is a screenshot taken by the example's UI
tests, not a mock-up, and the line under the gallery says what made it.
[Refreshing the captures](#refreshing-the-captures) says how to take them again.

:::

### Passkeys, Google and providers on the screens

A way to sign in is drawn only where the environment has it on **and the client was given
what it needs**: `passkeys` for a passkey, `google` for Google's account chooser, `browser`
together with `TulaAuth(redirectUrl = …)` for a provider's page. Both are known before the
first frame, so a button is never drawn and then taken away. A way the client cannot take
is not drawn at all, and where that leaves no way to sign in the screen says so in words.

What that does not know is whether the device can show the sheet. A client given
`CredentialManagerPasskeySheet` on a device with no credential provider draws the button,
and the sheet's failure is then said on the screen.

A sheet or a page that was closed is said as a quiet notice, not as an error: nothing was
changed and the button works again. One sheet is out at a time; a press while another is
still open is said as a notice too.

### A texted code

Nothing is texted by opening a screen: a message costs money, so the screen asks with a
button, and the code field is drawn once a message was asked for. The field is marked as a
one-time code from a text message (`ContentType.SmsOtpCode`), so a keyboard or an autofill
service that saw the message arrive may offer the code. **The library asks for no SMS
permission and does not read messages** (it uses neither the SMS Retriever nor the User
Consent API).

### The setup key, the QR code and backup codes

They are on the screen only while their form is open and are held nowhere else: not in saved
instance state, not in a log, and gone from the model when the form is left. Backup codes
are shown once; an activity that is made again while they are shown has lost them (new ones
can be made on the account screen).

**Leaving the setup while its code is being confirmed has a cost.** The request cannot be
taken back: if its answer arrives after the screen was left, the authenticator is on and the
backup codes that came with the answer were dropped unseen (a late answer draws nothing on a
screen that has gone). The person makes new ones from the account screen.

Each has a **Copy** control, and nothing is copied without a press. The copy is marked
sensitive (`ClipDescription.EXTRA_IS_SENSITIVE`). What that does is Android's: from
Android 13 the system hides the content in the clipboard preview and clears the clipboard
by itself after a while. **Before API 33 (Android 9 to 12) the mark is ignored**: the copy
is an ordinary clip there. **The library never clears the
clipboard** (it could not tell its own clip from what the person copied since), and a
keyboard or an app with clipboard access can read it while it is there. To offer no copy,
hand the model a `copy` that does nothing:

<!-- snippet: examples/compose/src/androidTest/kotlin/dev/tula/example/compose/DocsSnippets.kt#no-copy -->
```kotlin
val model = remember { TulaAccountModel(client, copy = { }) }
TulaAccount(model = model)
```
<!-- /snippet -->

The QR code is drawn by the library (no dependency), dark on white whatever the theme.

### The account screen

Each section is read by its own request: one that failed says so and can be read again
while the others stand.

- **Where you're signed in.** The session of this client is marked "This device". A session
  bound to a device key is marked "Bound to a device key": that a key signed, and nothing
  about whose hands a device is in. One other session, or all others, can be signed out.
- **Two-step verification.** An authenticator app turned on and off, new backup codes, and
  a texted code as the second step where the server offers it.
- **Passkeys.** Listed, added and removed. A passkey cannot be renamed in this version, and
  the screen says so. Without a passkey sheet nothing is added, and that is said too.
- **Phone number.** Added with a texted code, and removed.

**Not on the account screen** (TULA-78): connected provider accounts, giving an address to
an account that has none, and deleting the account. The client has calls for the first two
(`tula.identities`); the screen draws none of the three.

**The account belongs to the session it was read for.** The model asks the client whose
session it holds whenever the account is read, something is pressed or an answer arrives:
if another user has signed in on the same client since, nothing of the user before is kept
and an answer that was asked as them is dropped. The model is not told of a change by
itself, so make one per signed-in screen (the example does), or call `load()` when a kept
one is shown again.

**Confirm it is you.** Where the server asks for a recent authentication
(`auth.step_up_required`), the screen opens a form for a way the server named: the password,
an authenticator's code, a backup code, an emailed or a texted code, a passkey. Which ways
those are is the server's answer; an account with a second factor is never offered the
password alone. Afterwards what was asked for is carried out without being pressed again; a
password change is the exception (its passwords were emptied as they were sent, so its form
is shown again, empty). Where the server
names no way this client can take, the screen says to sign out and sign in again.

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

<!-- snippet: examples/compose/src/androidTest/kotlin/dev/tula/example/compose/DocsSnippets.kt#own-model -->
```kotlin
val model = remember { TulaAuthModel(client, onSignedIn = { /* … */ }) }
TulaAuth(model = model)
// and, when the screens are left for good: model.close()
```
<!-- /snippet -->

Do not put a `TulaAuthModel` or a `TulaAccountModel`, or anything read from their `state`,
into `rememberSaveable`, a `SavedStateHandle` or a `Bundle`.

### Screenshots

The library sets no window flag. If your app wants the system to keep the sign-in out of
screenshots, screen recordings and the recent-apps preview, that is one line in the
activity that shows it, and it is your decision (it also blanks the screen for a user who
is being helped over a screen share):

<!-- snippet: examples/compose/src/androidTest/kotlin/dev/tula/example/compose/DocsSnippets.kt#flag-secure -->
```kotlin
window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
```
<!-- /snippet -->

### Words

Every string the screens show or announce is a property of `TulaStrings`; the defaults are
English. Name only what you change:

<!-- snippet: examples/compose/src/androidTest/kotlin/dev/tula/example/compose/DocsSnippets.kt#strings -->
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
<!-- /snippet -->

A failed call is said by its **code**: your sentence in `errors`, else the built-in English
sentence for a code this version knows, else `unknownError`. Text the server wrote is never
shown.

The table is Kotlin, not `strings.xml`, because what decides the screens runs without
Android (that is what lets it be tested on a JVM). The cost: **nothing follows the device's
language by itself.** A translated app builds the table from its own resources:

<!-- snippet: examples/compose/src/androidTest/kotlin/dev/tula/example/compose/DocsSnippets.kt#strings-resources -->
```kotlin
val strings = TulaStrings(
    signInTitle = stringResource(R.string.sign_in_title),
    continueButton = stringResource(R.string.continue_button),
    // … the rest of what your app translates
)
```
<!-- /snippet -->

### Colours and sizes

`theme` takes a `TulaTheme`, the same tokens as the web components
(`TulaThemeDefaults.theme` is the default, with a light and a dark scheme; the screens
follow the system's). A value is checked before it is drawn, because a theme is often a
tenant's: one that is not a colour, a length or a typeface this version can draw is
replaced by the default's, never guessed at.

### Your own parts

Three parts of every screen can be replaced, each a composable lambda of `TulaAuthSlots`:
`header` (the title and what is under it), `primaryButton` and `footer`.

<!-- snippet: examples/compose/src/androidTest/kotlin/dev/tula/example/compose/DocsSnippets.kt#slots -->
```kotlin
TulaAuth(
    client = client,
    slots = TulaAuthSlots(
        footer = { footer -> BasicText("Acme · ${footer.text}") },
    ),
    onSignedIn = { },
)
```
<!-- /snippet -->

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

[`examples/compose`](../examples/compose/README.md) is an app whose sign-in is `TulaAuth`
and whose signed-in screen is `TulaAccount`. Its UI tests run the screens on an emulator or a device against the real API on your
machine:

```bash
bun run native/android/fixture/ui-tests.ts --avd <name of an emulator>
```

The script refuses a device that is not an emulator unless it is given `--allow-physical`:
`adb reverse` puts the API's port on the device's own loopback address, where every app
installed on a phone can reach it. They are run by hand: no workflow starts an emulator. CI compiles and lints the screens,
the example and the tests.

### Refreshing the captures

The pictures of [what the screens look like](#what-the-screens-look-like) come from the same
UI tests, in a mode that photographs instead of asserting:

```bash
bun run native/android/fixture/ui-tests.ts --avd <name of an emulator> --screenshots apps/docs/public/native/android
```

`CaptureTest` (in `examples/compose/src/androidTest`) walks the sign-in, the sign-up, the
password reset, the second step and the account, once in the light scheme and once in the
dark (`cmd uimode night`), and captures the app's window of every step (Compose's `captureToImage`, written out by the
shell, so without the system bars: the example is not edge to edge and an emulator without a
window draws its status bar empty). The script pulls them, scales each to 560 pixels wide, writes it as WebP (it needs `cwebp`:
`brew install webp`; a picture over 80 KB stops it) and writes `manifest.json` beside them
with the device, the Android API level, the commit and the date. The captures and the manifest
are committed; no workflow takes them, because none runs an emulator. Without the flag the
capture tests skip themselves, so an ordinary run is unchanged.

What the UI tests cover of these screens, and what they do not (no passkey sheet, Google
chooser or browser was opened; no text message was received; TalkBack was never on), is in
[what was not verified](plans/phase-2-unverified.md#step-215-the-compose-screens-the-second-step-the-other-ways-and-the-account-tula-61-adr-0062).

## Running its tests

```bash
bun run native:kotlin:test
```

It starts the real API on this machine and runs the tests and the coverage check of the
client and of what the screens decide (`tula-auth`, `tula-auth-ui`) against it. It needs a JDK (17 or later); the Gradle wrapper downloads Gradle and the
pinned dependencies. More in [`native/android/README.md`](../native/android/README.md).
