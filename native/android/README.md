# Tula for Kotlin and Android

The Kotlin SDK. Today: a client with no UI (flows, a session, the second step, passkeys,
Google and the other providers, a device key), its Android adapters (the Keystore-backed
token storage, Credential Manager's sheets, a Custom Tab and a Keystore device key), and
Compose screens for a sign-in, a sign-up and a password reset (they draw no second step,
passkey, provider, texted code or account screen yet: TULA-61). How to use it is in
[docs/kotlin.md](../../docs/kotlin.md); why it is built this way is
[ADR 0054](../../docs/adr/0054-kotlin-client.md) and, for the screens,
[ADR 0061](../../docs/adr/0061-compose-screens.md).

**The screens ran on one emulator; nothing ran on a device, and nothing is published.** The
tests of the client and of what the screens decide run on a JVM; the Android modules are
compiled and linted in CI; the screens, with the token storage under them, were run on one
emulator by the example's UI tests, by hand. The other adapters have never run: no passkey
sheet, no Google sheet and no browser has been opened by this SDK. What was not verified:
[the client](../../docs/plans/phase-2-unverified.md#step-215-the-kotlin-client-tula-38-adr-0054),
[passkeys, providers and the device key](../../docs/plans/phase-2-unverified.md#step-215-the-kotlin-client-passkeys-providers-and-a-device-key-tula-57-adr-0054),
[the screens](../../docs/plans/phase-2-unverified.md#step-215-the-compose-screens-tula-50-adr-0061).

## Layout

| Path | What |
| --- | --- |
| `tula-auth/` | The client: plain Kotlin on the JVM. No Android SDK needed to build or test it. |
| `tula-auth/src/main/kotlin/dev/tula/auth/generated/` | The API's types, error codes, theme and operations. **Generated** by `bun run native:generate` ([ADR 0050](../../docs/adr/0050-native-type-generation.md)): never edit or add a file there. |
| `tula-auth/src/test/kotlin/dev/tula/auth/` | Unit tests, on a scripted HTTP engine and a fake clock. |
| `tula-auth/src/test/kotlin/dev/tula/auth/journeys/` | The journeys: the client against the real API, and the guard that holds them to `conformance/client-journeys.json`. |
| `tula-auth-android/` | `KeystoreTokenStorage`, `CredentialManagerPasskeySheet`, `CredentialManagerGoogleSheet`, `CustomTabsBrowserSession`, `KeystoreDeviceKeyStore`: one thin class per interface of the client. Part of the build only where an Android SDK is known (`ANDROID_HOME`, `ANDROID_SDK_ROOT`, or `sdk.dir` in `local.properties`). |
| `tula-auth-ui/` | What the screens decide, with no Compose and nothing of Android: `TulaAuthModel` (which screen, what the fields hold, where a problem is said), `TulaAuthContent` (what every screen offers, as data), `TulaStrings` (the one table of strings), `TulaThemeValues` (the contract's theme grammar and the conversion). Built and tested everywhere, like `tula-auth`. |
| `tula-auth-compose/` | What draws them: `TulaAuth`, the slots, `TulaComposeTheme`. An Android library on Compose's `ui` and `foundation`; part of the build only where an Android SDK is known. It decides nothing. |
| `../../examples/compose/` | The example app (`:compose-example`) and its UI tests: a module of this build that lives under `examples/`. See its [README](../../examples/compose/README.md). |
| `fixture/ui-tests.ts` | Runs those UI tests on an emulator or a device: starts the API, forwards its port with `adb reverse`, runs Gradle, ends what it started. By hand; in no workflow. |
| `gradle/libs.versions.toml` | Every version the build uses, pinned exactly. |

## Running the tests

From the repository's root, after `bun install`:

```bash
bun run native:kotlin:test
```

This starts the real API on a loopback port (`e2e/kotlin-fixture.ts`: memory adapters, no
database), runs `./gradlew :tula-auth:check :tula-auth-ui:check` with its address, and stops
it. `check` is the tests and the coverage bound (Kover, 90% of lines of the hand-written
sources, each module alone).

Arguments after `--` replace the task:

```bash
bun run native:kotlin:test -- :tula-auth:test --tests '*JourneysTest*'
```

Run `./gradlew :tula-auth:test` by itself and the journeys **fail**, with this command in
the message: they need the API and are never skipped.

You need a JDK, 17 or later, on the `PATH`. The Gradle wrapper downloads Gradle 9.8.1
(pinned, with its checksum) and the dependencies on the first run.

## The Android modules

With an Android SDK installed (platform 36.1, build tools 36.1.0):

```bash
./gradlew :tula-auth-android:assembleRelease :tula-auth-android:lintRelease \
  :tula-auth-compose:assembleRelease :tula-auth-compose:lintRelease \
  :compose-example:assembleDebug :compose-example:assembleDebugAndroidTest :compose-example:lintDebug
```

That compiles and lints the storage, the screens, the example and the example's UI tests.
CI does the same in a job of its own (`kotlin-android`), apart from the JVM tests
(`kotlin`), after installing those two SDK components by name. **It runs none of them**: no
workflow starts an emulator.

## The screens on a device

From the repository's root, with an emulator image or a device:

```bash
bun run native/android/fixture/ui-tests.ts --avd <name>
```

The script starts `e2e/kotlin-fixture.ts` on 127.0.0.1, forwards its port into the device
with `adb reverse` (the fixture's bind address and its guard are unchanged: inside the
device the address is still 127.0.0.1), and runs `:compose-example:connectedDebugAndroidTest`.
A device that is not an emulator is refused unless `--allow-physical` is given: forwarded
into a phone, the port is open to every app installed on it
([why](../../examples/compose/README.md)).
Every process it starts has a timeout, and what it started is ended when Gradle has, also
on `SIGHUP`, `SIGINT` and `SIGTERM`. A `SIGKILL` of the script runs none of that: end the
emulator yourself (`adb emu kill`). After a change under `tula-auth-compose` or
`examples/compose`, run it and record the run (the image, the result line) in
[the unverified list](../../docs/plans/phase-2-unverified.md#step-215-the-compose-screens-tula-50-adr-0061).

What decides how a stored value is read (`AesGcmSealer`) is in `tula-auth` and is tested
there with a key in memory; this module supplies the Keystore's key. The same holds for the sheets, the browser and the device key: what a dismissal, a returned address or a lost key means is decided and tested in `tula-auth`, behind `PasskeySheet`, `GoogleSheet`, `BrowserSession` and `DeviceKeyStore`, with a software authenticator, a scripted browser and a software key; the classes here call the system and map its exceptions. Their libraries are `androidx.credentials` (with `credentials-play-services-auth`, for Android 13 and lower) and Google's `googleid`, and nothing else.

## Rules

- The client behaves as `@tula/core` does. A change to a session rule there is made here in
  the same change.
- `tula-auth` uses nothing Android lacks at API 28. No tool checks this: when you use a Java
  API, look up the Android API level it arrived in.
- No token, code, password or attempt secret in a log line, a `toString`, an exception's
  message or a URL. The module has no logger; keep it that way.
- A decision of the screens is in `tula-auth-ui`, with a JVM test; `tula-auth-compose`
  draws `model.content` and calls `model.perform`. A branch in a composable that is more
  than "which part is drawn for this state" belongs in the model.
- Nothing of the screens goes into `rememberSaveable`, a `SavedStateHandle` or a `Bundle`,
  and no string a person reads is written outside `TulaStrings`.
- A journey is a function of `JourneysTest` with `@Test` and, on a line of its own directly
  above it, `@Journey("<scenario name>")` or `@Behaviour("<id>")`. Its decision is in
  `conformance/client-journeys.json`, in the same change.
