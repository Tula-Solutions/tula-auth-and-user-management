# Kotlin

The Kotlin client puts Tula into an Android app. This version is a **library with no UI**:
it signs a user up and in, resets a password, and keeps and refreshes the session. The
screens are your app's, and the client tells them which one the server is asking for. The
reasoning is in [ADR 0051](adr/0051-kotlin-client.md).

> **Not yet run on Android.** The client is plain Kotlin and is tested on a JVM, against the
> real API, in CI. The Keystore-backed storage is compiled and linted and has never run:
> no device, no emulator. Nothing is published to a Maven repository, and the names
> (`dev.tula:tula-auth`) are placeholders.
> [What was not verified](plans/phase-2-unverified.md#step-215-the-kotlin-client-tula-38-adr-0051).

## What this version does

| | |
| --- | --- |
| Sign-up | An address and a password (or no password, where the environment allows it), then the emailed code. |
| Sign-in | A password, an emailed code, or a texted code to a phone number. |
| Password reset | The emailed code and the new password together. |
| An expired password | The new password, as the last step of the sign-in. |
| Session | Kept in the Android Keystore's care, refreshed when needed, ended by sign-out. |

Not yet: passkeys, Sign in with Google and the other providers, a session bound to a device
key, two-step verification and step-up, an emailed link, account management, and the
Compose screens. A step that needs one of them is reported as "not supported" (below), never
as an error.

## Two modules

| Module | What it holds | Needs |
| --- | --- | --- |
| `tula-auth` | `TulaClient`, the flows, `TokenStorage`, the generated types. | Kotlin, `kotlinx.serialization`, `kotlinx.coroutines`. |
| `tula-auth-android` | `KeystoreTokenStorage`. | Android, API 28 (Android 9) or later. |

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
`response.invalid`, `storage.failed`, `flow.busy`, `flow.invalid_step`), a `message` for
that code, the HTTP `status`, `params`, the field `errors` of a validation failure and
`retryAfterMs` for a rate limit. Pass `messages` to the constructor to say them in your
app's words.

An error's `cause` is the platform's own exception. Do not show or log it.

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

## Where the token is kept

`KeystoreTokenStorage` encrypts the refresh token with a key the Android Keystore generates
and never hands out, and keeps only the ciphertext, in a private preferences file. Nothing
readable is written to preferences, a file, a log or a URL.

- After a restore onto another device the key is not there: the stored value is no token,
  and the user signs in again.
- A Keystore or a preferences file that fails is not a sign-out: the client says
  `storage.failed` and keeps the session while the app runs. A token the server has since
  replaced may then be what is stored, so an app ended in that state can find itself
  signed out at its next start.
- The key asks for no fingerprint or PIN: a refresh happens in the background.

## Running its tests

```bash
bun run native:kotlin:test
```

It starts the real API on this machine and runs the module's tests and coverage check
against it. It needs a JDK (17 or later); the Gradle wrapper downloads Gradle and the
pinned dependencies. More in [`native/android/README.md`](../native/android/README.md).
