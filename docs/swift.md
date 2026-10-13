# The Swift client

The Swift package in [`native/swift`](../native/swift/README.md) has two libraries.

`TulaAuth` is a client with no screen. It signs a user up, signs them in with a password,
an emailed code, a passkey, a provider's ID token or a provider's page in a browser
session, takes the second step and a step-up, resets a password, and keeps the session: the
access token in memory, the refresh token in the Keychain, refreshed when it is about to
expire, and bound to a device key where you ask for that. The decisions are in
[ADR 0051](adr/0051-swift-client.md).

`TulaAuthUI` is SwiftUI screens on that client, for a sign-in with a password or an emailed
code, a sign-up, the emailed code that proves an address and a password reset
(["Screens"](#screens), [ADR 0057](adr/0057-swiftui-screens.md)). For everything else you
draw the screens, from the step the server returns.

**What has been run.** The package is built and tested with `swift test` on a Mac, where its
journeys run against the real API on a loopback port. The screens, and under them the
client, were run in one iOS simulator, in the example app, by UI tests against the real API
on that Mac; the example keeps its refresh token with the default Keychain storage there,
and no test looked at the Keychain item. **Nothing was run on a device, and VoiceOver was
never turned on.** No test has asked a Secure Enclave, **no passkey sheet, no Sign in with
Apple sheet and no browser session has been shown by this package**, and no real provider
was asked: the tests put a software authenticator, a software key and the API's mock
provider in their place. What is unverified is listed for
[the session and the flows](plans/phase-2-unverified.md#step-214-the-swift-client-tula-37-adr-0051),
for [passkeys, providers and the device key](plans/phase-2-unverified.md#step-214-the-swift-client-passkeys-providers-a-device-key-tula-56-adr-0051)
and for [the screens](plans/phase-2-unverified.md#step-214-the-swiftui-screens-tula-49-adr-0057).
Nothing is published: there is no tag and no registry entry, and the package is used from a
checkout.

## What this version does not do

A sign-in that reaches one of these is the screen `notSupported`, not an error:

- a texted code (as a way to sign in or as the second step), and a phone number on the
  account;
- an emailed **link** (the code in the same email is the way).

The screens of `TulaAuthUI` do less than the client: a second step, a passkey, a provider
and the account's own screens have no screen yet (TULA-60), and a sign-in that reaches one
there is the "This step is not supported" screen.

## Setup

Requires iOS 16 or macOS 13, and Swift 5.9 or later. The package has no dependency: it uses
Foundation, Security, CryptoKit and AuthenticationServices, which are the system's.

```swift
import TulaAuth

let tula = try TulaClient(
    publishableKey: "tula_pk_…",
    baseURL: "https://auth.example.com"
)
```

The key is the environment's **publishable** key; anything else is refused when the client
is made (`TulaConfigurationError`, a fixed sentence that repeats nothing it was given). A
secret key never belongs in an app.

| Option | Default | What it is |
| --- | --- | --- |
| `storage` | `KeychainTokenStorage()` | Where the refresh token is kept. |
| `transport` | a `URLSession` of the client's own | What sends requests. It keeps no cookie, cache or credential and follows no redirect. |
| `sessionProfile` | none | A session profile to ask for by name, where the environment marks one `clientSelectable`. |
| `timeout` | 15 seconds | How long one request may take. A refresh never takes more than 8. |
| `deviceKeys` | none | Where the device key is kept: `KeychainDeviceKeyStore()`. With one, sessions are bound to the key ("A session bound to a device key"). |
| `passkeys` | none | The passkey sheet: `SystemPasskeySheet()`. Without one every passkey call throws `passkey.unsupported`. |
| `apple` | none | The Sign in with Apple sheet: `SystemAppleSheet()`. |
| `browser` | none | The browser session of a provider sign-in: `SystemBrowserSession()`. |

The client is an `ios` client to the API and that is not an option.

The last four are left out by default on purpose: nothing of the system is touched, and no
session is bound, unless the app said so. Each is a protocol (`TulaDeviceKeyStore`,
`TulaPasskeySheet`, `TulaAppleSheet`, `TulaBrowserSession`); a test or a preview passes an
implementation of its own.

## The session

```swift
try await tula.session.load()                 // reads the Keychain, once
for await state in await tula.session.updates() {
    switch state {
    case .loading: break                      // not known yet
    case .signedOut: showSignIn()
    case .signedIn(_, let user): showApp(user)
    }
}
```

`getToken()` hands out an access token for your own backend, refreshed first when it is
about to expire, and `nil` when nobody is signed in. Your backend verifies it against the
environment's published keys; send it nowhere else.

What the session does by itself is what `@tula/core` does:

- **One refresh at a time.** Calls that need a token at the same moment share one request.
- **A refresh the server refuses ends the session** (`session.*`, `auth.user_banned`,
  `auth.unauthenticated`): the state becomes `signedOut`.
- **Anything else keeps it.** Offline, a timeout, a rate limit: `getToken()` throws, the
  state stays `signedIn`, the stored token stays where it is, and the same call works when
  the network is back.
- **A refresh that got no answer is sent once more, at once**, with the same token. The
  server answers a token presented again inside its grace window (10 seconds by default)
  with the same next token, which is why a refresh gives up after 8 seconds whatever
  `timeout` says.

`list()`, `revoke(_:)` and `revokeOthers()` are the user's sessions.

### Signing out

```swift
do {
    try await tula.session.signOut()
} catch {
    // Signed out here, but the server could not be told: the session may live on there.
}
```

**A failed sign-out is not a sign-out.** When the server could not be told, `signOut()`
throws. The client is signed out all the same, and calling `signOut()` again tells the
server. Do not show "signed out everywhere" for a call that threw.

`signOut()` removes the stored token also when it could not read it. Two cases end in
`storage.failed` and are not put right by a second call: a stored token that could not be
read (the server was not told about that session, which lives until it expires or is ended
elsewhere), and a stored token that could not be removed (the next start of the app finds
it, and the server refuses it if the sign-out reached it).

### Where the refresh token is kept

In the Keychain, as a generic-password item that is never synchronized, in a class that
never leaves the device:

| `KeychainAccessibility` | Readable | For |
| --- | --- | --- |
| `.whenUnlocked` (default) | while the device is unlocked | most apps |
| `.afterFirstUnlock` | from the first unlock after a restart | an app that refreshes in the background |

It is written nowhere else: not user defaults, not a file, not a log line.

**A Keychain that cannot be read is not "signed out".** The call fails with
`storage.failed` and the session is kept: `load()` leaves the state `loading`, and the next
call asks again. With `.whenUnlocked`, a refresh made while the device is locked fails this
way.

**A Keychain that cannot be written is not harmless.** A refresh whose new token could not
be stored fails with `storage.failed`; the session is kept **in the running app**, which
holds the new token in memory. The Keychain still holds the token the server has replaced.
The client does not try the write again by itself: the next refresh that succeeds writes
its token. An app that is ended before that, and started after the server's grace window
(10 seconds by default), presents the replaced token and is signed out by the server
(`session.reuse_detected`).

`TulaTokenStorage` is a protocol of three functions; `MemoryTokenStorage` is the
implementation for tests and previews. An implementation of your own must keep the token on
the device and must throw, never return `nil`, when it could not read.

### A session bound to a device key

```swift
let tula = try TulaClient(
    publishableKey: "tula_pk_…",
    baseURL: "https://auth.example.com",
    deviceKeys: KeychainDeviceKeyStore()
)
```

With a key store, every sign-in this client starts carries a proof signed by the device's
key, the session is bound to that key, and every refresh carries a proof
([device binding](device-binding.md)). A refresh token copied off the device cannot be
refreshed without the key. Whether an environment allows or requires this is its session
profile's `deviceBinding`; a profile that says `none` refuses a client that sends a proof.

`KeychainDeviceKeyStore` makes a P-256 key in the Secure Enclave, which cannot be exported
and never leaves the device. **In a simulator, which has no Secure Enclave, it keeps a
software key instead**, which is for development and protects nothing.

What the client does with a refusal:

| What happened | The session |
| --- | --- |
| The server refused the proof (`device.proof_invalid`: a clock that is wrong, a proof seen before) and the key is there | **Kept.** `getToken()` throws; the next call makes a new proof. |
| The server asked for a fresh nonce (`device.nonce_required`) | Kept: the request is repeated once, by itself. |
| The key store could not answer (`device.key_failed`: a locked device, a Keychain error) | **Kept.** The same call may work a moment later. |
| The key store did not answer in time | **Kept.** The call is `network.timeout` and nothing was sent: the key store is inside the call's deadline, so a refresh never waits on it for longer than 8 seconds. |
| The server refused the proof **and the key store says, twice, that the key is gone** | **Ended.** Nobody can refresh that session again: the client signs out locally and tells the server. The user signs in again, and a new key is made. |

Ending a session cannot be undone, so the client asks the store twice and ends the session
only when both looks say there is no key. A second look that finds the key, or that fails,
keeps the session (`device.key_failed`). That narrows the case; it does not close it.

So a key store of your own must answer `nil` from `existing()` only when it knows there is
no key, and must throw when it cannot tell. A reinstalled app is a new device.
Signing out needs no proof.

**`device.key_failed` may never pass.** A stored key the Secure Enclave no longer opens (a
device restored from a backup, say) fails at every refresh, and the client cannot tell that
from a locked device, so it keeps the session and keeps failing. **The client does not
remove the key for you.** `KeychainDeviceKeyStore` cannot tell either (nothing Apple
documents says "never again"), and a key removed for a failure that passes would end the
bound session of every client that shares the store. The way out is yours: `signOut()`,
which needs no proof, and then `client.removeDeviceKey()`; the next sign-in makes a new
key. Until then every sign-in start fails with `device.key_failed` too, with nothing sent.
**Call the client's `removeDeviceKey()`, not the store's own `remove()`**: the client then
also forgets a look for the key that is still out. A call that had joined that look ends
with `device.key_failed` at once, and the next call looks again; told nothing, the client
could hand a later sign-in the key that was just removed. Call it with no sign-in under
way: a start that already holds the key when the removal runs binds its session to the
removed key, and that session is ended at its next refresh. `removeDeviceKey()` throws
`device.key_failed` when the store refused (nothing is forgotten) or when your task was
cancelled, and `network.timeout` when the store did not answer in time; after a timeout or
a cancellation the store may still remove the key, the client has forgotten its looks as if
it had, and calling again is safe. A key store of your own must tolerate a `create()` or an
`existing()` that starts while one from before a removal is still running.
Offer both wherever you show this error, and remove only when you have reason to think the
failure will not pass (the device is unlocked and it has failed since a restore). Two
clients that share one `KeychainDeviceKeyStore` name share its key; give them two names.

A key store of your own that **knows** its key will never be had again throws
`TulaDeviceKeyStoreError.unusable` from `existing()`. For that error alone a `signOut()`
asks the store to `remove()` by itself, best effort: a `signOut()` whose task is cancelled
while the store is being asked removes nothing, and the next one asks again. Never throw
it for a locked device, a cancellation or anything else that may pass.

The key store is asked one thing at a time. A look or a making that never returns is
joined by every later call, each of which ends at its own deadline (`network.timeout`)
and leaves nothing waiting behind it; the look is not started again, so such a store
answers nothing until `client.removeDeviceKey()` succeeds or the app is started again.

## Flows

A flow is one attempt. It holds the attempt's secret, sends it with every step, and exposes
the server's step (`flow.step`, the generated `FlowStep`) and what this version can do with
it (`flow.screen`):

| `FlowScreen` | Draw | Then call |
| --- | --- | --- |
| `.password` | a password field | `submitPassword(_:)` |
| `.firstFactor(step)` | the ways in `step.strategies` that are in `FlowScreen.firstFactors` | `submitPassword(_:)`, or `prepareEmailCode()` then `attemptEmailCode(_:)` |
| `.emailVerification(step)` | a code field | `verifyEmail(code:)`, `resendCode()` |
| `.newPassword(step)` | a new-password field | a reset: `submit(code:password:)`; a sign-in whose password expired: `submitNewPassword(_:)` |
| `.secondFactor(step)` | the ways in `step.strategies` the client can take | `submitTotp(_:)`, `submitBackupCode(_:)`, `submitSecondFactorWithPasskey()` |
| `.factorEnrolment(step)` | an authenticator's setup key, then a code field | `startTotpEnrolment()`, `confirmTotpEnrolment(code:)` |
| `.complete` | nothing: the session is signed in | |
| `.notSupported(status:)` | "this app cannot finish this here" | nothing |

```swift
let flow = try await tula.startSignUp(email: email, password: password)
// The server emailed a code.
try await flow.verifyEmail(code: typed)       // .complete: tula.session is signed in

let signIn = try await tula.startSignIn(identifier: email)
try await signIn.submitPassword(typed)

let reset = try await tula.startPasswordReset(email: email)
try await reset.submit(code: typed, password: newPassword)
```

Every `default:` of a switch over `FlowScreen` or `FlowStep` should draw the "not supported"
screen. The server can gain a step after your app shipped; the client hands it on unchanged
and makes no request on a guess.

A flow runs one action at a time (a second call while one is out is `flow.busy`). Call
`discard()` when the user leaves the screen: the secret is forgotten, and the answer of an
action still in flight signs nobody in.

Nothing is sent by a start. A sign-in's emailed code is asked for with `prepareEmailCode()`,
and the answer is the same for an address with no account.

### The second step

`submitBackupCode(_:)` also answers how many backup codes are left. `confirmTotpEnrolment`
answers the backup codes, once: show them, and keep them nowhere. An authenticator's setup
key and its `otpauth://` address are secrets while their screen is open; never log one.

A second factor that is a texted code alone is `notSupported` in this version.

## Passkeys

A passkey call shows the system's sheet and answers a `TulaCeremony`:

```swift
switch try await tula.signInWithPasskey() {
case .finished(let flow): proceed(flow)       // complete, or the step the server asks for
case .dismissed: break                        // the user closed the sheet: say nothing
}
```

**A dismissed sheet is not an error and not a sign-in.** Nothing was sent to prove
anything, and the same call works again. A `catch` is for what failed.

| Call | |
| --- | --- |
| `tula.signInWithPasskey()` | A sign-in of its own, with no identifier. |
| `flow.submitSecondFactorWithPasskey()` | The second step, where the server offers a passkey. |
| `tula.passkeys.add(name:)` | Registers one for the signed-in user (needs a recent authentication). |
| `tula.passkeys.list()`, `.rename(_:to:)`, `.remove(_:)` | The user's passkeys. |
| `tula.stepUp.withPasskey()` | A step-up. |

One sheet at a time for the whole client: a second ceremony while one is out is `flow.busy`,
before any request. Nothing of a ceremony is kept.

The server accepts an iOS app's passkey only where the environment has the app registered
and allows the relying party's own origin ([native apps](native-apps.md)), and the app needs
the Associated Domains entitlement for that domain. None of that has been tried on a
device: the journeys answer with a software authenticator.

## Sign in with Apple, and Google's ID token

```swift
// Apple: the client runs the sheet.
let result = try await tula.signInWithApple()

// Google: the app gets the token from Google's SDK, the client exchanges it.
let attempt = try await tula.startIdTokenSignIn(provider: .google)
let idToken = try await askGoogle(nonce: attempt.nonce)
let flow = try await attempt.exchange(idToken: idToken)
```

The nonce is the server's, and an attempt takes one token, right or wrong. The token is
sent once and kept nowhere. The package has no Google dependency: the token comes from the
app.

For Apple the client hands the sheet the SHA-256 of the nonce, as Apple's token must carry
it, and sends the name the sheet gave (which Apple gives on the first authorization only).
An app that runs the sheet itself uses `attempt.appleNonce` and
`exchange(idToken:givenName:familyName:)`. The environment accepts Apple's token only for
the bundle IDs of its registered iOS apps ([Apple](providers/apple.md)).

## Sign in with a provider's page

```swift
switch try await tula.signIn(with: .github, redirectURL: "https://app.example.com/return") {
case .signedIn(let flow): proceed(flow)
case .needsStep(let flow): draw(flow.screen)  // a second factor
case .cancelled: break                        // the user closed the browser
case .refused(let why): explain(why)
case .linked: break                           // only from identities.link
}
```

The redirect URL is one the environment lists, exactly: an app link (`https://…`, which
the system's session can listen for from iOS 17.4; before that the call is
`provider.unsupported`) or a custom scheme, which the server allows only for a provider
that sends PKCE. The server decides; its refusal is thrown as it is.

The system's session matches an app link by its host and its path and by nothing else. An
`https` redirect URL with a port, a user name, a query, a fragment or a host that ends in
a full stop could never be returned to, so `SystemBrowserSession` refuses it with
`provider.unsupported` before anything is opened.

**What the browser returns is read only when it is the redirect URL that was asked for,
character for character.** Anything else is `.refused(.unexpectedReturn)` and no request is
made. A closed browser is `.cancelled`: not an error, and nobody is signed in. When the
exchange got no answer, or failed before the ticket was sent (`storage.failed`,
`device.key_failed`), `retryProviderSignIn()` tries the same ticket again for a minute.

`tula.identities.link(_:redirectURL:)` adds a provider account to the signed-in user the
same way, and needs an app link: the server refuses a custom scheme there.

## Step-up, factors

```swift
do {
    try await tula.factors.disableTotp()
} catch let error as TulaError where error.code == "auth.step_up_required" {
    // error.stepUpMethods says how: "totp", "backup_code", "passkey", "password", "email_code"
    try await tula.stepUp.withTotp(typed)
}
```

`tula.stepUp` has `withPassword(_:)`, `withTotp(_:)`, `withBackupCode(_:)`,
`sendEmailCode()` then `withEmailCode(_:)`, and `withPasskey()`. A user with a second
factor steps up with it; the server never offers them the password or an emailed code.
`tula.factors` reads the user's factors, enrols and removes an authenticator and makes new
backup codes.

## Screens

`TulaAuthUI` is the package's second library: SwiftUI screens on the client, with nothing
but SwiftUI and Foundation under them. One view is a sign-in, a sign-up and a password
reset; it draws the step the server returned and moves between the three by its own links.

```swift
import SwiftUI
import TulaAuth
import TulaAuthUI

struct SignInScreen: View {
    let tula: TulaClient

    var body: some View {
        TulaAuthView(client: tula, mode: .signIn) {
            // The client is signed in: show the app.
        }
    }
}
```

`mode` is the flow it opens on (`.signIn` or `.signUp`), and the last argument
(`onSignedIn`) is called once, when a flow completed. Whether somebody is signed in is the
client's to say (`tula.session.state`), as it is without the screens.

| The server's step | The screen |
| --- | --- |
| none yet | Sign in (the address), Create your account (the address and a password), Reset your password (the address) |
| `needs_first_factor` that offers a password | Enter your password, with "Email me a code" where the step offers one too |
| `needs_first_factor` that offers an emailed code and no password | Check your email: the code is asked for at once where it is the only way, and offered where the step also has a way these screens lack. Nothing is emailed by arriving at a step that has another way |
| `needs_email_verification` | Check your email (the code that proves the address) |
| `needs_new_password` of a reset | Choose a new password (the code and the new password together) |
| `needs_new_password` with `reason: expired` | Your password has expired |
| `complete` | You are signed in |
| anything else | **This step is not supported**, with "Start again": a second step, an enrolment, a step that offers only a passkey, a provider or a texted code, a status or a reason this version does not know. Never a blank screen, and never a request made on a guess |

**Nothing secret outlives its screen.** The view holds no token: the session is the
client's. A password and a code are in the fields' state only while their screen is open;
every change of screen, the completion and the view's disappearance empty them. What is
emptied as it is sent depends on what it is: a sign-in's password, and a code sent alone
(the code that signs in, the code that proves an address), are emptied right or wrong; a
password that is being chosen (at a sign-up, in a reset, for an expired password) stays
when the server refuses it, so that it can be put right, and a reset's code stays with it
unless the code is what was refused. The screens log nothing.

**A view that goes away closes its attempt.** That is also what happens when another screen
is pushed over it or another tab is chosen: the flow is discarded, every field is emptied,
the address too, and the view is on its first screen when it is come back to. A flow that
is left any other way (another flow is opened, "Start again") is discarded as well, and an
answer that arrives afterwards signs nobody in. One answer is not dropped: a sign-in that
had already completed when its screen was left has signed the client in, so `onSignedIn` is
still called, once per completion, **also after the view has gone**: an app that must not
act for a screen that is no longer shown checks that itself. Such a late completion ends
whatever the model has open by then (an attempt started meanwhile is discarded and its
fields emptied) and shows "You are signed in". No button does nothing: one whose attempt
is gone opens the first screen and says "That attempt is no longer open. Start again."
(`TulaStrings.flowLost`).

**A sign-in whose session could not be saved is still a sign-in.** When the flow completed
and the storage refused the token (`storage.failed`), the client is signed in for as long
as the app runs. The screens show "You are signed in", call `onSignedIn` once, and say
under the title, in words that are also announced, "Your session could not be saved on
this device. You may be signed out when the app closes." (`TulaStrings.sessionNotSaved`).
"May": the next refresh that succeeds writes the token again; until one does, the storage
holds nothing of this session (or an older token), as said under "Where the refresh token
is kept". The form is not shown again with an error: the attempt is over, and a second
submit could only be refused.

Whether a password is drawn in the clear ("Show password") is the model's state and goes
with the field's text: a field that comes back empty comes back hidden.

An app that draws its own screens on `TulaAuthModel` reads `model.content` (the title, the
fields, the main button and the links of the open screen, each with its `TulaAuthAction`)
and calls `model.perform(_:)`.

### The theme

The screens are drawn from the generated `TulaTheme`, in the light or the dark scheme the
system is in. An app changes the values it wants:

```swift
var theme = TulaTheme.defaults
theme.light.primary = "#0f766e"
theme.dark.primary = "#5eead4"
theme.radius = "12px"

TulaAuthView(client: tula, theme: theme)
```

A theme value is a string of the contract's grammar and may come from data a tenant edits,
so it is treated as untrusted. It reaches a view in two steps, and each refuses rather than
guesses:

1. The contract's grammar (`TulaThemeGrammar.isValid`, the rules of `isValidThemeValue` in
   `@tula/contract/theme`): no `;`, brace, `<`, `>`, backslash, `@`, `!`, line break, `/*`,
   `url(`, `expression(` or `var(`, a length cap, and the grammar of the token's type. The
   Swift copy is never looser, and refuses anything outside ASCII as well.
2. What the system draws with:

   | A token that is | Becomes | Refused, although the grammar accepts it |
   | --- | --- | --- |
   | a colour | sRGB channels and an opacity, from `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`, `hsl()`, `hsla()`, `transparent`, `black` or `white` | `hwb()`, `lab()`, `lch()`, `oklab()`, `oklch()` and every other colour name |
   | a length | points: `px` and `pt` are one point each, `rem` and `em` sixteen, `0` is zero | `%`, `ch`, `ex`, `vw`, `vh`, `vmin`, `vmax`; a negative length; one over 200 points; a text size under 11 points |
   | a font family | the first family of the list: a generic name is the system's typeface, another is asked for by name (and drawn in the system's where the device lacks it) | |
   | a shadow | checked and not drawn | |

A refused value is replaced by the default theme's value for that token, and
`TulaResolvedTheme(theme).refused` lists the tokens it happened to (`light.primary`,
`radius`: the token's key, never the value). Text sizes are the theme's points scaled by
Dynamic Type.

### The strings

Every string the screens show is a property of one table, `TulaStrings`, in English by
default. An app translates or rewords the ones it wants:

```swift
var strings = TulaStrings.english
strings.signInTitle = "Welcome back"
strings.errors["auth.invalid_credentials"] = "That did not match. Try again."

TulaAuthView(client: tula, strings: strings)
```

A value in `{braces}` (`{appName}`, `{destination}`, `{time}`) is filled in by the screens,
once. Every string is drawn as text: nothing is read as Markdown, HTML or a link.

**A failed call is shown by its code, never by the server's own words.** The message is
`strings.errors[code]` where the table has one, otherwise the contract's English sentence
for a code this version knows, otherwise `strings.unknownError`. A problem the server names
a field for is said under that field; `rate_limited` with a wait says the wait.

### Slots

Four parts can be replaced, with modifiers on the view (or above it):

```swift
TulaAuthView(client: tula)
    .tulaAuthHeader { context in Image("Logo").accessibilityLabel(context.appName ?? "") }
    .tulaAuthFooter { Text("Terms apply.") }
    .tulaAuthPrimaryButtonStyle(.borderedProminent)
    .tulaAuthFieldStyle(Underlined())
```

| Modifier | Replaces | It is given |
| --- | --- | --- |
| `tulaAuthHeader` | what is above the title (by default the app's initial on the brand colour) | the screen and the app's name, once known |
| `tulaAuthFooter` | the last line, "Secured by Tula" | |
| `tulaAuthPrimaryButtonStyle` | the look of each screen's main button | a `ButtonStyle`'s configuration; the label already says in words when the action is being sent |
| `tulaAuthFieldStyle` | how a field is drawn | a `TulaAuthFieldConfiguration`: the label, the text field, the hint, the problems, whether it has the focus |

A field style is handed the text field itself, already labelled for VoiceOver and bound to
the focus; it places it and draws around it. **Draw every entry of `errors` as text**: a
problem has to be said in words, not by a colour alone. A slot reads the theme the screens
are drawn with from the environment (`@Environment(\.tulaAuthAppearance)`).

The title, the messages and the order of a form are not slots. An app that needs more draws
its own screens on `TulaAuthModel` (what is behind the view: the screen, the fields, the
problems and the actions) or on the client.

### Accessibility

Every field has a label above it and is read by that label; a field's problems are part of
what the field is read as ("Password, invalid: …"), are drawn under it in words that start
with "Error:", and are announced when they arrive. On a change of screen the focus (the
keyboard's and VoiceOver's) is asked to go to the title, and after a failure to the first
field with a problem. A control is at least 44 points high, text wraps instead of being
cut, and sizes follow Dynamic Type. The default colours are the contract's, whose tests
hold their contrast in both schemes.

**What was checked and what was not.** The system's accessibility audit ran on every screen
in a simulator, in the light scheme and, for the screens one test reaches, the dark one,
with the keyboard put away first and one finding excluded
([the list](plans/phase-2-unverified.md#step-214-the-swiftui-screens-tula-49-adr-0057)).
Where the focus is asked to go, and what is announced, is tested on the model. **VoiceOver
itself was never turned on**, and no device, no iPad, no right-to-left language and none of
the largest text sizes was tried.

### The example

[`examples/swiftui`](../examples/swiftui/README.md) is an iOS app whose sign-in, sign-up
and reset are this view. It is also what the UI tests drive.

## Errors

Everything the client throws after construction is a `TulaError`:

| Field | |
| --- | --- |
| `code` | The contract's code as the server sent it (`auth.invalid_credentials`, `password.too_short`, …), or one of the client's own, below. `known` is the same as the generated `ErrorCode`. |
| `status` | The HTTP status; `0` for a client code. |
| `message` | The client's English sentence for the code (the contract's table); the server's own `detail` only for a code this version does not know. |
| `errors` | Field errors (a password that breaks several rules has one per rule). |
| `retryAfter` | Seconds to wait, for `rate_limited`. |

| Client code | When |
| --- | --- |
| `network.failed` | No answer: offline, a connection that died, or a call whose task was cancelled. |
| `network.timeout` | No answer in time, from the server or, for a client with a device key, from the key store before the request was sent. |
| `response.invalid` | An answer that is not what the contract says. |
| `storage.failed` | The storage could not be read, written or cleared. The running app keeps its session; what the Keychain then holds is said under "Where the refresh token is kept" and "Signing out". |
| `flow.busy` | A second action on a flow while one is out, or a second sheet or browser session while one is. |
| `device.key_failed` | The device key store could not answer, or could not sign. The session is kept. |
| `passkey.unsupported` | No passkey sheet was given to the client, or the system cannot show one. |
| `passkey.already_on_device` | A registration, where a passkey of this account is already on the device. |
| `passkey.failed` | The sheet failed for another reason. |
| `provider.unsupported` | No Apple sheet or browser session was given, or the system cannot do what was asked. |
| `provider.failed` | The sheet or the browser session failed for another reason. |

`device.proof_invalid`, `device.binding_required` and the other `device.*` codes are the
server's. None ends the session, except the one case under "A session bound to a device
key".

An error holds no token, password, code, attempt secret, key, proof or credential, and no
underlying error: what a system framework said when it failed is never kept.
The client's own values that hold a secret (the client, the session, a flow, a ceremony's
result, a provider's outcome, Apple's credential, the results with backup codes,
`MemoryTokenStorage`) print as their type's name, with `print`, `String(reflecting:)` and
`dump` alike.
The generated types are different: a `SessionTokens` or a request body prints what it holds,
and so does a `FlowSnapshot`, whose step is one of them.
Never log or interpolate one.

## Tests

```bash
bun install                                   # the journeys start the API from source
swift test --package-path native/swift
```

Three targets. `TulaAuthTests` are unit tests on a fake transport, a fake Keychain and fake
sheets: no network, no process, and nothing shown. `TulaAuthJourneyTests` drive the client against the real API, which
they start themselves in memory on a loopback port (`native/swift/fixture/server.ts`); they
are the `swift` column of [`conformance/client-journeys.json`](../conformance/README.md),
and `native/swift/fixture/journeys.ts` holds the two to each other. `TulaAuthUITests` test
what the screens decide (`TulaAuthModel`, the strings, the theme's grammar and conversions)
on the real client over a table of answers; they make no view.

Coverage has a threshold (90% of lines, 85% of functions) that each library meets alone:
`TulaAuth` over its hand-written sources, and `TulaAuthUI` over the files directly in
`Sources/TulaAuthUI`. The views (`Sources/TulaAuthUI/Views`) are not counted: a SwiftUI
`body` runs when something draws it, and `swift test` draws nothing. They hold no decision
for that reason ([ADR 0057](adr/0057-swiftui-screens.md)).

```bash
swift test --package-path native/swift --enable-code-coverage
bun run native/swift/fixture/coverage.ts
```

The `Swift` workflow (`.github/workflows/swift.yml`) runs both on a macOS runner, on pull
requests that touch the package, the contract or the conformance files, and nightly.

The screens themselves are run in a simulator, by hand:

```bash
bun run native/swift/fixture/ui-tests.ts
```

It starts the fixture, picks an iPhone simulator of the newest installed iOS, and runs
the UI tests of [`examples/swiftui`](../examples/swiftui/README.md) with `xcodebuild test`:
the example app against the real API, with the system's accessibility audit on the screens
it reaches. It needs Xcode with an iOS simulator runtime, and is in no workflow: nobody has
run it on a GitHub runner. The audit is a set of checks on the accessibility tree, **not
VoiceOver**.

What the script ends, and what it leaves. The fixture and `xcodebuild` are ended when the
run finishes, when it fails, and when the script is sent `SIGHUP`, `SIGINT` or `SIGTERM`.
**The simulator is left booted by every run**: the script boots none itself (`xcodebuild`
does) and shuts none down; `xcrun simctl shutdown <udid>` (the id is on the script's
first line) or `xcrun simctl shutdown all` ends it. **A `SIGKILL` of the script runs none of that**, and the timeouts go with it (they are
the script's own timers): `xcodebuild` and the tests go on until they finish or are
killed by hand (`pkill xcodebuild`). The fixture is written to exit when its standard
input closes, which a killed script's end of the pipe does, but that was not tried: look
for it (`pgrep -f native/swift/fixture/server.ts`) and end it (`pkill -f` the same) if it
is there. It listens on 127.0.0.1 only and holds nothing but that run's in-memory API.
