---
paths:
  - "packages/cli/**"
  - "packages/config/**"
  - "packages/create-tula/**"
  - "examples/tula-config/**"
---

# The CLI, the config file and create-tula

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## Publishable packages (see ADR 0020)

- **The CLI never prints a secret and never takes one as an argument** ([ADR 0030](../../docs/adr/0030-config-and-apply.md)).
  The API URL and secret key come from the environment (`TULA_API_URL[_<NAME>]`,
  `TULA_SECRET_KEY[_<NAME>]`) or `--secret-key-file`, never from the config file. All output
  goes through `packages/cli/src/output.ts` (commands get an `Output`, never a stream or
  `console`), which redacts the key and every resolved provider secret. A provider secret in
  a config is `env('NAME')` only; an error never repeats a value from the file.
- **`tula apply` never overwrites a change made elsewhere**: the settings are replaced under
  `If-Match` with the plan's revision, writes are ordered so no intermediate state lacks a way
  to sign in (`orderOperations`), and a partial failure reports what was and was not applied.
  It refuses, before any write, a plan that would reset settings this version does not know
  (unless `--allow-unknown`) and, under `--yes`, a plan that weakens security (unless
  `--allow-weaker`). A key read from standard input is never typed at a terminal, and then
  `apply` needs `--yes`.
  A new diff rule (a list that is a set, a field kept from the server) is documented in
  `docs/config.md` and gets a table test in `packages/cli/src/diff.test.ts`.
- **Webhook endpoints in the config file** ([ADR 0030](../../docs/adr/0030-config-and-apply.md),
  "Webhook endpoints in the file"). An endpoint is **its address, compared exactly**
  (`planWebhooks`): never normalise one, the server does not. No `webhooks` key means not
  read and not touched, even with `--prune`; with a list, what it leaves out is *unmanaged*
  and removed only with `--prune`. Event types are a set and `enabled` is managed only when
  written. **A secret is never in the file** (no field; keep the `@ts-expect-error` and the
  run-time test) **and never printed unasked**: the created endpoint's secret goes into the
  output's redaction before anything else runs, unless `--show-secrets`, and a plan that
  creates an endpoint without `--secrets-file`, `--show-secrets` or `--discard-secrets` is
  refused before any write. The secrets file is **created exclusively**
  (`Host.createSecretFile`: one step that asks and takes the name, so whatever is at the
  path, a file with any content, a link, a pipe, is refused and left alone) before the
  first write; the look at the path before the question is a courtesy, never the guarantee.
  It is rewritten (`Host.writeSecretFile`) only while it still holds what this run last
  wrote, and removed again if this run wrote nothing into it. **A created endpoint is
  reported as created whatever happens to the file**: a secret that could not be written
  is said as "not kept, rotate it", printed only with `--show-secrets`, and never counted
  in "Wrote N". The two defences of a secret are tested apart: one test where redaction is
  all that stands between it and an error the API echoes it in, one that the "shown this
  once" line is absent without the flag. Under `--yes` a
  removal needs `--allow-webhook-removal`. Webhook writes come **after** the settings and
  every provider (updates, creations, removals; removals first only as far as the limit of
  ten forces), and the endpoints are read again before the first of them
  (`webhookSnapshot`): keep that read, and do not call it a guarantee (endpoints have no
  revision); when the read itself fails the run says that, never that an operation failed.
  An address with a user name or a password is refused by the config's schema, by
  position: every address is printed. An address the server has twice and a plan over the limit are `planBlockers`:
  `diff` exits 1, `apply` writes nothing. Text from the server (an address, a
  `disabledReason`, an id) is printed through `printable()`. Every test of `apply` that
  creates an endpoint asserts the secret is absent from all output unless asked for.
