# ADR 0048 — Passkeys and provider sign-in in the Expo SDK

- Status: accepted
- Date: 2026-10-10

## Context

[ADR 0046](0046-expo-sdk.md) delivered `@tula/expo` with the password and the codes, and
left three things to this record (TULA-48): passkeys, sign-in with a provider, and the
emailed link. Each needs something a phone has in place of a browser:

- `@tula/core` asked `navigator.credentials` for a passkey ([ADR 0027](0027-passkeys.md)).
  An app has the platform's passkey sheet, reached through a native module.
- A provider sign-in ([ADR 0026](0026-oauth.md)) navigates the page away and back, and keeps
  the binding of the round trip in the tab's `sessionStorage`. An app opens the system
  browser and is opened again by a URL.
- An emailed link ([ADR 0024](0024-email-sign-in.md)) is honoured only in the browser that
  asked for it, by a binding in that browser's `localStorage`. A link in an email opens
  the mail app's browser.

The server's half exists: an app's passkey origin (ADR 0027, "Native apps"), app links and
custom-scheme redirects ([ADR 0044](0044-app-link-and-custom-scheme-redirects.md)).

**Nothing in this record was run on a device, a simulator or in Expo Go.** No passkey sheet
and no system browser was opened; neither native module was installed. What that leaves
unverified is in [the Phase 2 list](../plans/phase-2-unverified.md#step-213-passkeys-and-provider-sign-in-in-tulaexpo-tula-48-adr-0048).

## What exists today (read on 2026-10-10)

Read from the npm registry's metadata and from the packages' own tarballs (their
declarations, their native sources and READMEs). Nothing was executed.

| Package | Version, published | What it is |
| --- | --- | --- |
| `expo` | 57.0.27 | **Expo has no passkey module of its own.** No package of the SDK creates or asserts a passkey. |
| `expo-passkeys` | 0.1.11, 2025-01-26 | Third party, not Expo's. Peers `expo ^52`; no release since. |
| `@clerk/expo-passkeys` | 2.0.29 | Clerk's, and depends on Clerk's client. |
| `react-native-passkey` | 3.6.2, 2026-09-08 | A React Native module (iOS 15 and later, Android API 28 and later). `Passkey.create(request)`, `Passkey.get(request)` and `Passkey.isSupported()`; requests and results are WebAuthn's JSON forms. A failure is rejected as a plain object `{ error, message }` whose `error` is one of a documented set of words, the same on both platforms (`UserCancelled`, `Interrupted`, `TimedOut`, `CredentialAlreadyExists`, `NotSupported`, `RequestFailed`, `BadConfiguration`, `NoCredentials`, `InvalidChallenge`, …). Needs a development build. |
| `react-native-passkeys` | 0.4.2, 2026-08-05 | An Expo module with a web implementation. Its errors differ by platform (a native error's code on iOS, an exception's name on Android). |
| `expo-web-browser` | 57.0.3, 2026-09-11 | `openAuthSessionAsync(url, redirectUrl?, options?)` resolves `{ type: 'success', url }` or `{ type: 'cancel' \| 'dismiss' \| 'opened' \| 'locked' }`. On iOS it is `ASWebAuthenticationSession`, which matches a custom-scheme callback **by scheme alone**, and an `https` callback only with `preferUniversalLinks: true` (iOS 17.4 and later, with the Associated Domains entitlement). On Android it is a polyfill: a Custom Tab, the app's state and `Linking`, resolving with the first URL for which `url.startsWith(redirectUrl)` (**a prefix match**). |

Two things follow for the design. No passkey module is "clearly right": there are two
maintained ones and neither is Expo's. And what a browser session returns need not be the
redirect URL that was asked for, on either platform.

## Decisions

### `@tula/core` asks a passkey provider; a browser's is the default

`Environment` gained one member, `passkeyProvider`: `create(options, request)` and
`get(options, request)`, each taking the server's options in WebAuthn's JSON form and a
signal, and resolving with the credential in JSON form. Where it is set it is asked
instead of `navigator.credentials`. Everything else of a ceremony stays `@tula/core`'s:
the four `passkey.*` client codes are still decided there from the rejection's `name`
(as a `DOMException` has one), what comes back is still checked before it is sent, and
nothing of a ceremony is kept. `createTulaClientWithEnvironment` and `runtimeEnvironment`
are exported so that another package can supply an environment.

This is the seam the lead's brief asked for, **in a different form**: an option of the
client (`createTulaClient({ passkeys })`) was the first design. It was not taken because
the provider sign-in needs the same seam for two more members (`tabStorage`, `page`), and
one exported function that takes an environment serves all three; three options would
have cost more of the bundle than was there. The budget (16,837 bytes gzipped) was not
raised: the change is 19 bytes, 16,809 to 16,828.

### The package calls no native module; two entry points do

`createTulaExpoClient` takes two optional options, **`passkeys`** (a `PasskeySheet`:
`create`, `get`, optionally `isSupported`) and **`browser`** (a `BrowserSession`: `open`).
Both interfaces are the package's own. An adapter for each is an entry point of its own:

| Entry point | Wraps | Peer |
| --- | --- | --- |
| `@tula/expo/passkeys` (`passkeySheet`) | `react-native-passkey` | `^3.6.0`, optional |
| `@tula/expo/browser` (`systemBrowser`) | `expo-web-browser` | `>=57.0.0`, optional |

**This departs from the brief**, which had a module wrapped behind `src/native.ts` as an
optional peer. A static import cannot be optional under Metro: an app that offers no
passkey would have to install `react-native-passkey` (and lose Expo Go) for a line it
never runs, or the package would need a `require` in a `try`, which a bundler resolves
anyway. An entry point an app does not import is the one way a peer is truly optional.
`src/native.ts` still imports only the secure store and the platform; `src/passkeys.ts`
and `src/browser.ts` are the two other modules that import a native package, each exactly
one, and `package.test.ts` holds all three and that no other source imports either entry.

`react-native-passkey` was chosen for the adapter because its failures are words set in
JavaScript, the same on both platforms, which is what "a dismissed sheet is not an error"
has to be decided from. The choice costs an app nothing: the interface is three functions.

The adapter maps the module's word to the `name` a browser would give
(`UserCancelled`, `Interrupted`, `TimedOut` → `NotAllowedError`;
`CredentialAlreadyExists` → `InvalidStateError`; `NotSupported` → `NotSupportedError`;
anything else, an inherited or non-string word included → a failure with no name) and
**drops the module's message**, which can quote a domain or a native error. A credential
whose `type` the module left out is given `public-key`; nothing else is touched.

The published manifest keeps these two peers optional and no others
(`.claude/hooks/release.test.ts`).

### One passkey request at a time: refused, not joined

A platform shows one passkey sheet. `oneAtATime(sheet)` is between `@tula/core` and every
sheet: a request made while another is out is **refused** with the name `AbortError`,
which `@tula/core` reports as `passkey.cancelled`.

- *Not joined.* Each request answers one challenge of one attempt; handing the first
  request's answer to the second caller would present an assertion for another challenge.
- *Not queued.* A sheet that opens after the user dismissed the one before it is a sheet
  nobody asked for.
- The place stays taken until the sheet itself has answered, also when the caller's signal
  ended the wait: the sheet may still be on screen, and there is no call that takes it away.

**A sheet that never answers holds the place for five minutes at most**
(`PASSKEY_SHEET_CEILING_MS`, added in review). A native promise can be left unsettled (an
app sent to the background with the sheet up), and a place freed only by the sheet's own
answer would then be taken until the app restarts. The ceiling is the lifetime of the
challenge the sheet answers (the contract's `PASSKEY_CHALLENGE_TTL_MS`; the package cannot
import the contract at run time, so the number is its own and a test holds the two equal):
an answer later than that is for a challenge the server no longer has. At the ceiling the
wait ends as a ceremony nobody answered in time (`NotAllowedError`, which is what a
browser says and what `@tula/core` reports as `passkey.cancelled`), the place is free,
and whatever the abandoned sheet answers afterwards is dropped: the place is held by
identity, so a late answer neither reaches anyone nor frees the place of the request that
came after it. The wait goes through the package's `Schedule`, like the secure store's.
What the platform does with a second sheet over one that is still on screen after five
minutes is not known.

**A request refused because a sheet is out is "busy" in the hooks, not "dismissed".**
`@tula/core` turns every refusal of a provider into one of its four passkey codes, and
`AbortError` into `passkey.cancelled`, which the hooks draw as a sheet the user closed.
A request that was never shown to anyone is not that. The hooks (`useSignIn`,
`useResetPassword`, `usePasskeys`) therefore ask the host first (`requireFreeSheet`) and
fail with the client code that already exists, `flow.busy`, as a provider round trip
does: an `error`, before any request, so no attempt is started for a sheet that cannot
open. A second tap on the *same* hook while its own action is pending is ignored, as
before.

**The client called directly still says `passkey.cancelled`** for that case
(`client.signIn.withPasskey()`, `user.passkeys.add()`, `session.stepUpWithPasskey()`).
Saying otherwise there needs `@tula/core` to pass a provider's own error through, which
is a change to core and to its bundle; it was not made. Stated in `docs/expo.md`.

### A dismissed sheet and a closed browser are `dismissed`

`passkey.cancelled` and a browser session that ended without a URL are not errors: the
flow hooks and `usePasskeys` have a boolean **`dismissed`**, and `error` stays `null`.
Nothing was sent to prove anything, nobody is signed in, and the action works again.
(The passkey attempt the start made stays on the server until it expires, as in a
browser.) `signInWithProvider` says `cancelled` as an outcome and does not throw.

### Provider sign-in is the server's own round trip, with memory for a tab

`signInWithProvider(client, { provider, redirectUrl })`:

1. `client.signIn.withOAuth({ …, navigate: false })`, as the app's platform. The server
   answers the authorization URL and the **binding**.
2. `browser.open(authorizationUrl, redirectUrl)`.
3. The URL the browser came back with is checked, then handed to
   `client.signIn.handleOAuthCallback()`, which sends the ticket with the binding.

What stands in for a browser, per client, in one closure (`createHost`):

- **`tabStorage` is a `Map`.** The binding never reaches the secure store, a file, a log
  line or an error, and is gone with the process. The cost is stated: a round trip does
  not survive the app being ended while the browser is open, and the user starts again.
  Keeping it in the secure store was decided against: a binding that outlives the process
  can be paired with a ticket by whatever opens the app later, and the secure store is
  for the one value that has to last.
- **`page` has an address only inside a round trip**: the redirect URL while the start is
  made, the returned URL while it is exchanged, empty otherwise and cleared in a
  `finally`. So `signIn.withOAuth` called on the client directly is refused by
  `@tula/core`'s own same-origin rule (`link.cross_origin`) before any request, and
  `handleOAuthCallback` finds nothing. Only the package's call gets through.
- **One round trip at a time** (`flow.busy`), and a new one forgets the last one's binding
  before it starts.

**What the browser returns is refused without a request unless it is the redirect URL
that was asked for, character for character, followed by `#`.** iOS matches by scheme and
Android by prefix, so `com.example.app:/oauth/callback/evil#…` or another path of the same
scheme can come back. Nothing is normalised (the server matches the entry exactly too). **Whether the
platforms hand the URL back character for character is itself unobserved**: a platform
that rewrote `com.example.app:/oauth/callback` as `com.example.app:///oauth/callback`, or
changed the case of an `https` link's host, would turn every real sign-in into
`refused: unexpected_return`. That is what a first run on a device has to look at, and
if it happens, how much difference to accept is a decision for this record, with the
argument for why the accepted forms cannot be another app's: it is not a fix to make in
passing.
Then: a fragment with neither a ticket nor an error is `no_answer`; a ticket for an
attempt this client holds no binding for is `not_started_here`, also with no request
(`@tula/core` decides that before it sends); the server's `oauth.different_browser` is the
same outcome.

**The redirect URL is not judged by the package.** The contract's
`customSchemeRedirectRefusal` could be asked before the start, and is not: the server's
answer is the one that counts, the package would be a second place the rule lives, and a
refusal costs one request. `request.redirect_not_allowed` is thrown as the server said it,
`params.reason` included, before any browser opens.

An exchange that got no answer keeps the ticket in `@tula/core`'s closure for a minute
(as in a browser) and the binding in memory; `retryProviderSignIn` sends it again.

`linkProvider` is the same round trip through `user.identities.link`. The server makes
that attempt a `web` one (ADR 0044), so a custom scheme is refused with
`client_not_native`: an app links with an `https` app link. That is the server's rule and
is left alone here.

`@tula/expo/browser` asks for `preferUniversalLinks` when the redirect URL is `https`,
because without it iOS would match an `https` callback by scheme, which is every site's.

### The emailed link is refused, and the code is the way

A link in an email opens the mail app's browser (or the system's), not the app. Making it
open the app is a universal link whose page is the app, plus the binding on the device
across the app being ended: the secure store, with a lifetime, and a deep link treated as
untrusted input. None of that is built. Until it is:

