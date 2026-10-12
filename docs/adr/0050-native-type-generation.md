# ADR 0050 — Generated Swift and Kotlin types: data only, open where a response can grow

- Status: accepted
- Date: 2026-10-12

## Context

Steps 2.14 and 2.15 of [the plan](../plans/phase-2.md) are a Swift SDK and a Kotlin SDK
written by hand. Decision D7 of that plan says which part is not: the request and response
types, the error codes and the theme constants are **generated** from
`packages/contract/openapi.json` and the contract, by a generator in this repository, as
`@tula/core`'s TypeScript types are ([ADR 0021](0021-core-sdk.md)). This record is that
generator (TULA-22). The two SDKs themselves are TULA-37 and TULA-38 and do not exist yet.

What the generated code has to get right is what a hand-written client gets wrong first:
the API only grows within a version (a new step status, a new enum member, a new optional
key, a new error code), and a native app in a store cannot be updated the day the server
is. A decoder that fails on a value it has never seen turns a server release into a broken
sign-in screen on every installed copy.

## Decision

### Types and constants, never behaviour

The generator writes declarations of data: structures, enumerations, unions, the error
codes, the default theme and a table of the client operations. It writes **no** request, no
session, no storage, no flow engine and no function that could make one: the test of the
whole output fails for a file that names a networking, storage or concurrency API of either
platform. Everything with behaviour is written by hand in each SDK, beside the generated
directory.

### Where it lives, and what it writes

The generator is `packages/core/scripts/native/` (beside `openapi-types.ts`, whose reading
of the document it shares: `operationsUnder`, `reachableSchemas`), run by
`packages/core/scripts/generate-native.ts`:

- `bun run native:generate` rewrites two directories;
- `bun run native:check` fails when they differ from what the generator writes. It is part
  of `@tula/core`'s `generate:check`, which `bun run verify` and `verify:changed` run, and
  `native/**` is an input of that package's cached tasks (`packages/core/turbo.json`), so a
  hand edit of a generated file is not served a cached "passed".

| Directory | Files |
| --- | --- |
| `native/swift/Sources/TulaAuth/Generated/` | `Schemas.swift`, `ErrorCodes.swift`, `Theme.swift`, `Operations.swift`, `Support.swift` |
| `native/android/tula-auth/src/main/kotlin/dev/tula/auth/generated/` | `Schemas.kt`, `ErrorCodes.kt`, `Theme.kt`, `Operations.kt`, `Support.kt` |

The two directories hold generated files **and nothing else**: a file there that the
generator does not write is drift (the check reports it, the generator removes it). Every
file starts with a header that says it is generated, by which command, and not to edit it.
`.claude/hooks/protect-files.sh` refuses an edit under either.

The Swift package (`native/swift/Package.swift`, tools version 5.9, one library product
`TulaAuth`) and its test target are written by hand. There is no Gradle build yet: the
Kotlin files are sources at the path a module `tula-auth` will have, and the build that
compiles them arrives with TULA-38.

The names follow the plan and the business plan (`TulaAuth` for the Swift product). The
Kotlin package is `dev.tula.auth.generated` and the module directory `tula-auth`; the Maven
group is the plan's open decision D2 and neither name is a claim on one. Each is one
constant of the generator (`SWIFT_TARGET`, `KOTLIN_MODULE`, `KOTLIN_PACKAGE`): renaming is
a change there and a regeneration.

### Which schemas

Only the components reachable from an operation under `/v1/client/`: its JSON request body,
its success body and its error body, and everything those refer to. Nothing of `/v1/admin/*`
or `/v1/instance/*`, no event payload, no hook question. A native app holds a publishable
key and a user's session; a type for an administrator's route would be an invitation.

### Open and closed: a response can grow, a request cannot surprise its sender

**An enumeration or a union is *open* when its component is reachable from a response of a
client operation (a success or an error body), and *closed* when only requests carry it.**
One that both carry is open. A declaration written inline inside a component has its
component's direction.

- An **open enumeration** has a case per known member and one more for a string this
  version does not know, which keeps the string: Swift `case unknown(String)`, Kotlin
  `class Unknown` (its constructor is internal to the module and `of(rawValue)` is the way
  to a value, so a known string does not become an `Unknown`). It is read from any JSON string and written back as that string, unchanged.
  Equality and hashing are by the string on the wire. A member of the API that is itself
  called `unknown` gets the name `unknownValue` / `UnknownValue`.
- A **closed enumeration** is the language's plain one (Swift `enum X: String`, Kotlin
  `enum class`). A value outside it fails to decode, which only a request-only type can
  afford: the client is the one writing it.
- An **open union** (today there is one: the flow step, by `status`) has a case per known
  variant, each holding that variant's
  structure, and an unknown case that carries **the tag as the API wrote it and the whole
  object** (`TulaJSONValue` in Swift, `JsonObject` in Kotlin). It is written back as that
  object. So a step status a client has never heard of decodes, can be shown as "not
  supported" with its status in a log line, and loses nothing.
