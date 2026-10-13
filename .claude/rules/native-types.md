---
paths:
  - "packages/core/scripts/**"
  - "native/swift/Sources/TulaAuth/Generated/**"
  - "native/android/tula-auth/src/main/kotlin/dev/tula/auth/generated/**"
---

# Generated native types

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## Generated native types (`packages/core/scripts/native`, see ADR 0050)

The Swift and Kotlin types of the client API, the error codes, the default theme and a
table of the client operations are written by `bun run native:generate`. The two SDKs
themselves (TULA-37, TULA-38) are written by hand, beside the generated directories.

- **Types and constants, never behaviour.** No request, session, storage or flow logic is
  generated, and no function that could make one; `index.test.ts` fails for a generated
  file that names a networking, storage or concurrency API. A feature that needs behaviour
  is hand-written in the SDK.
- **Only what a `/v1/client/` operation reaches** (a JSON body, a success body, an error
  body). Never a type of `/v1/admin/*` or `/v1/instance/*`, an event payload or a hook
  question.
- **An enumeration or a union is open when a response of a client operation can carry
  it, and closed when only requests do** (one function of the model, `buildModel`: never a
  list of names). Open keeps what it does not know and writes it back unchanged: an
  enumeration its string, a union its tag and the whole object. Never make a response type
  closed to tidy it: a store-installed app must decode a status the server gained after it
  shipped. A key this version does not know is ignored; a required key must be there (also
  when nullable); an optional key that is missing or `null` is "no value" and is left out
  when written.
- **A `format` is a comment, never a type.** A date, a UUID and a URL stay strings.
- **A shape with no rule stops the generation** (`not`, a union without a discriminator,
  two names that collide, an inline body, …): never add a fallback that guesses. A new
  rule is a line in ADR 0050 and a row in `model.test.ts`. **A name the generator writes by
  itself is a declaration under the same rule**: a new support type goes in
  `SUPPORT_TYPE_NAMES`, which `declare()` checks, and a `<X>Serializer` beside an
  enumeration or a union `X` is refused. A member that cannot be written (a Swift property
  `hashValue`, a discriminator `raw` or, in Kotlin, `value`, a Kotlin nested class that
  would hide a type its class names) stops the generation by name; never rename one
  silently. **A name of the document is never looked up on a plain object**
  (`Object.hasOwn`, a `Map`): `constructor` and `__proto__` are ordinary property names.
  `hostile.test.ts` has a row for each.
- **Names are a function of the document**, escaped by one tested function per language
  (`swiftIdentifier`, `kotlinIdentifier`, `typeName`); nothing is renamed by position.
  Output is byte-stable: declarations in order of name and operations in order of id, both
  compared by code unit (never `localeCompare`: its order is the ICU data's of whoever runs
  it; the shared `openapi-types.ts` keeps its own sort, which the two `api.gen.ts` are
  written in), members in the document's order.
- **Text from the document reaches a file only through `commentText` (a comment: one line,
  printable ASCII, cannot end the comment) or `swiftString` / `kotlinString` (a literal:
  everything outside printable ASCII escaped, `$` escaped in Kotlin).** Never interpolate a
  description, a summary, a message, a value, a property's wire name or a discriminator
  any other way: a new place that writes document text gets a row in the hostile table of
  `hostile.test.ts`, which fails for a line that left its comment.
- **`ErrorCode` is written from `@tula-tech/contract/error-codes`** and the document's copy must
  equal it. **The theme is the contract's strings**, only for tokens of `THEME_TOKENS`, and
  only a value `isValidThemeValue` accepts (a refused default stops the generation and the
  message never repeats the value). No platform colour or length object is generated.
- **Swift is Foundation and `Codable`; Kotlin is `kotlinx.serialization`'s JSON.** No other
  dependency in a generated file. A companion's list of known members is `by lazy` (built
  eagerly it can be read while a member object is still being made, and holds `null`).
- **`verify` proves the committed files are the generator's output, not that they
  compile**: no job of `verify` has a Swift or a Kotlin toolchain (the `Swift` workflow
  compiles the Swift files when it runs `swift test`, and CI's `kotlin` job the Kotlin files
  when it runs `bun run native:kotlin:test`). A change to `swift.ts` is compiled by hand
  (`swiftc -typecheck`, `swift test --package-path native/swift`), one to `kotlin.ts` with
  `bun run native:kotlin:test`, and
  `docs/plans/phase-2-unverified.md`, "Steps 2.14 and 2.15", says what was run. Never
  write that the generated code compiles for a language, a compiler version or a change
  nobody compiled.
- **A generated type prints what it holds** (tokens, a password in a request, an attempt's
  secret): the SDKs never log or interpolate one, and the third line of every generated
  file says so (`GENERATED_HEADER`; a test holds it for every file).
- **The two generated directories are generated whole** (`scripts/native/tree.ts`):
  whatever is in one that the generator does not write is a stray, reported by the check
  and removed by the generator: a file, a directory (with what is in it), a symbolic link
  (the link, never its target; never read or written through) and a `.DS_Store` alike.
  Never add an ignore list, and never read an entry there without knowing it is a regular
  file. Nothing outside the two directories is touched: a generated path that is not
  directly in one is refused before any write.
- **The generated directories and every directory above them, up to the repository's root,
  are real directories or nothing is touched** (`directoryProblems`, `lstat` on each part
  and the real path compared): a symbolic link there leads somewhere else, and "everything
  here is a stray" would remove a stranger's files. Both directories are judged before
  either is read; `native:generate` then throws a fixed sentence naming the path from the
  root and removes and writes nothing in either, and `native:check` reports it and exits 1.
  Never read a generated directory by another function than `readGenerated`, and never
  judge one directory after the other has been written. The look is made once, before the
  first read: a directory swapped for a link during a run is not defended against, and the
  ADR says so.
