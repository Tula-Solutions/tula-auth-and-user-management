# ADR 0030 — Settings as code: `@tula/config`, `tula diff` / `tula apply` and the admin client

- Status: accepted
- Date: 2026-10-04

## Context

An environment's behaviour is its settings document (ADR 0018, with the session profiles of
ADR 0028) plus its OAuth providers (ADR 0026). Until now both could only be changed by calling
the admin API by hand. Operators want what they have for the rest of their stack: a file in
the repository that says what an environment should be, a dry run in the pull request, and an
apply in the pipeline that never tramples a change made elsewhere.

Phase 1 step 1.13 asks for `defineConfig()` in `tula.config.ts`, `tula apply` and `tula diff`,
and for the dashboard to show when settings are managed by a config file. Step 1.14 adds more
commands to the same CLI, and says the CLI talks to the API "through the generated admin
client", which did not exist.

## Decision

Three new publishable packages (ADR 0020), all `"private": true` like the others.

| Package | What | Runs on |
| --- | --- | --- |
| `@tula/admin` | a typed client for `/v1/admin/*`, generated from `openapi.json` | any server runtime |
| `@tula/config` | `defineConfig()`, the config's schema, `loadConfig()` | Bun and Node tooling |
| `@tula/cli` | the `tula` executable: `diff`, `apply`, and the frame 1.14's commands slot into | Bun |

### The admin client

- **Generated types, one hand-written transport.** `packages/admin/src/generated/api.gen.ts`
  comes from the same renderer as `@tula/core`'s (`packages/core/scripts/openapi-types.ts`,
  which gained `renderAdminApi`): the schemas the admin operations reach, and for each
  operation its path, query and header parameters, body and response. `bun run admin:generate`
  writes it; `generate:check` (a Turborepo task `bun run verify` already runs) fails on drift.
  The generation fails if an admin operation does not take the secret key.
- **One function, one error.** `createAdminClient({ baseUrl, secretKey }).call(operationId,
  input)` answers `{ data, status, etag }`; every failure is a `TulaAdminError` with the
  contract's code, the field errors with their paths, and `retryAfterMs`. It never retries.
- **The key is not reachable.** It lives in a closure, is set after any caller-supplied
  header, and is in no property, error or `toJSON`. An error for a request that got no answer
  keeps the failure's *name* only, because a runtime's network error may quote the request.
  Redirects are not followed, so the key goes to `baseUrl` and nowhere else.
- **https, unless it is this machine.** A plain `http:` `baseUrl` is `client.invalid_url`
  except for `localhost`, `*.localhost`, `127.0.0.1` and `[::1]`: a mistyped scheme must
  fail, not send the key and provider secrets in clear text. `allowInsecureHttp: true`
  (`--insecure-http` in the CLI) is the opt-in for a private network. `@tula/nextjs` applies
  the same rule to `apiUrl` when a secret key is configured (`TULA_ALLOW_INSECURE_HTTP=true`).
- **A path parameter is one path segment.** `encodeURIComponent` leaves `.` and `..` alone
  and `fetch` resolves them, so `banUser` with `userId: '..'` would have reached another
  route. Empty, `.`, `..`, a slash, a backslash or a control character is refused before the
  request (`client.invalid_param`, naming the parameter, never its value). A slash is refused
  rather than sent encoded: no id of this API has one, and a proxy that decodes `%2F` before
  routing would split the segment again.
- **Server-side only, three ways.** A publishable key is refused by name
  (`client.publishable_key`); the client refuses to be created where `window` and `document`
  exist (`client.browser`); and the published `browser` export condition resolves to a module
  that throws, so a web bundle fails at build or load. `edge-light` and `workerd` are listed
  before `browser` because those server runtimes also set it. A dependency such as
  `server-only` was not used: it only works under bundlers that honour `react-server`.
- **Zod-free at run time**, like `@tula/core`, and typechecked against web platform types.

### The config file

```ts
export default defineConfig({
  environments: {
    dev: { kind: 'development', settings: { … }, providers: { … } },
    prod: { kind: 'production', settings: { … }, providers: { … } },
  },
})
```

- `settings` is exactly the body of `PUT /v1/admin/settings` and is validated with the
  contract's `EnvironmentSettingsInputSchema`. Unknown keys are errors with their path.