- `linkStorage` is absent from the environment, so `prepareFirstFactor({ strategy:
  'email_link' })` fails with `storage.failed` **before any request**, with
  `@tula/core`'s message for that code, which is about a page's storage and is not for
  a user's eyes here; the hooks' `screen` never offers a link, so only a direct caller
  meets it (a test of the
  suite holds it), and
- a step that offers only a link is the screen `not_supported`.

The same email carries a code, and `email_code` is the path. The same-browser rule is not
weakened: nothing was changed on the server.

The scenario "email link sign-in" therefore stays `not_built` for `expo`. **It has no
ticket of its own yet**: the entry keeps `TULA-48` with a reason that says so, and a
ticket for deep-link handling should replace it.

### What a client can do decides the screen

`flowScreen(step, ways)` counts `passkey` (first and second factor) and the providers only
for a client that has a sheet the device supports, or a browser (`waysOf(client)`; the
hooks pass it). A step that offers only what this client cannot do is still
`not_supported`, never a guessed action. `isSupported` is asked each time, not when the
client is created (creating a client calls no native module), and a module that throws
when asked is one that cannot be asked.

### The journeys

The shared journeys' `oauth` and `passkeys` capabilities became targets a suite fills in:
`'page'` for `@tula/core` (a browser page and `navigator.credentials`, as before), and for
`@tula/expo` a fake browser session the journey scripts and a passkey sheet over the
journeys' software authenticator, registered as an iOS app (and an Android one where the
scenario is Android's). They run against the real API in process with the mock provider.

Of the 30 entries TULA-36 left `not_built` for TULA-48: **25 are journeys**; **4 are
`not_applicable`**, each for something no app can do through the package (replay an
assertion, write the origin inside a response, lower a signature counter, change settings
between a passkey sign-in's start and its submit: the package holds no ceremony and the
call is one); **1 stays `not_built`** (the emailed link). `expo`: 52 journeys, 13 not
applicable, 38 not built before; 77, 17 and 9 after (1 for TULA-48, 8 for TULA-55).

## Not decided here

- **Opening an emailed link in the app** (no ticket yet): where the binding lives on the
  device and for how long, and what a deep link may carry.
- **A round trip that survives the app being ended**: follows from the same question.
- **Passkeys in autofill** (`ASAuthorizationController`'s AutoFill-assisted requests,
  Credential Manager's suggestions): not wrapped; `withPasskey({ autofill: true })` is not
  offered by the hooks.
- **Linking a provider by custom scheme**: the server's rule (ADR 0044).
- **Judging the redirect URL in the client** before the start.
- **Native Google and Apple, and device binding**: TULA-55, as ADR 0046 left them.
