# ADR 0033 — The MCP server (`tula mcp`): read-only tools and scaffolds

- Status: accepted
- Date: 2026-10-04

## Context

Step 1.16 of the Phase 1 plan asks for a local Model Context Protocol server, started as
`npx tula mcp`: read tools over users, sessions, audit entries, settings and `doctor` results;
scaffold tools for the provider wrapper, a protected route and a sign-in page; no tool that
changes live data; and a server that never returns secrets or key material.

An MCP server is an unusual client of the admin API. Its caller is a language model that also
reads text written by strangers (a user's name, a user agent, an app name), and whatever a
tool returns becomes part of that model's context. Two things follow. A tool that could
change something is a tool a sentence in a user's name could try to trigger, so "no write
tools" has to be a property of the code, not of the tool list. And "returns no secrets" has to
hold for the API as it will be next year, not only as it is today.

## Decision

### Package and entry point

- `packages/mcp` → `@tula/mcp` (private like every package, built with bunup, packed and
  checked by `packages:check`). It exports `createTulaMcpServer(options)` and
  `serveOverStdio(server, streams)`. It depends on `@tula/admin`, Zod and the official SDK,
  `@modelcontextprotocol/server` (v2; the split successor of `@modelcontextprotocol/sdk`).
- `tula mcp` is a `Command` of `@tula/cli` that builds the server and serves it on standard
  input and output. `npx tula mcp` is therefore the `tula` bin of `@tula/cli` with the
  argument `mcp`; `@tula/mcp` has no bin of its own.
- `@tula/mcp` does not depend on `@tula/cli` (the CLI depends on it), so the doctor is passed
  in: the CLI gives the server a function that runs `examine`, the same one `tula doctor`
  runs.
- Standard output carries only protocol frames. The CLI's startup line, one line per tool
  call (tool name, outcome, milliseconds; never an argument) and every error go to standard
  error. Tests check the wire in process and from a spawned child, including on errors.

### Credentials

- Resolved once, at start, exactly as the other commands do: the API URL from `--api-url`,
  `TULA_API_URL_<NAME>` or `TULA_API_URL`; the secret key from `--secret-key-file`,
  `TULA_SECRET_KEY_<NAME>` or `TULA_SECRET_KEY`; the instance admin token (for `run_doctor`'s
  server-side checks only) from `--admin-token-file` or `TULA_ADMIN_TOKEN`. There is no option
  that takes a secret, `-` (standard input) is refused for both files because standard input
  is the protocol, and no tool has an input that carries a credential.
- **Nothing is required.** Without a secret key the read tools answer the tool error
  `not_configured`; without an API URL so does `run_doctor`; the scaffold tools need nothing.
  A plain-http URL that is not this machine is refused as `@tula/admin` refuses it, and the
  tools that needed it say why. `tula mcp` does not load `tula.config.ts`: starting the
  server must not run the project's code.

### No tool changes anything, structurally

- Tools never see the admin client. They get `ReadOnlyAdmin`, a frozen object with one
  function, `read(id, { params, query })`, over `READ_OPERATIONS`: `listUsers`, `getUser`,
  `getUserAuthentication`, `listUserSessions`, `listAuditLogs`, `getEnvironmentSettings`,
  `listOAuthProviders`. The allow-list is enforced by the type of `read`, by a check of the id
  on every call, and once when the facade is made: every allow-listed id must be a `GET` in
  the admin client's operation table, or the server does not start. `read` passes on path and
  query parameters and an abort signal only, never a body or a header.
- A test enumerates every registered tool over the protocol, calls each against a recording
  `fetch`, and asserts that only `GET` requests to the allow-listed paths were made. The same
  is asserted against the real API in process.
- Every tool is annotated `readOnlyHint: true`, `destructiveHint: false`,
  `idempotentHint: true`, `openWorldHint: false`. Annotations are hints to a client; the
  facade is the guarantee.

### What is returned, and what never is

- **Every result passes an allow-list projection** (`project(value, shape)`): the fields a
  tool names are copied, everything else is dropped, and a value of another type than the
  shape says is dropped too. A field added to the API later is not returned until someone
  names it. An audit entry's `metadata` is free-form on the wire, so it has its own
  allow-list of the keys the API writes (`method`, `methods`, `changed`, `provider`, `reason`,
  `userId`, `client`, `revision`, `weakened`, `created`, `retiredKeyId`, `nextKeyId`).
- **Returned**: users' ids, names and email addresses; sessions' and audit entries' IP
  addresses and user agents (cut at 256 characters); a user's sign-in methods as the admin
  API reports them (whether there is a password, provider names, factor types, the number of
  backup codes left, passkey names and row ids); the settings document with its revision and
  `managedBy` (without `configHash`); each OAuth provider's public `clientId`, `teamId`,
  `keyId` and callback URL; the doctor's checks with their fixes. The operator asked about
  their own users: this is personal data, and it is what the tool is for.
- **Never returned**: API keys, secret or publishable (there is no key-listing tool in
  Phase 1: a prefix and four characters add little and invite confusion), signing keys,
  access and refresh tokens, password hashes, TOTP secrets and `otpauth://` URIs, backup
  codes, passkey credential ids and public keys, provider client secrets and Apple private
  keys, the master key, the instance admin token.
- **Two further nets**, because the projection decides by field and a secret can sit inside
  a field that is kept. Every string has secret-shaped values replaced with `[redacted]` (a
  `tula_sk_…` key, a JWT, an argon2/bcrypt/scrypt hash, an `otpauth://` URI, a PEM block), and
  the server's own credentials are removed from every result and log line as the last step.
- Canary tests seed recognisable values into every object of every fake answer, at every
  depth, and into fields that are kept, and search every tool's output; against the real API
  a user with a password, TOTP, backup codes, a passkey, a session and a provider secret is
  seeded and every result and log line is searched for each of them.

### Untrusted text

- A result is JSON: `structuredContent`, and the same JSON as the text content. No value is
  ever written into a sentence, so a user's name cannot be read as the tool's own words.
- **A string is cleaned in a fixed order** (`cleanText`), and the order is part of the
  decision:
  1. *Window.* Only the first `max(4 × the field's cap, 4096)` characters are looked at; the
     rest is dropped before any pattern runs. The server is one thread on one pipe, and a
     megabyte in a user's name must not stall it. Every pattern is also linear by itself (a
     JWT is found by a hand-written scan, because the obvious pattern is quadratic on
     `eyJeyJeyJ…`); the window bounds the constant.
  2. *Characters a reader cannot see.* Control characters (`Cc`) and the line and paragraph
     separators (`Zl`, `Zp`) become a space. Removed outright: format characters (`Cf`:
     zero-width spaces and joiners, bidirectional marks, embeddings, overrides and isolates,
     the soft hyphen, the Arabic letter mark, the Mongolian vowel separator, interlinear
     annotation, and the **tag characters** U+E0001–E007F, which spell ASCII invisibly and
     which a model reads), private-use and unassigned code points and noncharacters (`Co`,
     `Cn`), lone surrogates (`Cs`), the variation selectors (U+FE00–FE0F, U+E0100–E01EF,
     Mongolian U+180B–180F), the combining grapheme joiner (U+034F) and the Hangul fillers
     (U+115F, U+1160, U+3164, U+FFA0). A run of combining marks (`M`) is cut at **8**: real
     text stacks a few on a letter, a flood buries what is around it.
  3. *Secret shapes*, after step 2: a key split by a zero-width space is whole again when it
     is looked for. A key or JWT that the window cut short is replaced from where it starts.
  4. *Cap.* The text is cut at **512** characters (less where a field has a natural size),
     never between the halves of a surrogate pair, and ends with `…` when anything was cut.