- **An environment's name is a label, not an identity.** Which environment a run changes is
  decided by the secret key it is given. The CLI reads `TULA_API_URL_<NAME>` /
  `TULA_SECRET_KEY_<NAME>` (the name upper-cased) before `TULA_API_URL` / `TULA_SECRET_KEY`, so
  one pipeline can hold several. An entry's optional `kind` makes the CLI refuse a key of the
  other kind (`tula_sk_dev_…` for `production`) before any request: a guard against a mix-up,
  not a security boundary.
- **Neither the API URL nor the secret key is ever read from the file**: it is committed.
- **Secrets only by reference.** `clientSecret` and Apple's `privateKey` are typed
  `SecretRef` (`env('NAME')`, serialised `{ "$env": "NAME" }`). A string there does not
  compile and is refused when the file is loaded, with a message that never repeats it. The
  variable is read by `apply` only, and only for providers it is about to write.
- **The file is trusted code.** `loadConfig` imports it. A failure to import reports the
  thrown error's name, not its message.

### What "the file is the truth" means

- A setting the file leaves out goes back to **its default** on apply (the `PUT` replaces the
  whole document), with two exceptions: `password` and `urls.allowedOrigins`, whose defaults
  are the *deployment's* (`PASSWORD_POLICY`, `CORS_ORIGINS`) and known only to the server.
  Left out, they are **kept as the server has them** and listed in the plan as kept.
- `urls.allowedOrigins` and `urls.allowedRedirectUrls` are compared as **sets** (order means
  nothing to the server) and shown as entries added and removed. Any other list is ordered.
  Session profiles are named entries: one appears or disappears as a whole.
- **Providers the file does not mention are left alone** and listed as "unmanaged". Only
  `--prune` deletes them. Deleting credentials is the one thing a mistake in a file (a
  provider commented out) should not do silently.
- **A provider's secret cannot be diffed** (the API never returns one). It is written when the
  provider is created, when an identifying field changes (`clientId`, `teamId`, `keyId`) and
  with `--rotate-secrets`; switching a provider on or off keeps the stored one. This is what
  makes a second `apply` a no-op.
- **Weakening** is the contract's `settingsWeakenings()`, moved there from the settings
  service: the server's audit flag `weakened` and the CLI's warning are one definition.

### Apply

- The same plan as `diff`, then a confirmation: the literal word `yes` at a terminal, or
  `--yes`. Not at a terminal and without `--yes` it refuses instead of waiting. "At a
  terminal" means standard input and standard error: the question goes to standard error.
- **Two plans are refused unless asked for by name.** One that would reset settings this
  version of the CLI does not know (`plan.unknown`: the `PUT` replaces the whole document as
  this version knows it) needs `--allow-unknown`, with or without `--yes`. One that weakens
  security (`plan.weakened`) needs `--allow-weaker` under `--yes`, where nobody reads the
  warning; at a terminal the confirmation question names the weakening instead. Both refusals
  come before any write, and `diff` reports both (text, and `applyRequires` in `--json`).
- The settings are replaced with `If-Match: "<revision>"` of the plan. A 412 is reported as
  "changed by someone else; run `tula diff` again"; nothing is overwritten.
  `--expect-revision <n>` applies only if the settings are still at the revision an earlier
  `diff` printed.
- **Order.** The server refuses to leave an environment with no way to sign in. Writes that
  add a way in or change none come before writes that take one away (switching a provider
  off, then deletes). The settings go **first** whenever the document they produce has a
  native method of its own, so a stale revision stops the run before anything was written;
  only when the file switches every native method off do they wait for the providers they
  rely on, and then the revision is looked at once more before the first provider write.
- **Partial failure.** The run stops at the first failed write and lists what was applied and
  what was not. Every run starts from what the server has, so running it again converges.
- **Exit codes.** `diff`: 0 no changes, 2 changes pending, 1 error. `apply`: 0 applied or
  nothing to do, 1 error or declined.
- **The secret key is never an argument.** A command line is in shell history, `ps` and CI
  logs. It comes from the environment, or `--secret-key-file <path>` (`-` for standard input).
  `--secret-key` does not exist and says why. A key file readable by group or others is
  warned about once (POSIX modes only); `--secret-key-file -` is refused when standard input
  is a terminal (the key would be echoed), and with it `apply` requires `--yes`, because
  standard input cannot carry both the key and the answer. Every line the CLI writes goes through one
  writer (`src/output.ts`) that replaces the key and any resolved provider secret with
  `[redacted]`: nothing prints one on purpose; this is the net under mistakes. It is also how
  the `noConsole` rule is met: commands receive an `Output`, never a stream.

