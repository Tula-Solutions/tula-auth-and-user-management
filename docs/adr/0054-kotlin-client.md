# ADR 0054 — The Kotlin client: flows and a session on the JVM, the Keystore beside it

- Status: accepted
- Date: 2026-10-12

## Context

Step 2.15 of [the plan](../plans/phase-2.md) is a Kotlin SDK. Its types are generated
([ADR 0050](0050-native-type-generation.md)); everything with behaviour is written by hand.
This record is the first hand-written part (TULA-38): a library with no UI that signs a user
up and in with a password, an emailed code or a texted code, resets a password, and keeps
and refreshes the session. Passkeys, native Google, provider sign-in, device binding and the
second-factor and step-up calls are TULA-57; the Compose screens are TULA-50 and TULA-61.

The client has to behave as `@tula/core` does ([ADR 0021](0021-core-sdk.md)): the server is
one, and an app's users must not be signed out by one SDK where another would have kept
them. And its tests have to run where the repository's other tests run: on Linux, in CI,
without a phone.

## Decision

### Two modules, split by what needs a device

| Module | What | Built with |
| --- | --- | --- |
| `native/android/tula-auth` | The client: flows, session, the storage interface, the generated types. | Plain Kotlin on the JVM. No Android SDK, no Android API. |
| `native/android/tula-auth-android` | `KeystoreTokenStorage`: the encrypted, Keystore-backed storage. | The Android Gradle Plugin; `minSdk` 28. |

Everything that decides whether a user stays signed in is in the first module, so that all
of it is tested on a JVM. The second holds only what cannot exist without Android (the
`AndroidKeyStore` provider and `SharedPreferences`), and is as thin as that allows: the
sealing format, "a value that does not open is no token" and "a store that fails is not
signed out" are `SealedTokenStorage` in the first module, tested there with a software key.
The Android module is part of the Gradle build only where an Android SDK is known
(`ANDROID_HOME`, `ANDROID_SDK_ROOT` or `sdk.dir`), so the client's tests need a JDK and
nothing else.

**The JVM module is compiled against a JDK's class library, and nothing checks that it
uses only what Android has.** It was written to (no `java.net.http`, no
`InputStream.readNBytes(int)`, which Android has from API 33 only), and that is care, not
a tool: a Java API that Android lacks at API 28 would compile and pass every test here.
An Android lint run over it, or its tests on an emulator, is what would show one; neither
exists yet ([what is not verified](../plans/phase-2-unverified.md#step-215-the-kotlin-client-tula-38-adr-0054)).

### The API 28 floor

`minSdk` is 28 (Android 9). The floor is not this ticket's need: nothing in it needs more
than API 23 (`KeyGenParameterSpec`, AES-GCM in the `AndroidKeyStore`). It is set now for
what TULA-57 adds to the same artefact, so that an app does not adopt a floor that then
moves. Android's passkey guide, read on 2026-10-12, says: "Credential Manager's passkeys
implementation works on devices running Android 9 (API level 28) and higher"
(`developer.android.com/identity/passkeys`), and the same page said the same when read
again that day after the rebase. Android's Keystore guide, read on 2026-10-12
(`developer.android.com/privacy-and-security/keystore`), says: "Devices running Android 9
(API level 28) or higher can include a StrongBox KeyMint", to be asked for at run time with
`FEATURE_STRONGBOX_KEYSTORE`. That page gives no API level for the method
`setIsStrongBoxBacked` itself; its reference page was not read, and TULA-57, which uses
it, reads it.

### The same client as `@tula/core`, rule for rule

| Rule | Here |
| --- | --- |
| One refresh at a time | A `Deferred` started in the client's own scope; every caller that needs a token while it runs awaits the same one. A caller that is cancelled does not cancel the refresh for the others. |
| A refresh gives up inside the grace window | `REFRESH_TIMEOUT_MS` = 8,000, below the server's shortest reuse grace period (10 s). `.claude/hooks/kotlin-journeys.test.ts` holds it equal to `@tula/core`'s. |
| A deadline does not rest on cancellation being honoured | A request runs in the client's own scope and the call waits for it for the timeout at most (`Transport.call`). An engine that does not end its request when it is cancelled (an app's own may not) is left behind and its late answer dropped; waited for, it would hold the single refresh past the grace window. A test has an engine that ignores cancellation. Only the call's own timeout is `network.timeout`: one the caller set around the call passes through as the caller's cancellation. The default engine does end its request: it closes the connection. |
| A refresh that got no answer is repeated once | At once, with the same token, inside the same flight, while `REFRESH_RETRY_WINDOW_MS` has room. An HTTP answer of any status is never repeated. |
| Only the server ends a session | `session.*`, `auth.unauthenticated` and `auth.user_banned` in answer to a refresh. A network failure, a 5xx, a 429, an unreadable answer and a storage failure keep the session and its stored token. `device.*` never ends one. |
| A failed sign-out is not a sign-out | `session.signOut()` forgets the session here and **throws** when the server could not be told; calling it again tells the server. An app navigates away only after one that returned. |
| An unknown step is "not supported" | `FlowStep.Unknown` is kept as it was sent, `flow.screen` is `NOT_SUPPORTED`, nothing is thrown and no request is made on a guess. The same screen answers a known step that offers only what this version cannot do. |
| A flow that is left is discarded | `flow.discard()` forgets the attempt's secret and drops the answer of an action in flight: a late `complete` signs nobody in. |
| A result belongs to the session it was asked for | A generation counter: an answer that arrives after a sign-out, or after another sign-in, changes nothing. `user()` shows its answer only under the session id it was asked under. |
| A completed sign-in is taken in whole | The tokens of a finished flow are installed, stored and shown in the client's own scope, as a sign-out is ended there: a caller cancelled half-way (its screen is gone) leaves no session that is neither stored nor shown. |

The attempt's secret lives in the flow object's private state, is sent as `x-tula-attempt`
on every step and is in no `toString`.

### Concurrency: one confined dispatcher

All of the client's state is touched on `Dispatchers.Default.limitedParallelism(1)`. No
lock is held across a suspension, and no `Mutex` orders the refresh: the confinement does.
`state` is a `StateFlow<AuthState>` (`Loading`, `SignedOut`, `SignedIn`), which is what
Compose collects.

### Storage is an interface, and has no default

`TokenStorage` (`get`, `set`, `remove`, all `suspend`). `TulaClient` takes one and has no
default: `MemoryTokenStorage` is a decision to forget the session with the process, and an
app must make it knowingly.

`KeystoreTokenStorage` seals the refresh token with an AES-256-GCM key that is generated
in, and never leaves, the `AndroidKeyStore`, with the entry's name as associated data (a
sealed value moved under another name does not open), and keeps the ciphertext in a
private `SharedPreferences` file. The plain token is in no preference. Four rules:

