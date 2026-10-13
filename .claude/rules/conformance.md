---
paths:
  - "conformance/**"
  - "packages/conformance/**"
  - "apps/api/src/testing/sdk-journeys.ts"
  - "**/*journeys*.test.ts"
  - "native/swift/Tests/**"
  - "native/android/**/JourneysTest.kt"
---

# Conformance scenarios and client journeys

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## Testing

- **Every conformance scenario has a decision for every client, in one file.**
  `conformance/client-journeys.json` lists, for each scenario (by its `name`, in order of
  name) and each client kind (`core`, `expo`, `swift`, `kotlin`: a closed list), one of
  `journey`, `not_applicable` with a reason, `not_built` with a `ticket` (`TULA-<n>`) and a
  reason, or `undecided` (leaving the client out says the
  same). `undecided` passes only while the file says that client's suite is `planned`; for
  one that `exists` it fails. **`not_applicable` means no client of that kind can ever
  reach it; "this client has no call for it yet" is `not_built`**, which names the issue
  that turns it into a `journey`, is allowed only for a scenario (never a behaviour) of a
  client whose suite exists, fails the guard once a test stands behind it, and is counted
  (`notBuilt(list, client)`; each suite holds its count in a test: `core` has none, and
  gets none). The journeys are one function, `sdkJourneys(target)`
  (`apps/api/src/testing/sdk-journeys.ts`): it declares every journey for the client its
  target builds and ends with the guard. `apps/api/src/sdk-journeys.test.ts` calls it for
  `@tula/core` and is `core`'s suite; `packages/expo/src/journeys.test.ts` calls it for
  `@tula/expo` and is `expo`'s. **`swift`'s suite is not that function**: it is XCTest
  methods (`native/swift/Tests/TulaAuthJourneyTests`) against the real API served by
  `native/swift/fixture/server.ts`, read from their sources and held to the list by
  `native/swift/fixture/journeys.ts` with the same two checks ("Swift SDK" above). A
  scenario's journey for `swift` is written there, in Swift. **Nor is `kotlin`'s**: it is
  JUnit tests (`JourneysTest.kt`) over HTTP against the real API served by
  `e2e/kotlin-fixture.ts`, held to the list by `.claude/hooks/kotlin-journeys.test.ts` (from
  the file's text, in `verify`) and by `GuardTest` (by reflection, in the suite), with the
  same two checks ("Kotlin client" above). A journey that needs what a target lacks (`browser`,
  `oauth`, `passkeys`, `deviceKey`) is behind a plain `if` on that capability, never a
  `skip`: it is then not declared, and the list must say `not_built` (or, where the kind of
  client can never do it, `not_applicable`) for that client or the guard fails. The guard fails for a scenario with no
  decision for `core`, an entry that names no scenario, a `journey` with no
  `journey('<scenario name>', …)` there, and a `journey(…)` for what the file says is not
  applicable or not built. When you add a scenario, add its entry and its journey in the same change.
  The checks are `clientJourneyListProblems` and `clientSuiteProblems`
  (`packages/conformance/src/client-journeys.ts`, tested on fixtures of their own): a
  client's suite calls them or does the same from the JSON Schema, and never a looser
  version. **A key of the file is written once**: `loadClientJourneys` refuses a duplicate
  from the file's text (`duplicateJsonKeys`; a parser keeps one of the two and says
  nothing), and a reader in another language refuses it too. **A journey counts from where
  it is declared**, so the guard also fails for a member `skip`, `todo`, `only`, `if`,
  `skipIf`, `todoIf` or `failing` (dotted or in brackets, called or only read) and for an
  `xit`, `xtest` or `xdescribe` anywhere in that file (`testsThatMayNotRun`, a scan of
  the text: reword a comment or a string it finds, never the scan; what it cannot see is
  listed in its JSDoc). **Adding a suite for a
  client flips its `suite` to `exists` in that change, and
  then decides everything**; never set it back to `planned` to get a suite green, and
  never write a decision for a client nobody has built a suite for on a guess.
- **The named client behaviours are cases of the same file** (`behaviours`: what a client
  does on its own, between requests, which no HTTP scenario can show): `concurrent_refresh`,
  `refresh_without_answer`, `unknown_step_not_supported`,
  `session_kept_through_failed_refresh_offline`. The ids are a closed list
  (`CLIENT_BEHAVIOURS`); a new one is added there, described in the file and decided like a
  scenario. For `core` and `expo` each is a `behaviour('<id>', …)` test of its suite,
  against the real API, and the same guard holds the file and those tests to each other.
  `@tula/core` draws nothing, so its test of `unknown_step_not_supported` is that the step
  is handed on unchanged, with no error and no request made on a guess; the screen is
  `@tula/react`'s and is tested there. `@tula/expo`'s is that `flowScreen` answers
  `not_supported`, and the Swift client's that `FlowScreen` is `notSupported` with the step
  kept as it was sent; the Kotlin client's that `flow.screen` is `FlowScreen.NOT_SUPPORTED`,
  the step kept as `FlowStep.Unknown`.
