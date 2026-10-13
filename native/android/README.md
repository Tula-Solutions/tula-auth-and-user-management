# Tula for Kotlin and Android

The Kotlin SDK. Today: a client with no UI (flows, a session, the second step, passkeys, Google and the other providers, a device key) and its Android adapters: the Keystore-backed
token storage, Credential Manager's sheets, a Custom Tab and a Keystore device key. How to use it is in [docs/kotlin.md](../../docs/kotlin.md); why it is built
this way is [ADR 0054](../../docs/adr/0054-kotlin-client.md).

**Not run on Android yet, and not published.** The client's tests run on a JVM; the Android
module is compiled and linted only. See
what was not verified: [the client](../../docs/plans/phase-2-unverified.md#step-215-the-kotlin-client-tula-38-adr-0054), [passkeys, providers and the device key](../../docs/plans/phase-2-unverified.md#step-215-the-kotlin-client-passkeys-providers-and-a-device-key-tula-57-adr-0054). No passkey sheet, no Google sheet and no browser has been opened by it.

## Layout

| Path | What |
| --- | --- |
| `tula-auth/` | The client: plain Kotlin on the JVM. No Android SDK needed to build or test it. |
| `tula-auth/src/main/kotlin/dev/tula/auth/generated/` | The API's types, error codes, theme and operations. **Generated** by `bun run native:generate` ([ADR 0050](../../docs/adr/0050-native-type-generation.md)): never edit or add a file there. |
| `tula-auth/src/test/kotlin/dev/tula/auth/` | Unit tests, on a scripted HTTP engine and a fake clock. |
| `tula-auth/src/test/kotlin/dev/tula/auth/journeys/` | The journeys: the client against the real API, and the guard that holds them to `conformance/client-journeys.json`. |
| `tula-auth-android/` | `KeystoreTokenStorage`, `CredentialManagerPasskeySheet`, `CredentialManagerGoogleSheet`, `CustomTabsBrowserSession`, `KeystoreDeviceKeyStore`: one thin class per interface of the client. Part of the build only where an Android SDK is known (`ANDROID_HOME`, `ANDROID_SDK_ROOT`, or `sdk.dir` in `local.properties`). |
| `gradle/libs.versions.toml` | Every version the build uses, pinned exactly. |

## Running the tests

From the repository's root, after `bun install`:

```bash
bun run native:kotlin:test
```

This starts the real API on a loopback port (`e2e/kotlin-fixture.ts`: memory adapters, no
database), runs `./gradlew :tula-auth:check` with its address, and stops it. `check` is the
tests and the coverage bound (Kover, 90% of lines of the hand-written sources).

Arguments after `--` replace the task:

```bash
bun run native:kotlin:test -- :tula-auth:test --tests '*JourneysTest*'
```

Run `./gradlew :tula-auth:test` by itself and the journeys **fail**, with this command in
the message: they need the API and are never skipped.

You need a JDK, 17 or later, on the `PATH`. The Gradle wrapper downloads Gradle 9.8.1
(pinned, with its checksum) and the dependencies on the first run.

## The Android module

With an Android SDK installed (platform 36.1, build tools 36.1.0):

```bash
./gradlew :tula-auth-android:assembleRelease :tula-auth-android:lintRelease
```

That compiles and lints it. Nothing runs it: there is no instrumented test and no example
app yet. CI does the same in a job of its own (`kotlin-android`), apart from the JVM tests
(`kotlin`), after installing those two SDK components by name.

What decides how a stored value is read (`AesGcmSealer`) is in `tula-auth` and is tested
there with a key in memory; this module supplies the Keystore's key. The same holds for the sheets, the browser and the device key: what a dismissal, a returned address or a lost key means is decided and tested in `tula-auth`, behind `PasskeySheet`, `GoogleSheet`, `BrowserSession` and `DeviceKeyStore`, with a software authenticator, a scripted browser and a software key; the classes here call the system and map its exceptions. Their libraries are `androidx.credentials` (with `credentials-play-services-auth`, for Android 13 and lower) and Google's `googleid`, and nothing else.

## Rules

- The client behaves as `@tula/core` does. A change to a session rule there is made here in
  the same change.
- `tula-auth` uses nothing Android lacks at API 28. No tool checks this: when you use a Java
  API, look up the Android API level it arrived in.
- No token, code, password or attempt secret in a log line, a `toString`, an exception's
  message or a URL. The module has no logger; keep it that way.
- A journey is a function of `JourneysTest` with `@Test` and, on a line of its own directly
  above it, `@Journey("<scenario name>")` or `@Behaviour("<id>")`. Its decision is in
  `conformance/client-journeys.json`, in the same change.