- **A value that can never be opened is no token, and that is two cases**: the key is gone
  (a restore onto another device carries the preferences and not the key; the app's data
  partly cleared), or the stored bytes are not this storage's writing (not base64, another
  format, another nonce length, cut short). The entry is removed and the client is signed
  out.
- **A tag that fails while the key exists is a failure**: it is thrown, the client says
  `storage.failed`, keeps the session it has, and nothing is deleted. The first version
  read it as "can never be opened" and removed the entry, which contradicted the next
  rule: a key store that answers wrongly once (a daemon restarting, a hardware fault)
  would have signed the user out for good, and nothing in the exception tells that from an
  entry that was altered or moved. The cost is stated: an entry that really cannot be
  opened (altered on disk, or restored onto a device that happens to have a key under the
  alias) is `storage.failed` at every start until the user signs in again or signs out.
  **Both clear it without opening it**: a sign-in writes over the entry, and a sign-out
  removes it whatever the read said (it reports `storage.failed`, because the token it
  could not read is one the server was not told to end).
- **A store that fails is not "signed out"**: any other error is thrown, the client says
  `storage.failed` and keeps the session it has in memory.
- **The decision is in the JVM module, so that it is tested.** `AesGcmSealer`
  (`tula-auth`) holds the format and the two outcomes above over a `SealingKeys`; the
  Android module supplies only the Keystore's key (`AndroidKeystoreKeys`). The tests run
  the same sealer with a key in memory. What they cannot show is which exception the
  Android Keystore raises for a failed tag on a given version: the rule assumes
  `AEADBadTagException` or anything else that is not "no key", all of which are thrown.