- A **closed union** (the bodies of a first-factor attempt, a second factor and a
  step-up, by `strategy` or `method`) refuses a tag it does not know, with a fixed message
  that does not repeat the tag.

A union needs a discriminator: one property that is a string constant in every variant.
The generator finds it; a union without one stops the generation (below).

### Keys

- A key this version does not know is **ignored**: Swift's keyed decoding does so by
  itself; Kotlin reads through the generated `TulaJson` (`ignoreUnknownKeys = true`, and
  nothing else of the format changed).
- A **required** key must be there, also when its value may be `null`; it is always
  written, as `null` when it has no value.
- An **optional** key may be missing or `null`, both read as "no value" (`nil` / `null`),
  and is **left out** when written with no value. The two are not told apart: no client
  operation gives them different meanings today, and a type that did would be written by
  hand.
- A constant (a discriminator, `const: true`) is an ordinary property with that value as
  its default, read like any other value of its type and always written. A decoder that
  insisted on the constant would fail the day it gains a second value.
- A property is camelCase in both languages, with the wire name kept beside it wherever
  they differ (`CodingKeys`, `@SerialName`).

### What a type is

| In the document | Swift | Kotlin |
| --- | --- | --- |
| `string` (any `format`) | `String` | `String` |
| `integer` | `Int` | `Long` |
| `number` | `Double` | `Double` |
| `boolean` | `Bool` | `Boolean` |
| `array` | `[T]` | `List<T>` |
| `object` with `additionalProperties: T` | `[String: T]` | `Map<String, T>` |
| nothing said, or several scalar types | `TulaJSONValue` | `JsonElement` |

**A `format` is documentation, never a type**: a `date-time`, a `uuid` and a `uri` stay
strings and the format is written in the property's comment. A date parser that refuses a
fraction of a second, or a URL type that refuses an address the server accepted, is a
decoding failure with nothing gained; an SDK that wants a `Date` converts where it uses it.

Swift uses Foundation and `Codable` only, with `init(from:)` and `encode(to:)` written out
for every type (the rules above are then in the file, not in what the compiler
synthesizes). Kotlin uses `kotlinx.serialization` with the JSON format: `@Serializable`
data classes, and a hand-shaped `KSerializer` for each open enumeration and each union
(JSON only: they read the element). A constant is `@EncodeDefault`, which is why the
schemas file opts in to `ExperimentalSerializationApi`.

### Names are a function of the document

A type is its component's name; an inline declaration is named from its parent and its key
(`AnswerNothing`) and a union's inline variant from the union and its tag
(`FlowStepNeedsPassword`). A name that is a keyword is escaped with backticks, one that
starts with a digit gets a leading underscore, and a type that would shadow one of the
platform's (`Error`, `Type`) is prefixed `Tula`: one tested function per language
(`swiftIdentifier`, `kotlinIdentifier`, `typeName`). **Two declarations or two members that
would get one name stop the generation**; nothing is renamed by position.

Declarations are in order of name and operations in order of id; the members of one
declaration keep the order the document or the contract gives them. The output is a pure
function of its sources, byte for byte (a test renders the document with its components and
paths reversed).

A description becomes a comment through one function (`commentText`): on one line, unable
to end the comment, and **in printable ASCII only**: a typographic quote becomes the plain
one and any other character is written as `U+XXXX`, so that nothing a reviewer cannot see
(a text-direction control above all) is in a generated source. A string literal is written
with escapes for everything outside printable ASCII, and with `$` escaped in Kotlin.

### Error codes and the theme come from the contract, not from the document

- `ErrorCode` is an open type written from `@tula/contract/error-codes`
  (`ERROR_DEFINITIONS`), with every code's HTTP status and default message as constants
  (`TulaErrorDefinitions`). The document's `ErrorCode` component is not rendered; it must
  equal the contract's list or the generation stops (the snapshot is then stale).
- The default theme is written from `@tula/contract/theme` (`DEFAULT_THEME`,
  `THEME_TOKENS`): a light and a dark scheme and the shared tokens, **as the strings the
  contract holds** (`"#5b4cf0"`, `"12px"`, a font stack). No `Color`, no `dp`: turning a
  CSS length or colour into a platform value is behaviour and is the SDK's. Only a token of
  `THEME_TOKENS` is written, and **only a value `isValidThemeValue` accepts**: a default
  that does not pass stops the generation, with a message that names the token and never
  the value.

### The operations table

`TulaOperations` lists every client operation as data: its id, method, path (with
`{name}` placeholders) and whether it needs a signed-in user's access token, with its body
and answer types named in the comment. It exists so that a hand-written client names a path
once, from the contract, instead of typing it. It is not a client and has no function.

### What stops a generation