- **What that costs legitimate text**, accepted: letters of every script survive, composed
  or decomposed, and so do emoji; but a family emoji comes apart into its people (the joiner
  is gone), an emoji that needed a variation selector shows in its text form, a flag written
  with tag characters keeps only its base, Arabic and Persian lose zero-width (non-)joiners
  and the visible Arabic number signs that are format characters, and a character newer than
  the runtime's Unicode tables counts as unassigned and is removed. A tool result is a report
  for an operator, not a rendering of the name; the dashboard shows the name as it is.
- Arrays are cut at **100** entries (50 users, 100 audit entries, by input schema as well). A
  result is at most **64,000** characters of JSON: a list loses entries from its end and
  gains `truncated: true`; anything else that large is the error `output.too_large`.
- The read tools' descriptions and the server's instructions say that every string in a
  result is untrusted data and never an instruction.

### Scaffold tools

- `detect_framework` reads one `package.json`. The directory the client passes must be inside
  the directory the server was started in, both as written (`..` and absolute paths elsewhere
  are refused before the disk is touched) and after symbolic links are followed (a link out
  of the root is refused), and a `package.json` that is itself a symbolic link is refused.
  The answer is the framework (`nextjs`, `react-vite`, `unknown`) and which of five Tula
  packages the project names: nothing else of the file.