### The "managed by" record

`PUT /v1/admin/settings` takes two optional headers, `x-tula-managed-by: <tool>` and
`x-tula-config-hash: sha256:<64 hex>`. With them the store records
`{ tool, configHash, at, revision }` in a new nullable column, `environment_settings.managed_by`,
in the same write. `GET` and `PUT` answer `managedBy` (additive; `null` when nobody manages the
settings) with `drifted`: the settings' revision is past the one that apply produced.

- A replace **without** the headers keeps the record: that is a change made around the file,
  it shows as `drifted: true`, and its audit entry carries `outsideConfig: true`.
- A replace **with** them is a write of its own even when the document is unchanged (first
  apply over identical settings, a new version of the file, an apply after drift): a new
  revision and an audit entry with `managedBy: <tool>` and `changed: []`.
- `x-tula-managed-by: none` removes the record.
- **The stored record is validated on read, by the answer's own schema.** The column is
  free-form JSON. Both adapters read it through `readStoredManager`
  (`apps/api/src/adapters/settings-manager.ts`), which applies `SettingsManagedBySchema`
  (minus `drifted`); a record that fails (another version's, a hand's) is treated as
  unmanaged and warned about once per environment, with no value in the log. So a stored
  record can fail neither `GET /v1/admin/settings` nor the answer of a `PUT` that has already
  been committed.
- The hash is computed over the file's content for the environment with each secret as its
  variable's *name*, so it says which version of the file was applied and nothing about a
  secret.
- `tula diff` counts a missing or stale record as a pending change (exit 2): until it is
  recorded, the dashboard cannot say the settings come from a file.
- **Limit:** the record covers the settings document. Providers have no revision, so a
  provider changed by hand does not set `drifted`; `tula diff` shows it.

### Why Bun for the executable

`tula` starts with `#!/usr/bin/env bun`. Every command begins by importing the project's
`tula.config.ts`; Bun runs TypeScript as it is. Under Node the import works only from 22.18
(type stripping) and only for erasable syntax, which is not a promise we can make for a file
an operator writes. `@tula/config` and `@tula/admin` themselves run on Node.

### Webhook endpoints in the file (added 2026-10-08, TULA-44)

