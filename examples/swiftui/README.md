# SwiftUI example

An iOS app whose sign-in, sign-up and password reset are `TulaAuthView` and whose
signed-in screen is `TulaAccountView`, the SwiftUI screens of the Swift package in
[`native/swift`](../../native/swift/README.md)
([docs/swift.md, "Screens"](../../docs/swift.md#screens),
[ADR 0057](../../docs/adr/0057-swiftui-screens.md),
[ADR 0058](../../docs/adr/0058-swiftui-second-step-and-account.md)). What it adds is what
every app adds: where the API is, and which of the two is shown.

**It goes from one to the other when a screen says so** (`onSignedIn`, `onSignedOut`), not
when the session's state changes: a sign-in that sets up an authenticator app shows its
backup codes after the client is already signed in.

**It gives its client no sheet.** No passkey sheet, no Apple sheet and no browser session is
passed to `TulaClient`, so the screens draw no passkey button and no provider, and the
account screen says in words that passkeys cannot be created here. An app that offers them
passes `SystemPasskeySheet()`, `SystemAppleSheet()` and `SystemBrowserSession()` and the
entitlements they need ([docs/swift.md](../../docs/swift.md#passkeys)).

It is also what the screens' UI tests drive: `TulaExampleUITests` run the app in an iOS
simulator against the real API.

**Not a workspace package.** There is no `package.json` here; `bun install` and `verify`
do not see it, and the API image's build context excludes it. It is an Xcode project,
`TulaExample.xcodeproj`, that takes the package from this checkout (`../../native/swift`)
and nothing else.

| Path | What |
| --- | --- |
| `TulaExample/TulaExampleApp.swift` | The app, where its configuration comes from, and the client made from it. |
| `TulaExample/SetupView.swift` | The screen that asks where the API is, when the app was not told. |
| `TulaExample/SessionView.swift` | `TulaAuthView` while nobody is signed in, in a navigation stack with one screen of the app's own to push over it ("About this example": a sign-in that is left is closed, and is on its first screen when it is come back to); once somebody is signed in, a line of the app's own over `TulaAccountView` (the sessions, two-step verification, the phone number, passkeys, and the sign-out). |
| `TulaExampleUITests/` | The UI tests and what they stand on (`Support.swift`). |
| `Info.plist` | App Transport Security as the system ships it, with plain `http` allowed to this machine and the local network only. |

## Run it

You need Xcode with an iOS simulator, and an API to talk to. A local one:

```bash
docker compose up -d
bun run db:migrate
bun run seed                                              # prints the environments' ids
bun run api-key:create --environment <id> --kind publishable
bun run dev                                               # the API on http://localhost:3003
```

Open `examples/swiftui/TulaExample.xcodeproj`, pick an iPhone simulator and run the
`TulaExample` scheme. The app asks for two things and holds neither in the repository:

- **the API's address**, for a local API `http://localhost:3003` (a simulator shares this
  machine's loopback address);
- **the environment's publishable key** (`tula_pk_…`). A publishable key is made to ship in
  an app. A secret key is refused when the client is made, and never belongs in one.

Type them on the app's first screen, which keeps them in the app's defaults, or give them
to the scheme as the environment variables `TULA_API_URL` and `TULA_PUBLISHABLE_KEY`
(Product, Scheme, Edit Scheme, Run, Arguments). **Do not commit a scheme or a file that
holds a key**: the shared scheme in the repository holds none.

The app keeps its session as the client does by default: the access token in memory and the
refresh token in the Keychain (in a simulator, the simulator's).

## The UI tests

From the repository's root:

```bash
bun install                                   # once: the fixture runs the API from source
bun run native/swift/fixture/ui-tests.ts
```

The script starts `native/swift/fixture/server.ts` (the real API in memory, on a loopback
port; the fixture the Swift client's journeys use), picks an iPhone simulator of the newest
installed iOS, runs `xcodebuild test` with a timeout and ends the fixture, also when the
run fails or is interrupted (`SIGHUP`, `SIGINT`, `SIGTERM`; a `SIGKILL` runs none of that, and
the simulator is left booted by every run:
[docs/swift.md](../../docs/swift.md#tests) says what to end by hand). Each test makes
an API of its own, launches the app pointed at it, reads the emails that API sent, and runs
the system's accessibility audit on the screens it reaches.

```bash
bun run native/swift/fixture/ui-tests.ts --simulator <udid>
bun run native/swift/fixture/ui-tests.ts -- -only-testing:TulaExampleUITests/AuthScreensUITests/testPasswordReset
```

Run from Xcode alone, the tests fail at once with "no fixture": a test runner in a
simulator cannot start a process of the machine, so the script does.

The build goes to `examples/swiftui/build`, which git ignores.

## What was run, and what was not

The thirteen tests of `AuthScreensUITests` and the five of `SecondStepAndAccountUITests`
passed with Xcode 16.4 on an iPhone 16 simulator with iOS 18.5, on one Mac; the run, with
its result line, is recorded in
[the unverified list](../../docs/plans/phase-2-unverified.md#step-214-the-swiftui-screens-the-second-step-and-the-account-tula-60-adr-0058).

Not run: a passkey sheet, Sign in with Apple, a Google sheet or a browser session (the app
passes none, so those buttons are not drawn here); a device; VoiceOver (the audit is a set of checks on the accessibility tree, not
a screen reader); an iPad; any other simulator, iOS version or Xcode; a GitHub runner (the
tests are in no workflow). The app was not run against a deployed API, only against the
fixture.