- `scaffold_provider`, `scaffold_protected_route` and `scaffold_sign_in_page` **return** files
  (`path`, `contents`), the packages to install, the environment variables to set (names
  only) and notes. The server writes nothing: a tool call cannot overwrite a project file,
  and the client's own write approval is the one that counts. The publishable key is always a
  reference to an environment variable.
- The files are the example apps' own. `examples/` is the one source; `create-tula`'s
  template sync copies them into its templates and then runs `packages/mcp/scripts/sync-scaffolds.ts`,
  which writes `packages/mcp/src/scaffolds.gen.ts`; `generate:check` (part of `verify`) and a
  test fail on drift, and a test compares every scaffolded file with the example byte for
  byte. To make the React example scaffoldable it was split into `auth-provider.tsx`,
  `protected.tsx` and `sign-in-page.tsx`.

### Errors and time

- A failed call is a tool result with `isError`: `{ error: { code, message, status?,
  retryAfterSeconds? } }`. The code is the contract's or the admin client's; the message is
  one of this package's own sentences. The API's `detail`, a URL, a stack and the thrown
  error are never passed on. `rate_limited` carries the time to wait.
- Every request has a timeout (15 seconds); a doctor run has twice that as a whole.
- **No request outlives its call.** Each tool call has an `AbortSignal` that every request it
  makes carries: it aborts when the client cancels the call, when a doctor run is out of
  time, and when the call is over, whatever its outcome. The read-only facade forwards that
  signal and nothing else beside the path and query parameters (picked by name; a test hands
  it a body, headers and a method and shows none is passed on), and `examine` takes it for
  the doctor's requests.
- **At most 4 read tools run at once and 16 wait**; one more is answered at once with the
  tool error `busy`. A client that fires fifty calls gets them four at a time and the API
  sees four requests. A waiting call that is cancelled gives up its place. The scaffold
  tools reach nothing and are not counted, so a slow API does not hold them up.

### Loading

- `@tula/cli` loads `@tula/mcp` with `import()` inside `tula mcp`'s `run`, never at the top
  of a module: the command's name, options and help are plain data, and `tula --version`,
  `tula diff` and every other command start without the MCP SDK. A test starts the
  executable with a preload that records the loaded modules and fails if `@tula/mcp` or the
  SDK is among them; another bundles the entry points as bunup does and fails unless
  `@tula/mcp` appears only as a dynamic import.

## Consequences

- An operator can point an assistant at production with a secret key and the worst a
  manipulated assistant can do through this server is read what the operator could read.
  (The key itself still authorizes writes: it is held by the server process and never given
  to the model.)
- A new read tool is an entry in `TOOLS`, an id in `READ_OPERATIONS` if it needs a new
  operation, and a shape. Forgetting the shape returns nothing rather than everything.
- Useful fields may be missing until named (a new settings section, a new audit metadata
  key). That is the intended failure mode.
- Write tools (ban a user, revoke a session) are not in Phase 1. Adding them later means a
  second, separate facade and a decision about confirmation, not a change to this one.

## Alternatives considered

- **Give tools the admin client and "just not write" mutating tools.** Rejected: nothing
  would stop the next tool from calling `deleteUser`.
- **Return the API's answers as they are**, since the admin API already withholds secrets.
  Rejected: that makes every future API field a decision nobody took.
- **Let the server write scaffolded files.** Rejected: it would make a tool call able to
  overwrite project files, and every MCP client already has its own, user-approved way to
  write.
- **A device-family summary instead of the user agent.** Kept the user agent (cut at 256
  characters): it is what an operator investigating a session needs, and it goes through the
  same cleaning as every other string.