Rather than guess, the generator throws for a shape it has no rule for: `not`,
`prefixItems`, `patternProperties`, `if` / `then` / `else`; a union with no discriminator
or with a variant that is no object; an `allOf` whose members are not plain objects or
disagree about a property; an object with named properties beside typed extra ones; an
enumeration of mixed types; an operation whose body or answer is written inline; two names
that collide. **None of these occurs in the client API today.** A new one fails
`native:check` in the change that introduces it, which is where the decision belongs.

## What is mapped loosely, on purpose

- **A value of several scalar types** (`ErrorParams`' values: a string, a number or a
  boolean) is a JSON value, not a union of the three.
- **An object that also allows other keys** (`additionalProperties: {}`: the passkey
  credential objects) keeps its named properties; the extra keys are not modelled and are
  dropped on a round trip. A passkey response is built by the SDK from the platform's own
  object, not passed through one of these types.
- **A non-string enumeration** is its primitive type.
- **Header and path parameters, and query strings, have no types.** Only JSON bodies do.
- **`OAuthProvider` and `IdTokenProvider` are closed**: today only requests carry them. The
  day a response does, the rule makes them open, which changes the Swift and Kotlin
  declarations (`enum` to an enum with a payload case; `enum class` to a sealed class): a
  source-breaking change of the generated surface that the diff of `native:generate`
  shows.

## How it is proven

- **In `bun run verify`, without a native toolchain**: the generator's unit tests
  (`packages/core/scripts/native/*.test.ts`), on fixtures (a discriminated union open and
  closed, an open and a closed enumeration, nullable against optional, nested arrays, maps,
  `allOf`, an unknown `format`, keywords and leading digits as names, hostile descriptions,
  a theme value the grammar refuses) with assertions on the emitted text, no snapshot
  file; the whole output for the real document (the file set, the headers, determinism,
  nothing of the admin API, both languages declaring the same names, no behaviour); and
  the drift check.
- **By hand, once, on 2026-10-12, with the compilers that were on the machine**:
  Apple Swift 6.1.2 type-checked the generated sources in language modes 5 and 6 with
  warnings as errors, and `swift test` ran `native/swift`'s 19 decode and round-trip tests;
  kotlinc-jvm 2.3.10 (the one bundled with Android Studio) compiled the generated Kotlin
  with `-Werror` against `kotlinx-serialization-json` 1.9.0 and 1.6.3, and a scratch
  program of 24 decode and round-trip checks passed on both.
  [`docs/plans/phase-2-unverified.md`](../plans/phase-2-unverified.md), "Steps 2.14 and
  2.15", has exactly what ran and everything that did not.

**No CI job compiles either language.** The check in `verify` proves the committed files are
what the generator writes, not that they compile: a change to a renderer can be green and
not compile. Until TULA-37 and TULA-38 add a job with a toolchain, whoever changes a
renderer compiles the result by hand and says so.

## Stated minimums

- **Swift**: tools version 5.9 in `Package.swift`. Compiled only by 6.1.2 (in the Swift 5
  and Swift 6 language modes); no 5.9 or 5.10 compiler was run. Every generated type is
  `Sendable`.
- **Kotlin**: `kotlinx-serialization-json` **1.6.3**, the lowest version the output was
  compiled against, with the Kotlin serialization compiler plugin. `@EncodeDefault` is
  still an experimental API of the library in 1.9.0. Compiled only by Kotlin 2.3.10.

## Accepted risks

- **A generated type prints what it holds.** A Kotlin data class's `toString()` and
  Swift's reflection write every field, among them an access token, a refresh token, a
  password in a request and an attempt's secret. The generator adds no redaction: it would
  be behaviour, and a `toString` that hides a field does not stop `"\(value)"` in Swift.
  The SDKs (TULA-37, TULA-38) must never log or interpolate one of these values, as the
  TypeScript SDKs' rule already says.
- **An unknown union case keeps the whole object**, which for an unknown flow step is
  whatever the server sent. It is held in memory like any decoded answer and written
  nowhere by the generated code.
- **`Long` and `Int` for every `integer`.** On a 32-bit Swift platform `Int` is 32 bits;
  the minimum OS of decision D4 (iOS 16) has none.
- **Optional and `null` are one thing.** A future operation that needs "absent" and "null"
  to differ needs a hand-written type or a new rule here.
- **The Kotlin unions read JSON only.** Another format of `kotlinx.serialization` throws.

## Not decided here

- The Maven group, the published names of either SDK and their versions (decision D2).
- A CI job with a Swift or a Kotlin toolchain (TULA-37, TULA-38).
- Types for header, path and query parameters, and typed functions per operation: a client
  written by hand may want them generated later; that is a new decision, and "no
  behaviour" stays.
- A theme stored per environment (the plan's decision D12): the constants are the
  contract's defaults.
- Whether `OAuthProvider` should be open ahead of the rule, to spare a later source break.
