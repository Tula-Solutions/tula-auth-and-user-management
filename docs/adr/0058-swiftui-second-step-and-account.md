# ADR 0058 — SwiftUI screens for the second step, the other ways to sign in, and the account

- **Status:** accepted
- **Ticket:** TULA-60

## Context

[ADR 0057](0057-swiftui-screens.md) gave the Swift package screens for sign-in by password
or emailed code, sign-up and password reset. Every other step was the "not supported"
screen, and a signed-in app had nothing of the package's to show. The client
([ADR 0051](0051-swift-client.md)) already had the calls: the second step, an authenticator
app set up inside a sign-in, passkeys, Apple's sheet, a provider's page, step-up, the factor
and passkey routes, the session list. What it lacked were the calls for a texted code and a
phone number, and the screens for all of it.

This ADR extends 0057. Its rules hold unchanged: the model decides, the content is data, the
files of `Views/` only draw; every string is in the one table; nothing secret outlives its
screen. What is below is what the new screens add to each.

## Decision

### The client gains the texted-code calls, and says which sheets it was given

`SignInFlow.prepareSmsCode()` / `attemptSmsCode(_:)`, `TulaFlow.prepareSmsSecondFactor()` /
`submitSmsCode(_:)`, `TulaStepUp.sendSmsCode()` / `withSmsCode(_:)`, `TulaFactors.startSms()`
/ `confirmSms(code:)` / `disableSms()` and `TulaPhone` (`client.phone`: `request`, `verify`,
`remove`). They follow ADR 0051: a first factor is a call of its own, and **nothing is texted
by arriving at a step**.

`TulaClient.sheets` is three booleans: whether the app passed a passkey sheet, Apple's sheet
and a browser session. It is how a screen knows that a control cannot work. It exposes
nothing of a sheet.

### A control that cannot work is not drawn, and a way that is the only one says so

The first screen reads the environment's configuration once (`loadConfig`) and draws, under
its form:

- a passkey button, where the environment has passkeys on **and** the app gave the client a
  passkey sheet;
- one button per enabled provider that this app can take: Apple through Apple's sheet where
  the app gave one; Google through the app's own closure (`TulaAuthOptions.google`, below);
  any provider through the system's browser where the app gave a browser session **and** a
  redirect URL (`TulaAuthOptions.redirectURL`). A provider name this version does not know,
  or has no words for, is not drawn.

Where no typed way is on (no password, no emailed code, no texted code) the field and the
main button are not drawn. Where nothing at all is left, the screen says so in words
(`ways.noWayHere`) and is never blank. On the second step a passkey that is the only way is
its own screen with its own sentence and button; a passkey among others is a link only where
the client has a sheet.

The package still has no dependency. **Google's ID token is the app's to fetch**: the app
passes a closure that is handed the server's nonce and answers the token, or `nil` for a
closed sheet. What the closure throws is never kept or shown: the screen says a fixed
sentence.

**The redirect URL is never judged by the screens.** It is passed to the client, and the
server's refusal is said by its code.

### A dismissed sheet is said quietly, and `flow.busy` too

The model has a third message beside `formError` and `status`: `notice`, drawn in the muted
text colour with its own mark, announced, and never worded as an error. A passkey sheet that
was closed, a provider page that was closed, Google's closure answering `nil` and a sheet of
the app that is still out (`flow.busy`: one sheet at a time for a whole client) are notices:
nothing was sent to prove anything, nobody is signed in, and the button works again.

A provider round trip whose last step got no answer keeps its ticket for a minute in the
client; the screen then offers "Try again" (`retryProvider`), which sends that step again
without another trip to the provider. Leaving the sign-in discards the ticket.

### Nothing is texted by arriving, and a texted code that is switched off loses its controls

A screen that can ask for a texted code shows a button that asks ("Text me a code"); the
code field is drawn only once a send succeeded and the server said where it went. When the
server answers that no message will be sent (`auth.method_disabled`, `sms.disabled`,
`sms.country_not_allowed`), the button is taken away and the sentence stays: pressing again
could do nothing.

### The second step is one screen with one way open

`TulaAuthScreen.secondFactor(way, others:, sent:)`: the open way (an authenticator's code, a
passkey, a texted code, a backup code), the other ways the step offers as links, and the
masked destination once a texted code was asked for. The order is fixed (authenticator,
passkey, texted code, backup code) and the way a person chose is kept while the step stays.
A way this version does not know is left out; a step with none it can take is "not
supported".

A wrong code is said at its field in the screen's own words: the contract's sentence for
`auth.invalid_credentials` is about an address and a password, and a code screen has
neither. A code field is emptied as it is sent, right or wrong.

### Backup codes are shown before the sign-in is reported

