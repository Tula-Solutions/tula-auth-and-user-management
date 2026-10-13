# Compose example

An Android app whose sign-in, sign-up and password reset are the Compose screens of the
Kotlin SDK (`TulaAuth`, from `native/android/tula-auth-compose`; how to use them is in
[docs/kotlin.md](../../docs/kotlin.md#screens), why they are built this way in
[ADR 0061](../../docs/adr/0061-compose-screens.md)). What it adds is what every app adds: a
client with the Keystore-backed storage, a screen for a signed-in user with a sign-out, and
a setup screen that asks where the API is.

The screens draw less than the client can do: a second step, the enrolment of an
authenticator, a passkey, Google and the other providers, a texted code and the account's
own screens are not drawn yet (TULA-61). A sign-in that needs one of them ends on the "not
supported" screen here, so try the example against an environment whose sign-in is a
password or an emailed code, where two-step verification is not required, with an account
that has no second factor.

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

- `TulaAuth(client, onSignedIn = …)` and nothing else for the whole sign-in.
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

The eight tests of `AuthScreensTest` passed on one emulator (an Android 17 image, on one
Mac), started by the script; the run, with its result line, is recorded in
[the unverified list](../../docs/plans/phase-2-unverified.md#step-215-the-compose-screens-tula-50-adr-0061).

Not run: a phone; TalkBack (the tests read the semantics tree, they do not listen); an
accessibility checker; the dark scheme; any other API level, the floor (API 28) included;
a GitHub runner (the tests are in no workflow: CI compiles them only). The app was not run
against a deployed API, only against the fixture, and no release build was made.