**The preferences file is in Android's backups unless the app excludes it.** Auto Backup
and device-to-device transfer copy `shared_prefs` by default. The copy is sealed and its
key stays behind, so it gives nothing away and reads as "no token" on the new device; it is
still a credential's ciphertext leaving the device for no purpose. The library cannot
exclude it (the rules are the app's resources and manifest), so `docs/kotlin.md` gives the
two rule files, and `.claude/hooks/kotlin-journeys.test.ts` holds the file name in them
equal to `DEFAULT_PREFERENCES_NAME`. A restore therefore signs the user out, by design.
- **One call at a time.** `SealedTokenStorage` runs its reads, writes and removals one
  after another: a read that removes an entry it could not open is two steps, and a token
  a sign-in wrote between them would be removed with the entry. The lock is the storage
  object's: two storages over one preferences file do not share it.
- **No user authentication on the key.** A refresh happens in the background; a key that
  needs a fingerprint would fail there. The device's lock is not this storage's gate.

Jetpack Security's `EncryptedSharedPreferences` was not used: it is deprecated, and the
part of it needed here is one small class over the platform's own API.

### HTTP: the platform's connection, behind an interface

`HttpEngine` is one `suspend` function; the default is `java.net.HttpURLConnection`, so the
library adds no HTTP dependency to an app. It follows no redirect, keeps no cookie, reads
at most 1 MiB of an answer and is given up when the caller's timeout cancels it.

**A request body is never streamed.** With a streaming mode the JDK's connection discards
the body of a 401 (it cannot repeat a streamed body with credentials), and every refused
sign-in and ended session is a 401 whose body holds the code: the first run of the
journeys against the real API read each as `response.invalid`. The engine's own test
serves a 401 and a 407 for it.

**That test is of the JDK's class, and Android's is another implementation.** The API's
401 carries no `WWW-Authenticate` header. On a JDK the status and the body are handed
over; whether Android's `HttpURLConnection` does the same for such an answer, on every
version from API 28, was not tried. If it raised an `IOException` instead, a refused
sign-in would read as `network.failed` and a session the server ended would never be seen
as ended. It is the first thing to try on a device, and until then an app has a way out:
`HttpEngine` is the seam, and an engine over OkHttp (no redirect, no cookie jar, every
status handed back with its body) is a few lines of the app's own. The library ships
none, to keep OkHttp out of an app that does not want it.

Nothing is logged: the module has no logger, and `HttpRequest`, `HttpResponse`, a flow and
`TulaError` print no header, body or secret.

### The tests run against the real API, over HTTP

`@tula/core` and `@tula/expo` run their journeys in process. A JVM cannot, so
`e2e/kotlin-fixture.ts` serves the real API (`createApp` on memory adapters, as
`e2e/server.ts` does) on a loopback port, and `bun run native:kotlin:test` starts it beside
Gradle and hands its address over.

- **A world per journey.** `POST /__test/worlds` makes an environment with its own
  adapters, clock and keys, served under `/w/<id>`. Journeys do not share rate limits, an
  outbox or settings, and can run in any order.
- **The server's clock is the test's.** A world's clock moves only when a journey says so
  (`advance`), together with the client's own fake clock, so "sixty-one seconds later" and
  "past the grace period" take no time.
- **Test routes are behind `e2e/guard.ts`** (no `Origin`, the exact loopback `Host`, no
  cross-site `Sec-Fetch-Site`), the fixture refuses to start without `KOTLIN_FIXTURE=1`,
  listens on 127.0.0.1 only, and lives outside `apps/api` and the image, as the browser
  tests' fixture does.
- **What a journey cannot do through the client it does as an operator would** (the admin
  API with the world's secret key: settings, hooks, a ban), with one exception: a phone
  number is put on an account by a fixture route, because the client has no account calls
  yet. The two journeys that use it say so.

Without the fixture's address the journeys **fail** with the command to run; they are
never skipped.

### The suite and the list

`JourneysTest` declares each journey with `@Journey("<scenario name>")` and each behaviour
with `@Behaviour("<id>")`. Two guards hold it to `conformance/client-journeys.json`:

- `.claude/hooks/kotlin-journeys.test.ts`, in `bun run verify`, reads the Kotlin file's text
  and calls the real `clientJourneyListProblems` and `clientSuiteProblems`.
- `GuardTest`, in the suite, does the same from reflection (the rules written again, as the
  list's own documentation asks of a reader in another language), refuses a key written
  twice, and checks that every annotated function is a `@Test` that is not ignored.

Both hold the `not_built` count per ticket. **`verify` shows that the declarations and the
list agree; only the `kotlin` CI job shows that the journeys pass.**

### CI

Two jobs of `.github/workflows/ci.yml`. `kotlin` runs `bun run native:kotlin:test`
(`:tula-auth:check`: the tests and the coverage bound) with the two Android SDK variables
emptied, so the build has the JVM module alone. `kotlin-android` compiles and lints the
Android module, after installing by name, with `sdkmanager`, the platform and the build
tools the module pins. They were one job at first: a problem with the runner's Android SDK
then failed the job the JVM tests were in, and a red job said nothing about the client.
`.claude/hooks/ci.test.ts` holds them apart and the installed names to the build file.
Nothing of Gradle's is cached, by the workflow's own rule that a push does all the work
itself. The wrapper's distribution is pinned with its SHA-256, the wrapper's
jar is validated in the job, and every plugin and dependency has an exact version in
`gradle/libs.versions.toml`.

Coverage is Kover's line coverage of the hand-written sources (the generated package is
excluded: its tests are the generator's), with a bound of 90%. It was 98% when set.

## What this is not

- **Not run on Android.** No device, no emulator, no instrumented test. `KeystoreTokenStorage`
  is compiled and linted and has never sealed a token.
- **Not published.** `dev.tula:tula-auth` is a placeholder name (decision D2); there is no
  publishing configuration.
- **No device binding.** A session of this client is not bound to a key. Under a profile
  that requires one the client is told so (`device.binding_required`) and holds no session.
- **No emailed link.** `CodeStrategy` has the two codes. A step that offers only a link is
  `NOT_SUPPORTED`.

## Consequences

- An Android developer can sign a user in from Kotlin with no UI of ours, on a client whose
  session rules are the TypeScript client's.
- CI gains a job that needs a JDK and downloads Gradle and the pinned dependencies on every
  run (uncached, on purpose).
- The Kotlin column of the client-journey list is decided: 31 journeys, 4 behaviours, 20 not
  applicable, 57 not built (53 for TULA-57, 4 for TULA-61), of 108 scenarios.
- Two things are care and not checks: the JVM module's use of Java APIs that Android has,
  and that the client's rules stay those of `@tula/core` beyond the one constant a test
  holds equal. A change to `@tula/core`'s session rules is made here in the same change.
