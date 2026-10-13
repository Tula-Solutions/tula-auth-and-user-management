---
paths:
  - "packages/mcp/**"
  - "packages/cli/src/commands/mcp*"
---

# MCP server

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## MCP server (`packages/mcp`, see ADR 0033)

- **One tool changes live data, `test_signin`, and for every other that none does is
  structural.** A read tool reaches the admin API only
  through `ReadOnlyAdmin.read` (`packages/mcp/src/read-only.ts`), over `READ_OPERATIONS`: an
  allow-list of `GET` operation ids, checked by type, on every call and when the facade is
  made. Never hand a tool the admin client, a body or a header, and never add a non-`GET` id
  to the list. Beside the parameters the facade forwards one thing, an `AbortSignal`, picked
  by name: keep the test that hands it a body, headers and a method. What asks for a change
  is a separate facade (next rule); this one never grows a write.
- **A propose tool reaches the API only through `ProposingAdmin.propose`**
  (`packages/mcp/src/proposing.ts`, [ADR 0053](../../docs/adr/0053-proposals.md)), over
  `PROPOSE_OPERATIONS`: one operation id, `createProposal`, checked by type, on every call
  and, when the facade is made, to be a `POST` under `/v1/agent/`. It builds the body
  itself, field by field, from a `ProposalRequest` (a union made from `PROPOSABLE`, one
  member per operation with that operation's own kind of target, held by type to the
  API's enumeration) and forwards an `AbortSignal` and nothing else. **The two
  facades never merge**: `read-only.ts` imports nothing of `proposing.ts` (which takes one
  constant, the timeout, from it), `ReadOnlyAdmin` gains no method,
  and an operation that changes data directly is never added to `PROPOSE_OPERATIONS`
  (approving a proposal least of all: the server holds nothing that could). A propose tool
  is of group `propose`, is the one kind annotated `readOnlyHint: false`, and its result
  says `changed: false` and what a person has to do, in the tool's own fixed words. **With
  an agent key the server is given no secret key at all** (`options.agent`; the reads then
  go through the same read-only facade over the agent's client); a propose tool without
  one answers `not_configured`, never a fallback to the secret key.
- **`test_signin` reaches the API only through `SignInTester.run`**
  (`packages/mcp/src/testing-sign-in.ts`, [ADR 0058](../../docs/adr/0058-test-signin.md)), a
  third facade over `TEST_OPERATIONS`: one operation a kind of client (`runSignInTest`
  for an agent key, `runSignInTestAsAdmin` for a secret key), checked by type, on every
  call and, when the facade is made, to be a `POST` at exactly its route. `run` takes an
  `AbortSignal` and nothing else: no body, header, path or timeout of a tool's. It shares
  no operation with the other two facades, and neither of them gained a method. The tool
  is the only one of group `test`, is annotated `readOnlyHint: false` and
  `idempotentHint: false`, and its description, the server's instructions and `tula mcp`'s
  first line name it as the one tool that changes live data: **never say "no tool changes
  live data" of the server again, and never add a second tool to the group without an
  ADR.** With an agent key the run is the agent's; without a key of either kind the tool
  answers `not_configured`. Its result is the report through `project` (closed words,
  numbers, one id): keep the canary test.
- **A result is an allow-list projection** (`project(value, shape)`): name every field a tool
  returns; never spread or pass through an API answer, and never interpolate a value into
  prose. Results are JSON (`structuredContent` and the same JSON as text), cleaned and capped
  by `sanitize.ts` (512 characters a string, 100 entries, 64,000 characters a result). A new
  field that could hold a secret is not named; a new kind of secret gets a pattern in
  `SECRET_SHAPES` and a test.
- **`cleanText` works in a fixed order: window, invisible characters, secret shapes, cap.**
  Never match a secret shape before the invisible characters are gone (a zero-width space
  would split it), and never run a pattern over more than `inputWindow(max)` characters. The
  invisible set is Unicode classes (`Cf`, `Co`, `Cn`, lone surrogates, variation selectors,
  with `Cc`/`Zl`/`Zp` turned into a space and combining marks capped), matched with the `u`
  flag: do not narrow it to a list of code points, and write such characters in source as
  `\u{…}` escapes, never literally. A pattern added to `SECRET_SHAPES` must be linear (no
  quantifier inside another, nothing that fails after a long scan and starts again inside
  it) and gets a row in the "work is bounded" table. The tests check results a code point at
  a time against their own ranges (`testing/hidden.ts`), not against the pattern.
- **No request outlives its tool call, and reads are limited.** Every request a tool makes
  carries the call's signal (`withSignal`, `proposingWithSignal`, and the `signal` given to
  the doctor); four read or propose tools run at once, sixteen wait, the next is `busy`. A
  new read path takes the signal too.
- **`@tula-tech/cli` loads `@tula-tech/mcp` only with `import()` inside `tula mcp`.** Never import it at
  the top of a module of the CLI: `lazy-load.test.ts` fails if any other command loads it or
  the MCP SDK.
- **Never returned**: keys of any kind, tokens, hashes, TOTP secrets and URIs, backup
  codes, passkey credential ids, provider secrets. There is no key-listing tool.
- **Credentials come from the environment or a file, resolved once at start**; never a tool
  input, an option's value or anything written to standard output. **`tula mcp` looks for
  the agent key first and, with one, does not resolve the secret key** (no environment
  variable read into a client, no file opened), and says on standard error that it was
  left alone: keep the test that sets both. Standard output carries
  only protocol frames: everything else goes through `log` to standard error. `tula mcp` does
  not load `tula.config.ts`.
- **Scaffold tools return files and write nothing.** Their sources are the example apps
  (`scaffolds.gen.ts`, generated). `detect_framework` reads one `package.json` inside the
  server's working directory: keep the path-confinement table test when touching `detect.ts`.
- **A settings change is drafted, never made** (`draft_settings_change`,
  `packages/mcp/src/settings-draft.ts`, group `draft`;
  [ADR 0056](../../docs/adr/0056-mcp-settings-config-diff.md)). The tool answers an edit to the
  environment's entry in `tula.config.ts` for a person to apply with `tula diff` and
  `tula apply`. It is handed `ReadOnlyAdmin` and its parsed input and nothing else: it
  reads `getEnvironmentSettings` and, only when a provider is named,
  `listOAuthProviders`; it never reads or writes a file and never calls `loadConfig`, and
  its two sources import only `@tula-tech/config`, `@tula-tech/contract`, Zod and the package's own
  modules (a test scans them). **`@tula-tech/config` has one entry point, so its loader is in
  the import graph; what is kept out is the call**: from it the tool takes `env`,
  `parseConfig`, `providerSecret` and `isConfigError` and nothing else, and the scan fails
  for a source that names `loadConfig`, `DEFAULT_CONFIG_FILE`, `resolveSecret` or
  `requiredSecrets`. Never give it a path, a working directory or `fetch`.
  - **A setting that can be drafted is a setting `get_settings` returns**: a path is
    judged by `SETTINGS_DOCUMENT_SHAPE` (`settingShape`), the one allow-list for both.
    Never a second list, never a path this version does not know, and a value is a scalar
    or a list of strings, never an object. There is no field for a webhook endpoint, a
    hook or a native app: each is a decision of its own.
  - **A provider's secret is `env(secretEnv)` and can be nothing else.** `secretEnv` is a
    variable's name, required, judged by `@tula-tech/config`'s own `env()` (never a copy of its
    grammar) in the schema, before any request; the entry is validated by `parseConfig`;
    the result's shape has `{ $env }` at `clientSecret` and `privateKey` and no place for a
    string. Never add an input a secret could be put in, and never build that field from
    the server's answer. **The name of one of Tula's own credentials is refused by the
    schema** (`DEPLOYMENT_CREDENTIALS`, a closed list, and the prefixes `TULA_SECRET_KEY_`
    and `TULA_AGENT_KEY_`; fixed words, the name not repeated): `tula apply` would send
    that variable's value to the server as a client secret. A new variable of `env.ts` or
    the CLI that holds a credential gets a row there and in the test's table. Never guess
    "a pasted secret" from a name's length or alphabet: the `notes` tell the person to
    read every `$env` name, and that stays.
  - **The result is edits by key, never file text**: no generated TypeScript, no diff of a
    file, no value in a sentence. `nextStep` and `notes` are constants and `changed` is
    `false`. Every field goes through `project`, a setting's `from` and `to` through that
    setting's own shape. **A value the projection would alter is refused
    (`not_returnable`), never returned altered**, and an edit that does not fit is
    `output.too_large`, never a list cut short: never raise a cap for it.
  - **No rule of its own.** Validity is the contract's `EnvironmentSettingsInputSchema` on
    the whole document the change would make; what weakens is `settingsWeakenings` and
    `oauthProviderWeakenings`, under the names `tula diff` prints. A refusal
    (`change.invalid`) lists `{ path, code }`: a validator's path and closed code, never
    its sentence and never a value; at most 50, and a list that left a problem out says
    so (`truncated: true`, `problemsOmitted`). A settings document this version cannot read is
    `settings.unreadable` and drafts nothing: never draft on a guess.
- A new tool is an entry in `TOOLS` with a strict input schema (`z.strictObject`), an entry in
  the tests' argument tables (the enumeration, canary and real-API tests run every tool) and
  a line in `docs/mcp.md`.

## Modules and tests in detail

What the section above does not say (moved from `sdk.md`).

- `sanitize.ts` owns the caps, the cleaning and `SECRET_SHAPES`.
- In `@tula-tech/cli`, `tula mcp` refuses `-` for every key file; that standard output carries
  only protocol frames is held by the wire tests and the spawned ones; and because
  `@tula-tech/mcp` is loaded only inside the command, the command's metadata stays static.