- **Hooks in the config file** ([ADR 0030](../../docs/adr/0030-config-and-apply.md), "Hooks in
  the file"). `hooks` is keyed by point, and **a hook is its point**, never its address
  (`planHooks`): a changed address is an update that keeps the id and the secret. No
  `hooks` key means not read and not touched, even with `--prune`; a point left out is
  *unmanaged*; a point this version does not know is never touched, `--prune` included.
  **An entry is the whole hook**: `enabled`, `deadlineMs` and `failureMode` left out are
  the API's defaults and are managed (never "unmanaged when left out": a hook left at
  `allow` by a file that says nothing would be a check nobody has). **What weakens is the
  contract's `hookWeakenings` and nothing else**, under the paths
  `hooks.<point>.failureMode`, `hooks.<point>.enabled` and `hooks.<point>` (a hook that is
  on, removed), in `plan.weakened`: `apply --yes` refuses it without `--allow-weaker`
  before any write, and there is no flag of its own for removing a hook. A created hook's
  secret is an endpoint's in every respect (no field in the file, redacted first, the same
  three options and the same secrets file, its entry beginning with `hook`). Hook writes
  come last, after the webhook endpoints: creations, changes that weaken nothing, changes
  that weaken, removals; the hooks are read again before the first (`hookSnapshot`). A new
  rule gets a row in `packages/cli/src/diff.test.ts` and a line in `docs/config.md`.
- **Native apps in the config file** ([ADR 0040](../../docs/adr/0040-native-app-identity.md)).
  `nativeApps` is a list, and **an app is its platform and its identifier**
  (`planNativeApps`). No key means not read and not touched, even with `--prune`; with a
  list, what it leaves out is *unmanaged* and removed only with `--prune`; a platform this
  version does not know is never touched. Fingerprints are normalised when the file is
  loaded and compared as a set. **What weakens is the contract's `nativeAppWeakenings`**,
  under `nativeApps.<platform>/<identifier>` (with `.teamId`, `.sha256CertFingerprints` or
  `.appLinkPaths` for a change), in `plan.weakened`; a removal needs no flag of its own.
  `appLinkPaths` is a set, and **left out of an entry it is unmanaged** (ADR 0044): the
  server's paths are kept, nothing is planned or weakened, and the diff prints one line
  with their count (`unmanagedLinkPaths`; a count, never a path). Written, also as `[]`,
  it is the whole set and what it leaves out is removed, with no flag. It is the one field
  where "left out" is not "none" (a hook's rule does not carry over: a kept path is no
  check missing, and a file from before the field must not remove a grant unasked); do
  not extend it to another field without that argument. A server without the field is
  read as having none. Their writes come
  last, after the hooks: removals, changes that widen nothing, changes that widen,
  registrations (the cap is never passed on the way, and a run that stops has widened as
  little as it could). The apps are read again before the first (`nativeAppSnapshot`), and
  a plan that would end over `MAX_NATIVE_APPS` is a `planBlocker`. Text from the server (an
  identifier, a team, a fingerprint, a platform) is printed through `printable()`. A new
  rule gets a row in `packages/cli/src/diff.test.ts` and a line in `docs/config.md`.
- **The CLI reaches the database only through `tula dev`, and only by running what the API
  image ships** ([ADR 0031](../../docs/adr/0031-instance-admin-and-cli.md)): `docker compose run
  migrate`, the seed and `create-api-key.ts`. Everything it spawns goes through the injectable
  `Host` (`packages/cli/src/host.ts`): an argument vector, never a shell line, always with a
  timeout, so unit tests need no Docker. `tula dev` writes keys only inside its marked block
  of `.env.local` (mode 0600, enforced on every run through `Host.restrictFile`, not only when
  the contents change; written through a temporary file opened exclusively under a random
  name, and a symbolic link at the file is refused rather than written or re-moded through;
  **read** through `Host.readFile`, which refuses a link, a named pipe and a directory from
  an `lstat` before any open and opens non-blocking with the kind checked again on the
  handle, so no read of an operator's path can wait for ever: never read such a path with
  a plain `readFile`),
  never changes a line outside it, mints nothing when the block's
  keys still work, and prints the secret key only with `--show-keys`. `tula doctor` renders
  the server's diagnostics and never connects to a dependency itself; text from the server is
  stripped of control characters and of what a reader cannot see (`printable()`: the Unicode
  classes `Cf`, `Co`, `Cn` and lone surrogates, with the `u` flag) before it is printed, and
  **an address from the server's
  answer is never requested** unless it is the origin the operator gave, and then only as
  `<origin>/v1/status`. `tula policy test` evaluates the
  password on the operator's machine: it is never sent, printed or logged.