Setting up an authenticator app inside a sign-in ends with the client signed in **and**
backup codes that are shown once. An app takes the sign-in screens away when it is told
somebody is signed in. So `confirmEnrolment` shows the codes first and calls `onSignedIn`
only when their screen is left: by "I have saved these codes", or by the view going away
(`close()`), where the completion is still reported, once.

**An app therefore goes on when `onSignedIn` is called, and not when the session's state
changes.** The example was changed to that (it followed `session.updates()` before), and
`docs/swift.md` says it. An app that follows the state takes the codes' screen away; the
user then makes new codes on the account screen. The alternative, holding the client's
sign-in back until the codes are seen, would put flow state into the session and was not
built.

If the screen is left while the confirming call is on its way, the codes are shown to
nobody and a completed sign-in is reported all the same.

### The account screen: one model, panels over an overview

`TulaAccountModel`, `TulaAccountContent` and `TulaAccountView` follow the sign-in screens'
split. The model holds what was read (`user`, `sessions`, `factors`, `passkeys`, each read
by a call of its own; one that failed is said in its section, with a way to ask again, and
the others are shown) and one open `TulaAccountPanel`: the overview, or one form over it
(change password, authenticator setup, backup codes, the texted factor's code, a phone
number and its code, a passkey's name, a question before something is removed, the step-up).

- **Sessions are named by the kind of client** (the table's words for `web`, `ios`,
  `android`, `server`), never by a user agent, and marked in words: "This device" for the
  current one and "Bound to a device key" where the server says `deviceBound`. Nothing is
  said by colour alone. No word claims more of a device than that
  ([ADR 0043](0043-device-binding.md)).
- **Signing out other sessions and one session needs no proof**, as the server has it.
- **The authenticator app cannot be turned off where the environment requires a second
  step**: the button is not drawn and the reason is said.
- **A texted second step is offered only where the server says it may be one**
  (`Factors.sms.available`), and one that is dormant beside a stronger factor is said in
  words, never hidden ([ADR 0025](0025-mfa.md)).
- **"Add a passkey" needs the client's passkey sheet and a read of the factors.** Without
  the sheet the section says that passkeys cannot be created here (existing ones can still
  be renamed and removed). Before a passkey that takes the second step over from a texted
  code, the section says that it has no backup codes.
- **Removing and turning off ask first**, on a panel of their own that names what is acted
  on.
- **Connected provider accounts are not on the screen.** `client.identities` is unchanged.

### The step-up is the screen's, and a typed secret does not wait behind it

A call the server answers `auth.step_up_required` opens the step-up panel with the ways the
server named (`params.methods`), in its order, less the ones this app cannot take (an
unknown word; a passkey without a sheet). With none left the panel says to sign out and in
again.

What was asked for is **owed**, in one of two ways:

- `perform(action, on: panel)`: the action is run again by itself once the proof is
  accepted. Used where nothing secret was typed for it (turning a factor on or off, new
  backup codes, adding a passkey, removing something, a phone number, a passkey's name).
- `retype(panel)`: the form is opened again, empty, and the screen says "Confirmed. Enter it
  again to continue." Used for the password change. A current and a new password are not
  kept in the model behind another form while a code is being typed.

Cancelling a step-up returns to the overview and says, as a notice, that nothing was
changed, whatever form asked for the proof: that form has lost what was typed, and what was
owed is forgotten with it. A wrong proof is said at its field in the panel's own words: the
server answers a wrong password with `auth.invalid_credentials` and a wrong code with
`mfa.invalid_code` (an emailed one with `verification.invalid_code`), and none of those
sentences is the panel's. A passkey the server refused is said above the form, about the
passkey. A code is emailed or texted only when asked for.

Where a problem of a failed call is said (under which field, or above the form) is one rule,
`TulaPlacedProblems`, which the sign-in screens and the account screen both use.

### A failed sign-out is not a sign-out

`signOut()` of the client throws when the server could not be told, and has dropped its own
session by then. The account screen then **stays**: it says that the sign-out could not be
confirmed and that the session may still be active on this device, shows nothing of the
account (it can no longer be read), and offers the sign-out again, which sends the token the
client kept for that. `onSignedOut` is called only after a sign-out the server was told of,
and when the screen finds that the session ended elsewhere while no failed sign-out is
pending. A session that ended is reported once, however often the account is read
afterwards; the next one to end, after somebody signed in again, is reported again.

### What is emptied when (extends the table of ADR 0057)

| Held | Where | Emptied |
| --- | --- | --- |
| A backup code typed | `TulaAuthModel.backupCode`, `TulaAccountModel.backupCode` | As it is sent; on every change of screen or panel; on `close()`. |
| The setup key and its `otpauth://` address | `setup` of either model | On every change of screen or panel; on `close()`. Asking again replaces it. |
| Backup codes | `backupCodes` of either model | When their screen is left by any way; on `close()`. |
| The QR code | Nowhere: drawn from `setup` by `TulaQRCode` each time, in memory | With the view. Never a file, a cache or the pasteboard. |
| A provider round trip's ticket | The client, in memory, at most a minute | By an answer about it; by leaving the sign-in (`discardProviderSignIn`). |
| The current and the new password of a change | `TulaAccountModel` | The current one as it is sent; both on every change of panel (a step-up included) and on `close()`. |
| A step-up's password or code | `TulaAccountModel` | As it is sent; on every change of panel; on `close()`. |
| A phone number typed, a passkey's name typed | `TulaAccountModel` | When the overview is shown again; on `close()`. Kept behind a step-up: neither is a secret, and what is owed needs it. |

**The pasteboard is written only when a person presses "Copy"** (the setup key, the backup
codes), through a closure the view passes to the model. Nothing reads it. What is copied is written for this device only and with an expiry of a minute
(`UIPasteboard`'s `localOnly` and `expirationDate`), so a setup key or backup codes are not
handed to the account's other devices by Universal Clipboard and do not stay on the
pasteboard. The rule (`TulaCopyRule`) is tested; the call that writes the pasteboard is view
code and no test or simulator run exercised it.

**A texted sign-in code's screens never say that a message was sent.** A number that signs
nobody in is answered like one that does and is texted nothing (ADR 0037), so the words
are "if this number can sign in, a code is on its way"; a test reads every string those
screens draw. The second step, the step-up and the account's phone number text the
account's own proven number and say "we texted".

**"Try again" of a provider sign-in and the ticket it would send go together**: the model
drops the client's held ticket (`discardProviderSignIn()`) wherever it takes the link away,
a screen left by going on to another sign-in included.

**Where a texted code is the step's one way for something typed, what is not a number in
the international form is said at the first field** ("Enter a phone number with its
country code, starting with +."), the attempt discarded, and never drawn as "not
supported": nothing is wrong with the app.

`TulaAuthSetup`, `TulaAuthSituation`, `TulaAuthContent`, `TulaAccountFacts`,
`TulaAccountContent`, `TulaSetupContent`, `TulaCodesContent` and both models are
`TulaRedacted`: they print as their type's name.

### Content parts are shared and generic

A field, an offer (a button or a link), a setup key and a list of codes are the same data on
both screens and differ only in what a control does. They are generic over the action
(`TulaFieldContent<Action>`, `TulaOffer<Action>`, …), with the earlier names kept as type
aliases, so one set of views draws both screens and neither decides anything. An offer says
whether it is destructive (drawn in the danger colour beside words that say what it does)
and what VoiceOver reads for it where the words alone would not say what it acts on ("Sign
out iPhone or iPad app").

### Strings

Three tables nested in `TulaStrings`: `ways`, `secondStep`, `account`. A translation sets
them as it sets the rest.

### Accessibility

As in ADR 0057, in the model and the parts: every new screen moves the focus to its title;
a problem moves it to its field and is in what the field is read as; a notice, a status and
a problem are announced; a row of the account is one element ("iPhone or iPad app, This
device, Signed in …") and its buttons name what they act on; the QR code is one image with
a label, and the setup key is beside it in text; the backup codes are a labelled list.

## Tests

- **`swift test`**: the content table has a row for every new screen and panel; the model
  tests cover the failure paths (a wrong, an expired and a used code; the lockout's words; a
  dismissed sheet; a sheet that failed; `flow.busy`; a step-up that was cancelled; a storage
  failure; a screen left in the middle of a setup; an unknown step). Sheets are scripted
  fakes: no test shows a sheet, opens a browser or touches a real Keychain, Secure Enclave
  or pasteboard.
- **Journeys**: the ten scenarios that waited for the texted-code calls are `journey` in
  `swift`'s column of `conformance/client-journeys.json`; one `not_built` is left (an
  emailed link, TULA-56).
- **UI tests on a simulator**, run by hand with `bun run native/swift/fixture/ui-tests.ts`:
  an authenticator app set up inside a sign-in, the second step, the account screen, a
  step-up, a phone number, and the system's accessibility audit of each new screen in both
  colour schemes. The example passes no sheet, so none is shown.

## Not verified

Nothing here was run on a device. No passkey sheet, no Sign in with Apple sheet, no Google
sheet and no browser session was shown by these screens; their buttons were exercised
against scripted fakes only. VoiceOver was not run (the simulator's accessibility audit is
not VoiceOver). No real Keychain was asked by a test of the package. See
[`docs/plans/phase-2-unverified.md`](../plans/phase-2-unverified.md).

## Not decided here

A screen for connected provider accounts. An emailed link (TULA-56). Holding the client's
sign-in back until backup codes were seen. A translated table shipped with the package.
