# Compose example

An Android app whose sign-in, sign-up and password reset are the Compose screens of the
Kotlin SDK (`TulaAuth`) and whose signed-in screen is its account screen (`TulaAccount`),
both from `native/android/tula-auth-compose`. How to use them is in
[docs/kotlin.md](../../docs/kotlin.md#screens); why they are built this way is in
[ADR 0061](../../docs/adr/0061-compose-screens.md) and
[ADR 0062](../../docs/adr/0062-compose-second-step-and-account.md). What it adds is what
every app adds: a client with the Keystore-backed storage and the system's sheets, the
choice between the two screens, and a setup screen that asks where the API is.

**Which ways to sign in it offers.** A password, an emailed code, a texted code, the second
step and an authenticator set up inside a sign-in need nothing of the app. A passkey button
is drawn where the environment has passkeys on (the client is given Credential Manager's
sheet); whether the sheet then works needs an environment that has registered this app
(`dev.tula.example.compose`, with your debug certificate's fingerprint) and a domain that
names it, which nobody has set up. Google's button is drawn only when the app is also told
the provider's client id (`-e tula_google_client_id …`). **No provider that needs a browser
is offered**: the app's manifest claims no redirect URL and its activity wires no
`CustomTabsBrowserSession`.

It is **not a workspace package**: there is no `package.json` here, and the directory is
excluded from the Docker build context. It is a module (`:compose-example`) of the Gradle
build at [`native/android`](../../native/android/README.md), so it uses that build's wrapper
and version catalog and names no version of its own.

**It holds no key.** The API's address and the environment's publishable key are yours to
give: as extras of the intent that starts it (a debuggable build only: the activity is
exported, and any app on the device could otherwise start it over an address of its own),
or on its setup screen (which keeps them in
the app's own preferences; neither is a secret).

## Running it

You need a JDK (17 or later), an Android SDK with platform 36.1 and build tools 36.1.0, and
an emulator or a device. From `native/android`:

```bash
ANDROID_HOME=<your SDK> ./gradlew :compose-example:installDebug
adb shell am start -n dev.tula.example.compose/.MainActivity \
  -e tula_api_url http://10.0.2.2:3003 \
  -e tula_publishable_key <a publishable key of your environment>
```

`10.0.2.2` is an emulator's name for the machine it runs on. Plain `http` is allowed to
`127.0.0.1`, `localhost` and `10.0.2.2` only (`res/xml/network_security_config.xml`);
anything else has to be `https`.

## What it shows

- `TulaAuth(client, onSignedIn = …)` and nothing else for the whole sign-in, and
  `TulaAccount` for the signed-in user.
- **The sign-in screens stay until `onSignedIn`**, not until the client says it is signed in:
  where an authenticator is set up inside a sign-in the client is signed in before the
  backup codes were shown. And the account screen stays after a sign-out the server could
  not be told of, which is not a sign-out: it says so and offers it again.
- `ExampleSheets` is where the UI tests put a scripted sheet in place of the system's. It
  is example code only and is settable in the debug build only: the object with the four
  settable properties is in `src/debug` (the UI tests run against the debug build), and
  `src/release` has an object of the same name whose properties are `null` and cannot be
  set, so a release build of the example can only show the system's sheets. An app has no
  such thing.
- The activity handles configuration changes itself (`android:configChanges` in the
  manifest), so a rotation keeps the open flow. Without that a rotation starts the screens
  over, on purpose: nothing typed is ever put in saved instance state.
- The sealed tokens' preferences file is kept out of Android's backups
  (`res/xml/backup_rules.xml`, `data_extraction_rules.xml`).
- `FLAG_SECURE` is **not** set, so that the screens can be looked at. An app that wants no
  screenshot of its sign-in sets it in its activity; the library never does.

## The UI tests

`src/androidTest` drives the app through Compose's test rule and reads the semantics tree:
what a screen reader is given. Each test gets an environment of its own from the fixture
and reads its codes from the emails the API sent. From the repository's root, after
`bun install`:

```bash
bun run native/android/fixture/ui-tests.ts --avd <name>      # starts that emulator, and ends it
bun run native/android/fixture/ui-tests.ts                   # the one device adb already sees
bun run native/android/fixture/ui-tests.ts --device <serial>
bun run native/android/fixture/ui-tests.ts --device <serial> --allow-physical   # a phone: read below
```

**A device that is not an emulator is refused unless you pass `--allow-physical`.** The
script forwards the API's port into the device with `adb reverse`, and a forwarded port is
the device's own `127.0.0.1`: every app installed on it can open it for as long as the run
lasts, and with it the fixture's test routes and their relay to the admin API of the run's
environments. On an emulator those apps are the image's; on a phone they are whatever you
have installed. The environments are made for the run and hold no real user, and the
forward is removed when the run ends, but pass the flag only for a device that holds
nothing you do not trust. Nothing here was run on a phone.

Run from Android Studio, or with `./gradlew :compose-example:connectedDebugAndroidTest`
alone, the tests fail: a test on a device cannot start a process of the machine, so the
script does. It starts the real API on 127.0.0.1 (`e2e/kotlin-fixture.ts`), forwards that
port into the device with `adb reverse`, and ends what it started.

## What was run, and what was not

The eight tests of `AuthScreensTest` and the eight of `AccountScreensTest` passed on one
emulator (an Android 17 image, on one Mac), started by the script; the run, with its result
line, is recorded in
[the unverified list](../../docs/plans/phase-2-unverified.md#step-215-the-compose-screens-the-second-step-the-other-ways-and-the-account-tula-61-adr-0062).

`AccountScreensTest` goes through the second step with an authenticator's code and with a
backup code, an authenticator set up inside a sign-in, the account's sessions, an
authenticator turned on from the account, "Confirm it is you" and a sign-out. **Its one test
with a passkey does not open a passkey sheet**: it gives the app a scripted sheet that is
closed, and reads what the screen says of that. No test opens Google's account chooser or a
browser, receives a text message or adds a phone number; those paths are tested on the JVM,
on fakes.

Not run: a phone; TalkBack (the tests read the semantics tree, they do not listen); an
accessibility checker; the dark scheme; any other API level, the floor (API 28) included;
a GitHub runner (the tests are in no workflow: CI compiles them only). The app was not run
against a deployed API, only against the fixture, and no release build was made.
