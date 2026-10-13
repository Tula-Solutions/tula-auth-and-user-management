# The MCP server (`tula mcp`)

`tula mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server. An MCP
client (Claude Code, Claude Desktop, an editor) starts it as a child process and talks to it
over standard input and output. It lets an assistant **read** an environment (users,
sessions, audit entries, settings, deployment checks), gives it the files for adding Tula
to an app, lets it **draft** a settings change as an edit to your config file, lets it
**test** that sign-up and sign-in work and, with an agent key, lets it **ask** for a change
that a person approves.

**One tool changes live data, and only while it runs**: `test_signin` has the server sign a
throwaway user up and in and delete it, where the environment allows that
([the sign-in test](#the-sign-in-test), [ADR 0058](adr/0058-test-signin.md)). **No other
tool does.** Nothing bans a user, revokes a session or edits a setting,
and the scaffold tools return files without writing them. The draft tool returns an edit
to `tula.config.ts` and writes nothing: you apply it with `tula apply`
([ADR 0056](adr/0056-mcp-settings-config-diff.md)). A propose tool records a
*proposal*: a request that does nothing until you approve it, outside this server, with a
credential the server is not given ([proposals.md](proposals.md)). The server never
returns a secret, a token or key material. The design is in
[ADR 0033](adr/0033-mcp-server.md) and [ADR 0053](adr/0053-proposals.md).

## Configuration

The server reads its credentials from the environment the client starts it with, the same
way every `tula` command does ([docs/cli.md](cli.md)). None is required.

| Variable | Used for |
| --- | --- |
| `TULA_API_URL` (or `TULA_API_URL_<NAME>` with `--env <name>`) | Where the Tula API is. https, or this machine. |
| `TULA_AGENT_KEY` (or `TULA_AGENT_KEY_<NAME>`), or `--agent-key-file <path>` | The read tools, the propose tools **and** the sign-in test. An agent key (`tula_ak_…`) reads what a secret key reads, asks for changes, and runs a sign-in test where the environment allows one; it changes nothing else. The key decides the environment. **Use this one for an assistant.** |
| `TULA_SECRET_KEY` (or `TULA_SECRET_KEY_<NAME>`), or `--secret-key-file <path>` | The read tools and the sign-in test, when there is no agent key. It does not propose. |
| `TULA_ADMIN_TOKEN`, or `--admin-token-file <path>` | `run_doctor`'s server-side checks only. |

- Without a key the read tools and the draft tool answer `not_configured`; the scaffold tools work with no
  configuration at all. Without an agent key the propose tools answer `not_configured`.
- **With an agent key the secret key is not read**, even if it is set: the server then
  holds nothing that can approve a proposal, or change anything beyond a sign-in test, and says on standard error
  that it left the secret key alone. Keep the secret key out of an assistant's environment
  all the same: it is what approves. This server not reading it does not take it away from
  an assistant that has a shell: one that can run commands where the secret key is set can
  call the admin API itself (`tula approve` refuses to run without a terminal, which stops
  the one-line way and not a program that drives a terminal). An approval shows that a
  credential this server does not hold was used, not that a person looked
  ([what approval does not protect against](proposals.md#what-approval-does-not-protect-against)).
- A credential is never an argument and never a tool input. `-` is refused for every key
  file: standard input carries the protocol.
- Prefer a file or your client's secret storage over writing a key into a config file that
  is committed. Use a development key unless you mean to read production.

### Claude Code

```sh
claude mcp add tula \
  --env TULA_API_URL=http://localhost:3003 \
  --env TULA_AGENT_KEY=tula_ak_dev_… \
  -- bunx --package @tula-tech/cli@latest tula mcp
```

or, in a project's `.mcp.json` (keep the key out of the file: `${VAR}` is expanded from your
shell's environment):

```json
{
  "mcpServers": {
    "tula": {
      "command": "bunx",
      "args": ["--package", "@tula-tech/cli@latest", "tula", "mcp"],
      "env": {
        "TULA_API_URL": "http://localhost:3003",
        "TULA_AGENT_KEY": "${TULA_AGENT_KEY}"
      }
    }
  }
}
```

### Claude Desktop

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tula": {
      "command": "bunx",
      "args": ["--package", "@tula-tech/cli@latest", "tula", "mcp", "--agent-key-file", "/Users/you/.config/tula/dev-agent.key"],
      "env": { "TULA_API_URL": "https://auth.example.com" }
    }
  }
}
```