- **`tula dev --tunnel` gives the local stack a public https address, and loosens nothing
  to do it** ([ADR 0049](../../docs/adr/0049-dev-tunnel.md)). One service is built
  (`tailscaleFunnel`, a `TunnelService` in `packages/cli/src/tunnel.ts`); a second is a
  decision. Every command of the tool goes through `Host` (an argument vector, a timeout),
  **none carries a credential or a flag that rewrites the `Host` header**, and the target
  is `http://127.0.0.1:<port>`, never a name: keep the test that holds the vectors to
  that. The tool's sign-in is the developer's own; what it prints is captured and shown
  only through `printable()`. The address reaches the API as `TULA_PUBLIC_URL` in the
  environment of the one `docker compose up` (the scaffold's Compose file reads it), and
  is written, with `TULA_ISSUER` and `TULA_TUNNEL_TARGET`, inside the marked block only;
  `TULA_API_URL` stays loopback. **A setting is never written** (`passkeys.rpId`, the
  allowed origins, the redirect URLs and `nativeApps` are printed to paste), and a Compose
  file or a line of `.env` is never edited: a fixed `PUBLIC_URL`, and the mock provider
  or the development inbox switched on, stop the run before anything is started, opened
  or written, with the line to change. Never override either for the run, and never
  loosen `env.ts` for it. **The tunnel has the stack's lifetime**: closed by `tula dev
  down`, by `tula dev` without the flag, and by the run that opened it when a later step
  fails or it is interrupted; a new path that opens one gets the test that it is closed.
  **The order is fixed** (`serveThroughTunnel`): the API's container is stopped, the
  tunnel's record is written, the tunnel is opened, the API is started under the address.
  Never open before the stop (an API started without the tunnel must not be what a new
  address first reaches) or before the record. **The record exists before the address
  does, and goes only when the tunnel has**: it is `TULA_TUNNEL_TARGET` with
  `TULA_ENVIRONMENT_ID` (what the routes are made of, known before opening; never a
  guessed `TULA_PUBLIC_URL`), and it is taken out only by a close that ended `closed` or
  `gone`, in the run that opened it, in a plain `tula dev` and in `tula dev down` alike.
  **`SIGINT`, `SIGTERM` and `SIGHUP` close the tunnel the run opened**: the run listens
  through `Host.onInterrupt` (never `process.on` in a command) from before the stop until
  the stack is reported, stops at its next step (a command that takes an interrupt for "no
  answer" is followed by a `halt()`, and a wait asks between tries), and closes with
  `shielded` commands, which a second signal does not cut short and whose timeout still
  ends them. Never say more than that, and name the signals wherever it is said:
  `SIGKILL`, `SIGQUIT`, a crash and a power loss leave the tunnel open with its record,
  and docs and output say so. **A port that serves anything of somebody else's is never
  touched** (`judgeTunnel`: opening is refused, closing is skipped and said), and is judged
  before anything is started (no migration, no seed) and again when the tunnel is opened:
  keep both. Never word the command, a doc or an output as shown on a phone:
  `docs/plans/phase-2-unverified.md`, "Step 2.12".
- **`create-tula` never ships a default secret and never invents a registry.** Every secret
  in the scaffolded `.env` (mode 0600, covered by the scaffold's `.gitignore`) comes from
  `crypto.getRandomValues`; an existing `.env` or `.env.local` is never replaced, even with
  `--force`; the project name is validated before anything is written. `.gitignore` is
  written first and `.env` last; an existing `.gitignore` is merged, never replaced; and a
  symbolic link at any path it would write (asked with `lstat`) is refused before any write. The app templates are
  owned by `scripts/sync-templates.ts` (`generate:check` and a test fail on drift): change the
  example in `examples/`, then run `bun run --filter create-tula templates:sync` (which also
  rewrites `@tula/mcp`'s `scaffolds.gen.ts` from the same templates). Only files
  ending in `.tmpl` have `{{name}}` placeholders. The pinned service images in the template's
  Compose file are the repository's own (a test holds them equal).
  **Five templates: `react-vite`, `nextjs`, `expo`, `swiftui`, `compose`** (`FRAMEWORKS`;
  the last three copies of `examples/expo/app`, `examples/swiftui` and `examples/compose`).
  A native app is a directory of its own (`app`, `ios`, `android`) beside the stack's
  files, and holds no key. **The Swift package and the Kotlin libraries are published
  nowhere, so a `swiftui` or a `compose` project names its SDK by a relative path into a
  checkout** (`--tula-repo`, required for those two and refused for the others;
  `checkoutPaths`: real paths, the checkout proven by a file it must hold, a path with a
  character an Xcode project, a Gradle file or a pasted command line cannot take as it is
  refused, **a space among them**: the Compose start command prints the path unquoted).
  **Building such a project runs the checkout's build scripts** (its Gradle settings,
  modules and wrapper; Xcode evaluates its `Package.swift`), so every place that documents
  the option says, in these words, "`--tula-repo` must be a checkout you trust: building
  the project runs its build scripts." (`.claude/hooks/docs.test.ts` holds the five). Never write a
  Maven coordinate, a Swift package URL or a registry there until one exists; the Compose
  template ships no Gradle wrapper and is built with the checkout's. `@tula/mcp`'s
  `detect_framework` never answers `swiftui` or `compose` (it reads one `package.json`).
  **Nobody ran a scaffolded native project in a simulator, on an emulator or on a
  phone** (`docs/plans/phase-2-unverified.md`, "Step 2.18"): the quickstart's native path
  is steps for the developer, and no doc, README or changeset says more.

## Modules and tests in detail

What the section above does not say (moved from `sdk.md`).

- **`@tula/config`** may use Zod (tooling only). The config's `settings` is the contract's
  `EnvironmentSettingsInputSchema`; do not redeclare a setting here. A provider secret is a
  `SecretRef` and nothing else: keep the `@ts-expect-error` test that a literal does not
  compile and the run-time test that it is refused without being repeated. No error of this
  package carries a value from the file or the environment. A webhook endpoint takes its
  fields from the contract's request schemas by `shape`; an address with a user name or a
  password is refused here and not in the contract (the API answers it with
  `webhook.url_not_allowed`). Event types are normalised on load (sorted, each once), and an
  environment without the list must keep hashing as it did (a test pins the value).
- **Output:** commands take a `CommandContext` and write through `output`; no `console`, and
  no `process.stdout` outside `process-io.ts` (built by `createProcessIo` from injectable
  parts, unit-tested with fake streams and file modes).
- **`apply` and `diff`:** a new kind of destructive plan is refused before any write like the
  others, with a zero-writes test. Exit codes are `EXIT` (`diff`: 0 / 2 / 1). The diff engine
  (`src/diff.ts`) is pure and table-tested: a change to how a field is compared, to the
  write order, or to when a secret is sent needs a row there and a line in
  `docs/config.md`. Behaviour against the real API is tested in `src/real-api.test.ts` (the
  API in process, as `@tula/nextjs` does), and the output of every run in that file is
  checked for secrets. Keep the named-pipe tests of `Host.readFile` (host, `apply`, `dev`).
- **`tula dev`:** a new step gets a fake-host test and an idempotence test (a second run
  changes nothing). The marked block is found by `findBlock` (whole-line markers, the end
  after the start). The real host opens its temporary file `wx` and refuses a symbolic link
  with `lstat`, then `O_NOFOLLOW`.
- **`tula doctor`** talks to the API through `createInstanceClient`; an answer the CLI cannot
  read is a failing check, never a crash; an address in the answer that carries credentials
  is never requested.
- **`tula dev --tunnel`:** its tests are `src/dev-tunnel.test.ts` (a fake Docker and a fake
  `tailscale`); a new step gets the idempotence test and the "tunnel is closed" test there.
- **`tula policy test`** reaches only `evaluatePassword`, and the password is redacted on the
  error stream (`output.redact(value, 'errors')`); its tests assert it is absent from all
  output and from every request.
- **`create-tula`** has no dependency at run time. An existing `.gitignore` is merged by
  `withIgnoreLines`, and `refuseSymlinks` runs before the first write.
  `templates/<framework>/app` and `templates/<framework>/package.json` are generated. The
  templates are found from the running module's directory (`findTemplates`), which differs
  between `src/` and the built `dist/`: keep its test.