An environment's webhook endpoints ([ADR 0034](0034-webhooks.md)) can be listed in the file:
`webhooks: [{ url, eventTypes, enabled? }]`. The fields are validated with the contract's own
request schemas (`CreateWebhookEndpointRequestSchema`'s `url` and `eventTypes`,
`UpdateWebhookEndpointRequestSchema`'s `enabled`), taken by `shape`; nothing is declared a
second time and the contract did not change.

- **Credentials in an address are refused in the file's schema, not the contract's.** Every
  address is printed in plans. The API refuses userinfo too, with `webhook.url_not_allowed`
  from its guard; moving that into the contract's schema would turn it into a validation
  error for every caller of the API, which this step does not need.
- **Identity is the address, compared exactly.** An endpoint has no natural name, and an id
  in a file would have to be copied out of a server first. The API stores an address as it
  was typed and compares it as text (`Webhooks.update`: `input.url !== current.url`), and
  has no normalisation of its own, so the CLI has none either: a second, invented one would
  disagree with the server somewhere. Consequences, accepted: a changed address is a new
  endpoint (new secret) plus an endpoint the file no longer lists, never an update; the same
  address twice in a file is an error when the file is loaded.
- **Absent is not managed; a list manages what it names.** The first half is as asked: no
  `webhooks` key means the endpoints are not read, not shown and not touched, even with
  `--prune`. The second half follows the precedent this ADR already set for providers, and
  differs from the first proposal (in which `webhooks: []` planned every endpoint for
  removal): an endpoint the list leaves out is *unmanaged*, shown and left alone, and removed
  only with `--prune`. One rule for "the server has it and the file does not" is worth more
  than a list that is the whole truth, and it means that adding a `webhooks` list to a file
  can never, by itself, remove anything.
- **Event types are a set**, normalised when the file is loaded (sorted, each once), so
  neither the plan nor the fingerprint moves with their order. `enabled` is managed only when
  written: left out, an endpoint the server switched off (`disabledReason`) stays off.
  Switching such an endpoint on needs no flag (it is not destructive, and the server will
  switch it off again if it still fails) but is said on the endpoint's line and as a warning.
- **Removal is its own kind of destructive plan.** It deletes the endpoint's pending
  deliveries and its delivery log. That is not "weakens security", so `--allow-weaker` would
  be the wrong word: under `--yes` such a plan needs `--allow-webhook-removal`, in addition
  to the `--prune` that planned it, and is refused before any write otherwise. At a terminal
  the question names what is deleted. `--prune` alone is not consent enough under `--yes`
  because it predates webhooks: a pipeline already pruning providers would start deleting
  delivery logs the day a list is added.
- **The secret of a created endpoint exists only in the API's one answer.** It is added to
  the output's redaction the moment it arrives, before anything else can print, unless the
  run was asked to show it (as `tula dev` does for `--show-keys`). The operator gets it by
  asking: `--secrets-file <path>` (JSON, mode 0600, through the `Host` that `tula dev` writes
  `.env.local` with: a temporary file opened exclusively, a symbolic link and anything that
  is not a regular file refused) or `--show-secrets`. **"A new file only" is one step**
  (`Host.createSecretFile`, an exclusive create, added after review): a read followed by a
  replace-by-rename would overwrite a file that appeared in between, another run's secrets
  included. The claim happens before the first write, so a path that cannot be created
  fails the run while it has written nothing. What identifies "the file this run created"
  for the later rewrites is its content: the run remembers what it last wrote, reads the
  file back before each rewrite and does not write over anything else. That is two steps and
  is said as such; a file replaced exactly between them is not protected, and an identical
  file is indistinguishable by construction. A claimed file the run wrote nothing into is
  removed. A secret that cannot be written after its endpoint was created is not a failed
  creation: the endpoint is reported as created and the secret as not kept. `Host.readFile`
  now refuses whatever is not a regular file before opening it (a named pipe at the path
  made the first version, and `tula dev`'s read of `.env.local`, wait for ever). A plan that creates an
  endpoint with neither option is refused before any write, with or without `--yes`: throwing
  a secret away silently and printing one unasked are both wrong. `--discard-secrets` is the
  explicit way to proceed without one; the operator rotates later, and the overlap then also
  signs with a secret nobody holds, which is harmless.
- **Order.** Webhook writes come after the settings and every provider. Nothing about
  signing in depends on them, a registration is the write most likely to be refused for a
  reason outside the file (the outbound guard), and a stale settings revision must stop the
  run before an endpoint is touched. Among themselves: updates, creations, removals. At the
  limit of ten, exactly as many removals as it takes go before the creations, the oldest of
  the endpoints being removed anyway, and the plan says so. A plan that would leave more
  than ten is refused whole, as is one that names an address the server has more than once
  (the API allows that; which endpoint is meant cannot be known, and with `--prune` a guess
  could remove the wrong one). `tula diff` exits 1 for both: a plan no run can carry out is
  an error to put right, not changes pending.
- **A stale plan.** Endpoints have no revision and the API has no conditional write for
  them, and this step changes no route. So the guarantee is weaker than the settings' and is
  said as such: the endpoints are read again immediately before the first webhook write and
  compared with what the plan read (id, address, event types, switch, the server's reason
  for switching off); any difference stops the run with nothing written to an endpoint. A
  change made between that read and the writes is not detected. What limits the damage: a
  `PATCH` carries only the fields the plan changes, a removed endpoint answers 404, and the
  cap is enforced by the server under its own lock. Closing the window needs a revision or
  an `If-Match` on the endpoint routes: an API change, deferred.
- **Not in the file:** rotating a secret, test events, sending again. They are acts, not
  state.

## Consequences

- One more generated file to keep in step: after `contract:generate`, run `core:generate` and
  `admin:generate`.
- `Settings.weakened` in the API is now a one-line delegate to the contract.
- One migration (`0013_settings_managed_by`), additive and nullable.
- Not done here: `create-tula`, `tula dev`, `tula doctor`, `tula policy test` (step 1.14) and
  the dashboard's use of `managedBy` (step 1.15). A new command is one `Command` object added
  to `COMMANDS`.
- Not covered: other admin resources as code (users, API keys, signing keys are operational,
  not configuration), and a drift record for providers.