The key file should be readable by you only (`chmod 600`).

### Any other client

Start `bunx --package @tula-tech/cli@latest tula mcp` with the variables above; it speaks
newline-delimited JSON-RPC on standard input and output. `tula` runs on
[Bun](https://bun.sh), which must be installed.

**Always name the package, as every example on this page does.** A client starts the server
wherever the client itself was started, which is seldom a project that has `@tula-tech/cli`
installed. There, a bare `tula` after `bunx` or `npx` is not Tula's command: the registry
has an unrelated package named `tula`, and it would be downloaded and run with your key in
its environment. `--package @tula-tech/cli@latest` says which package the command comes from
(`bunx --help`: "`-p, --package <package>`: specify package to install when binary name
differs from package name"). Standard output carries only the protocol;
the server's own lines (what is configured, one line per tool call) go to standard error.

## Tools

The read, draft and scaffold tools are annotated read-only; a propose tool is not (it
records a proposal), and neither is `test_signin` (it makes a user and deletes it; it is
also the one tool not annotated idempotent: every call is another run). All are annotated
as not destructive. Inputs are strict: a property a tool does
not name is refused.

### Read tools (need an agent key or a secret key)

| Tool | Input | Returns |
| --- | --- | --- |
| `list_users` | `query?`, `page?`, `size?` (≤ 50, default 20), `sort?` | `{ meta, data: [user] }` |
| `get_user` | `userId` | `{ user, signInMethods }` |
| `list_user_sessions` | `userId` | `{ data: [session] }`; a session says `deviceBound`, a yes or no, and nothing of a device key |
| `list_audit_entries` | `action?`, `actorId?`, `targetId?`, `actorType?`, `from?`, `to?`, `page?`, `size?` (≤ 100, default 50) | `{ meta, data: [entry] }` |
| `get_settings` | none | `{ revision, settings, managedBy }` |
| `list_oauth_providers` | none | `{ data: [provider] }` |
| `run_doctor` | none | `{ apiUrl, version, environment, checks: [{ id, source, status, summary, fix?, values? }] }` |

- A **user** is `id`, `email`, `emailVerifiedAt`, `firstName`, `lastName`, `bannedAt`,
  `lastSignInAt`, `createdAt`. A user's phone number is not returned.
- **signInMethods** is `hasPassword`, `emailVerified`, `identities` (provider and date),
  `factors` (type and date), `backupCodesRemaining`, `passkeys` (name, whether synced, dates)
  and `canSignInWithoutPasskeys`.
- A **session** is `id`, `client`, `userAgent`, `ipAddress`, `createdAt`, `lastActiveAt`,
  `expiresAt`.
- An **audit entry** is `id`, `action`, `actor`, `target`, `ipAddress`, `userAgent`,
  `metadata` (known keys only) and `occurredAt`.
- A **provider** is `provider`, `configured`, `enabled`, `clientId`, `teamId`, `keyId`,
  `tenant` (Microsoft's: an alias or a tenant id, not a secret), `additionalClientIds`
  (Google's: the client ids of the operator's native apps, not secrets), `callbackUrl`,
  `updatedAt`.
- `run_doctor` needs only `TULA_API_URL`; with `TULA_ADMIN_TOKEN` it includes the checks the
  API makes of itself.

### Draft tool (needs an agent key or a secret key)

| Tool | Input | Returns |
| --- | --- | --- |
| `draft_settings_change` | `settings?: [{ path, value }]`, `providers?: [{ provider, secretEnv, enabled?, clientId?, teamId?, keyId?, tenant?, additionalClientIds? }]` (at least one entry in all) | `{ changed: false, nextStep, notes, revision, managedBy, settings: [{ path, from?, to, changes }], providers: [{ provider, configured, entry, changed }], weakened, weakens }` |

An assistant that wants a setting changed gets the change as **an edit to the environment's
entry in `tula.config.ts`** ([config.md](config.md)). The tool reads the settings (and,
when a provider is named, the providers), and answers what to write where. **It writes no
file and calls no route that writes**: your client edits the file after you agree, and you
run `tula diff` and `tula apply` with your own secret key. `changed` is always `false`, and
`nextStep` says so in the tool's own fixed words.

- **A setting is named by its path** in the document `get_settings` returns
  (`password.minLength`, `signIn.methods.emailCode.enabled`, `urls.allowedOrigins`,
  `sessions.profiles.web.idleTimeout`), with the value it should have: a string, a number,
  a boolean, `null` or a list of strings given whole. Only a setting `get_settings`
  returns can be named. The wording of emails and text messages and the JWT templates
  cannot: no tool returns them, so none drafts them; edit those in the file yourself.
- **An edit** is `path`, `to` (what to write), `from` (what the server has now; left out
  where it has nothing there) and `changes` (`false` when the server already has that
  value).
- **A provider's entry is returned whole**, as it goes under `providers` of the
  environment: what the server has (`clientId`, `teamId`, `keyId`, `tenant`,
  `additionalClientIds`, `enabled`) with what you asked for over it. **Its secret is only
  ever a reference**: `clientSecret` (Apple: `privateKey`) is `{ "$env": "NAME" }`, written
  in the file as `env('NAME')`. `secretEnv` is that variable's *name* (capitals, digits and
  underscores) and is required: the tool takes no secret, has no field one could be put
  in, and never reads one. `changed` names the fields that differ from the server's.
- **`weakened`** lists what the change would weaken, by the names `tula diff` prints
  (`password.minLength`, `mfa.policy`, `providers.google.additionalClientIds`, …); `weakens`
  is whether there is any. `tula apply --yes` refuses such a plan without `--allow-weaker`.
  The rule is the contract's, the one the API, the dashboard and the CLI share. **One
  weakening is not judged here**: switching off a provider that accounts depend on
  ([ADR 0059](adr/0059-email-for-accounts-without-one.md)). The tool never reads that
  count, so `weakens: false` for such a draft is not "nobody is locked out". A draft that
  switches off a provider the server has on says so in one more entry of `notes`, in fixed
  words (no provider's name, no number); `tula diff` counts the accounts for the person
  who applies the draft.
- **The config file is the whole truth for settings**: a setting the file leaves out goes
  back to its default when it is applied. The edits belong in the file that already manages
  the environment. Where `managedBy` is `null` no file is on record, and a file holding
  only these edits would reset every other setting: start that file from what
  `get_settings` shows.
- **A change no config file could hold is refused**, with `change.invalid` and `problems`:
  a list of `{ path, code }`, where `code` is a closed word (`invalid_value`, `too_small`,
  `invalid`, `not_returnable`, …) and never a value. `not_returnable` is a value that would
  not come back exactly as you gave it: longer than `get_settings` returns that setting (a
  string is at most 512 characters, an origin or a redirect URL 300, a list of them 50
  entries), with a character that cannot be seen, or one that reads as a secret. The
  tool refuses it instead of returning something you did not ask for. Nothing of the edit
  is returned with a refusal. At most 50 problems are listed; when there were more the
  answer has `truncated: true` and `problemsOmitted`, the number left out.
- **Read every `$env` name before you apply.** `tula apply` sends the value of the
  variable an entry names to the server as that provider's secret. The tool refuses the
  names of Tula's own credentials (`TULA_SECRET_KEY` and `TULA_SECRET_KEY_<NAME>`,
  `TULA_AGENT_KEY` and `TULA_AGENT_KEY_<NAME>`, `TULA_ADMIN_TOKEN`, `TULA_MASTER_KEY`,
  `TULA_API_DB_PASSWORD`, `DATABASE_URL`, `DATABASE_MIGRATION_URL`, `REDIS_URL`,
  `SMTP_URL`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY_SECRET`). It cannot know what any other
  variable on your machine holds, and it does not guess: an assistant that names
  `AWS_SECRET_ACCESS_KEY` gets an entry that says so, and you are the check.
- **What it does not judge**: what only the server knows when it applies. The server
  refuses a change that would leave no way to sign in, and a settings document that
  changed since it was read (`tula apply` reads again). `tula diff` is the check, and it
  is yours to run.
- Webhook endpoints, hooks and native apps are not drafted: each has rules of its own in
  the file ([config.md](config.md)), and the tool has no field for them.

### The sign-in test

| Tool | Input | Returns |
| --- | --- | --- |
| `test_signin` | none | `{ outcome, steps: [{ step, outcome, durationMs, code?, reason? }], userId?, cleanup }` |

Needs an agent key or a secret key. **This is the one tool that changes the environment.**
The server signs a user up and in through the environment's real flow, in its own process,
and deletes that user before it answers:

1. `sign_up`: a sign-up for a throwaway address, with a password the server makes (where
   the password method is on).
2. `verify_email`: the code of the verification email. The account is created here.
3. `sign_out`: the new session is ended.
4. `sign_in`: a sign-in is started for the same address.
5. `first_factor`: the password.
6. `revoke_session`: the second session is ended.
7. `delete_user`: the user is deleted.

**What it does to the environment while it runs** (a second or so):

- A user exists. Its address is `tula-test-<32 hex characters>@test.tula.invalid`: a
  reserved domain no mail can reach, which no person's account can hold (a sign-up, an
  administrator's create or a provider's profile with such an address is refused like any
  address that is not one).
- **Your [hooks](hooks.md) are asked** about it, as for any sign-up and sign-in:
  `before_sign_up` gets that address, the other two the user's id. A hook that refuses
  fails the step, and the report says `hook.denied`.
- **Its events are recorded and delivered to your [webhook endpoints](webhooks.md)**:
  `user.created` carries `"test": true` (and no other event does: every later one names
  the same user id), then `session.created`, `session.revoked`, `user.deleted`, and
  `sign_in_test.started` and `sign_in_test.finished` around them.
- **No email leaves the server.** The verification email is read inside the server and
  never handed to your mail relay; nor is any notice about that user.
- The audit log has the run, the session it ended and the deletion under the key that
  asked: `actorType: "agent"` for an agent key.

**What comes back** is the report and nothing of the flow: no token, no code, no attempt
secret, no password, no address. A step is `passed`, `failed` with the API's error code in
`code` (`hook.denied`, `auth.method_disabled`, …) or a fixed word in `reason` (`timeout`),
or `not_run` with a fixed `reason`:

| `reason` | Meaning |
| --- | --- |
| `earlier_step` | A step it depends on did not pass. |
| `second_factor_required` | `mfa.policy` is `required`: the sign-up or the sign-in stopped at the second step, which the test does not take. No session was made. |
| `email_cooldown` | The sign-in offers an emailed code and no password. The address was emailed seconds ago and a second email inside a minute is refused, for the test as for anyone. |
| `no_provable_method` | The sign-in offers neither a password nor an emailed code (only a passkey, an emailed link, a texted code or a provider). |
| `no_session` | There was no session to end. |
| `timeout`, `cancelled` | The run was out of time (40 seconds), or the call went away, before the step. |

**`not_run` is "not checked", never "works".** `outcome` is `passed` only when every step
passed, `failed` when one failed, and `incomplete` when none failed and one was not run.
A passkey, an emailed link, a texted code and a provider are never exercised.

**The user is deleted whatever happened**: after a failed step, after the deadline, after
your client cancelled the call. `cleanup` is `deleted`, `none` (no user was made) or
`failed`: the deletion did not go through, or the step that makes the account (the
verification of the sign-up's emailed code) was still at work when the server stopped
waiting for it and may have made the user since (`userId` is then `null`). Any other step
left at its time limit makes no user, and the report then says `none`. A step has 16
seconds for its own work, and 5 more for each hook it asks (three at the verification of
a sign-up, two at a sign-in), inside the run's 40. The
server's log says so, and the server removes such a user by itself within about a quarter
of an hour of the next retention run. With a `userId`,
`DELETE /v1/admin/users/<userId>` removes it at once.

**Where it runs.** Only where the environment's setting `agents.testSignIn` allows it:
`null` (the default) is **on in a development environment and off in a production one**;
`true` and `false` say it outright. Writing `true`, or taking a `false` back to `null`, is
asked about first as a weakening, in the dashboard and by `tula apply --yes` ([config.md](config.md)). Where it is off the tool
answers `auth.forbidden` and nothing is created.

**How often.** Four runs an hour per key, eight an hour per environment, and one a minute
per environment, so that two never run at once. Past any of them: `rate_limited`, with
when to try again, and nothing is created. A refused call still counts towards the hour:
wait for the time the answer names instead of asking again.

**What a `passed` report does not say**: anything about your application's pages or its
SDK setup, your mail relay (no mail was sent, and your own wording of the email was not
rendered), or what your webhook receiver did with the events.

### Propose tools (need an agent key)

| Tool | Input | Returns |
| --- | --- | --- |
| `propose_ban_user` | `userId` | `{ proposal, changed: false, nextStep }` |
| `propose_unban_user` | `userId` | `{ proposal, changed: false, nextStep }` |
| `propose_end_session` | `sessionId` (one session; `list_user_sessions` has the ids) | `{ proposal, changed: false, nextStep }` |
| `propose_disable_oauth_provider` | `provider` (its name, such as `google`) | `{ proposal, changed: false, nextStep }` |

- A **proposal** is `id`, `operation`, `target` (`type`, `id`), `summary`, `status`,
  `createdAt` and `expiresAt`. `summary` is the server's own sentence for the operation.
- **Nothing has happened when the tool answers.** The change is made only if a person
  approves the proposal within ten minutes: `tula approve <proposal id>`, with their own
  secret key ([proposals.md](proposals.md)). The server has no tool that approves, and
  holds no credential that could.
- Asking again for the same thing while a proposal is pending returns that proposal.
- Revoking the agent key ends the proposals it made that nobody approved: they can no
  longer be approved, and the key reads and proposes nothing more.
- **What can be proposed is these four and nothing else**: banning a user, lifting a ban,
  ending one session, switching one provider off (its credentials are kept). There is no
  tool that deletes anything, makes or returns a key, a password or a provider's
  credentials, switches a provider on, changes a setting, or acts on more than one thing
  (no "end every session of this user").
- A production environment refuses (`auth.forbidden`) unless its settings accept proposals
  (`agents.proposalsInProduction`, off by default, which `get_settings` returns and only a
  person can change: [proposals.md](proposals.md#production-environments)). A user, a
  session or a provider that does not exist is `resource.not_found`.
- `propose_disable_oauth_provider` is refused (`validation.failed`) when it would leave
  the environment with no way to sign in; the server judges that again when a person
  approves.
- **Each tool is limited**: ten proposals a minute for an environment, and five a minute
  of each operation; beyond either the tool answers `rate_limited`.
- A tool answers `response.invalid` when the server's answer is not the proposal it asked
  for (another operation or another target): nothing of such an answer is returned.
- `list_audit_entries` shows what became of a proposal: `action` `proposal.created`,
  `proposal.approved`, `proposal.executed`, `proposal.failed`, and `actorType: "agent"`.

### Scaffold tools (need nothing)

| Tool | Input | Returns |
| --- | --- | --- |
| `detect_framework` | `directory?` (default: where the server was started) | `{ directory, framework, supported, tulaPackages }` |
| `scaffold_provider` | `framework` | `{ framework, files: [{ path, contents }], dependencies, environment, notes }` |
| `scaffold_protected_route` | `framework` | the same |
| `scaffold_sign_in_page` | `framework` | the same |

`framework` is `nextjs` (App Router), `react-vite`, `expo`, `swiftui` or `compose`. The files
are the ones the example apps and `create-tula` use, byte for byte. **`expo` is answered
with the error `scaffold.not_released` and no file**: its scaffold needs `@tula-tech/expo`,
which is held back from npm ([releasing.md](releasing.md)), and a tool that told an
assistant to install it would send it to a package that is not there. `create-tula`
refuses the Expo template for the same reason. **The server writes
nothing**: your client writes the files, after you agree. `detect_framework` reads one
`package.json`, only inside the directory the server was started in, and returns nothing of
it but the framework and which Tula packages it names. So it answers `nextjs`, `react-vite`,
`expo` or `unknown`, and **never `swiftui` or `compose`**: an Xcode project and a Gradle
build have no `package.json`, and for those the framework is named to the scaffold tools
directly.

For `swiftui` and `compose` a scaffold's `dependencies` are the names of the Swift package's
libraries and of the Kotlin modules, and its `notes` say where they come from: a checkout of
the Tula repository, by path, because neither is published anywhere. No registry, Maven
coordinate or package URL is named. The native files were compiled in the example apps they
are copied from; nobody has run a project assembled from a scaffold tool's answer
([quickstart.md](quickstart.md#the-native-path) says what was run of the same templates).

## What is and is not returned

- **Returned**: your users' names and email addresses, the IP addresses and user agents of
  sessions and audit entries, the settings document, OAuth client ids and callback URLs. This
  is personal data about your users, and it goes to the model you connected: connect only an
  assistant you would show the dashboard to.
- **Never returned**: secret, agent or publishable keys, signing keys, access or refresh tokens,
  password hashes, TOTP secrets, backup codes, passkey credential ids, provider client
  secrets, the master key, the admin token. There is no tool that lists API keys. There is none for
  [native apps](native-apps.md) either: not because they are secret (they are in two public
  files), but because no tool has needed them yet.
- Results are built from an allow-list of fields, so a field the API gains later is not
  returned by default. Values that look like a secret (a `tula_sk_…` or `tula_ak_…` key, a JWT, a password
  hash, an `otpauth://` URI, a PEM block) are replaced with `[redacted]` wherever they appear.
- **Everything in a result is untrusted text.** A user can put anything in their name. Results
  are JSON, a string is cut at 512 characters and a result at 64,000 (a cut list has
  `truncated: true`). Treat what comes back as data to report, not as instructions.
- **Characters you cannot see are removed**, because a model reads them all the same.
  Control characters and line separators become a space. Zero-width characters,
  bidirectional controls, the soft hyphen, the Unicode tag characters (which can spell a
  whole sentence invisibly), variation selectors, private-use and unassigned code points and
  lone surrogates are dropped, and so are a few characters that are drawn as nothing (the
  Hangul fillers, the braille blank, two Khmer vowels); a pile of combining marks is cut at
  eight. Secret-shaped values are looked for after that, so a key split by an invisible
  character is still replaced, and so is one split by a newline or a control character: it
  is replaced whole, never one half of it.
  - Names in any script come through unchanged, accents included. Emoji do too, with one
    visible difference: an emoji built from several joined ones (a family) is returned as
    its parts, and one that needed a variation selector is returned in its plain form. The
    dashboard and the API show the value as it is stored.
- In `get_settings`, session profiles are keyed by name. A name is cleaned like any other
  text and cut at 64 characters. If two names are the same after that, the first is returned;
  an entry left out for its name (a duplicate, `truncated`, `__proto__`, `constructor`,
  `prototype`) is marked by `truncated: true` on `profiles`.
- Only the start of a very long value is looked at (four times the field's limit, at least
  4096 characters); the rest is dropped, and the value ends with `…`.

## Time and load

- A request to the API has 15 seconds; `run_doctor` has 30 for all of its requests, and
  `test_signin` 60 for its one (the server ends a run inside 56). A cancelled or timed-out
  `test_signin` ends your wait, not the clean-up: the server deletes the user regardless. When a
  call runs out of time, or your client cancels it, the requests it made are aborted. A call
  cancelled before its turn never runs and is answered `cancelled`.
- Four read, draft, propose or test tools run at once and sixteen more wait their turn. A call beyond
  that is refused at once with `busy`: wait for some answers and call again. The scaffold
  tools are not counted.
- Only `tula mcp` loads the server and its SDK; other `tula` commands start without them.

## Errors

A failed call is a tool error: `{ "error": { "code", "message", "status"?,
"retryAfterSeconds"? } }`. `code` is a contract error code (`resource.not_found`,
`auth.invalid_key`, `rate_limited`, …), a client code (`network.failed`, `network.timeout`)
or one of the server's own:

| Code | Meaning |
| --- | --- |
| `not_configured` | No key (or API URL) was configured, or it was refused at start. For a propose tool: no agent key. For `test_signin`: no key of either kind. |
| `path.outside_root` | `detect_framework` was asked about a directory outside the server's own. |
| `path.not_found` | No such directory, or no `package.json` in it. |
| `package.invalid` | The `package.json` is not a readable JSON file. |
| `output.too_large` | The result could not be cut to the size limit. |
| `change.invalid` | `draft_settings_change` was asked for a change no config file could hold. `problems` lists a path and a closed word for each; nothing was drafted. |
| `settings.unreadable` | `draft_settings_change` could not read the environment's settings document as this version knows it, so it drafted nothing. Use a `tula` of the API's version. |
| `busy` | Four read or propose calls are running and sixteen are waiting. Try again when some have answered. |
| `cancelled` | The call was cancelled before its turn came; nothing was asked of the API. |
| `internal` | Something unforeseen; its name is on standard error. |
