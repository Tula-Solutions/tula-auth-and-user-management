# The MCP server (`tula mcp`)

`tula mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server. An MCP
client (Claude Code, Claude Desktop, an editor) starts it as a child process and talks to it
over standard input and output. It lets an assistant **read** an environment (users,
sessions, audit entries, settings, deployment checks), gives it the files for adding Tula
to an app, lets it **draft** a settings change as an edit to your config file and, with an
agent key, lets it **ask** for a change that a person approves.

**No tool changes live data.** Nothing bans a user, revokes a session or edits a setting,
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
| `TULA_AGENT_KEY` (or `TULA_AGENT_KEY_<NAME>`), or `--agent-key-file <path>` | The read tools **and** the propose tools. An agent key (`tula_ak_…`) reads what a secret key reads and can change nothing. The key decides the environment. **Use this one for an assistant.** |
| `TULA_SECRET_KEY` (or `TULA_SECRET_KEY_<NAME>`), or `--secret-key-file <path>` | The read tools, when there is no agent key. It does not propose. |
| `TULA_ADMIN_TOKEN`, or `--admin-token-file <path>` | `run_doctor`'s server-side checks only. |

- Without a key the read tools and the draft tool answer `not_configured`; the scaffold tools work with no
  configuration at all. Without an agent key the propose tools answer `not_configured`.
- **With an agent key the secret key is not read**, even if it is set: the server then
  holds nothing that can change anything or approve a proposal, and says on standard error
  that it left the secret key alone. Keep the secret key out of an assistant's environment
  all the same: it is what approves. This server not reading it does not take it away from
  an assistant that has a shell: one that can run commands where the secret key is set can
  run `tula approve --yes`, or call the admin API, itself. An approval shows that a
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
  -- npx tula mcp
```

or, in a project's `.mcp.json` (keep the key out of the file: `${VAR}` is expanded from your
shell's environment):

```json
{
  "mcpServers": {
    "tula": {
      "command": "npx",
      "args": ["tula", "mcp"],
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
      "command": "npx",
      "args": ["tula", "mcp", "--agent-key-file", "/Users/you/.config/tula/dev-agent.key"],
      "env": { "TULA_API_URL": "https://auth.example.com" }
    }
  }
}
```

The key file should be readable by you only (`chmod 600`).

### Any other client

Start `npx tula mcp` (or `bunx tula mcp`) in the project's directory with the variables
above; it speaks newline-delimited JSON-RPC on standard input and output. `tula` runs on
[Bun](https://bun.sh), which must be installed. Standard output carries only the protocol;
the server's own lines (what is configured, one line per tool call) go to standard error.

## Tools

The read and scaffold tools are annotated read-only; a propose tool is not (it records a
proposal), and is annotated as not destructive. Inputs are strict: a property a tool does
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
  The rule is the contract's, the one the API, the dashboard and the CLI share.
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

### Propose tools (need an agent key)

| Tool | Input | Returns |
| --- | --- | --- |
| `propose_ban_user` | `userId` | `{ proposal, changed: false, nextStep }` |

- A **proposal** is `id`, `operation`, `target` (`type`, `id`), `summary`, `status`,
  `createdAt` and `expiresAt`. `summary` is the server's own sentence for the operation.
- **Nothing has happened when the tool answers.** The user is banned only if a person
  approves the proposal within ten minutes: `tula approve <proposal id>`, with their own
  secret key ([proposals.md](proposals.md)). The server has no tool that approves, and
  holds no credential that could.
- Asking again for the same thing while a proposal is pending returns that proposal.
- Revoking the agent key ends the proposals it made that nobody approved: they can no
  longer be approved, and the key reads and proposes nothing more.
- A production environment refuses (`auth.forbidden`); an unknown user is
  `resource.not_found`; more than ten proposals a minute are `rate_limited`.
- `list_audit_entries` shows what became of a proposal: `action` `proposal.created`,
  `proposal.approved`, `proposal.executed`, `proposal.failed`, and `actorType: "agent"`.

### Scaffold tools (need nothing)

| Tool | Input | Returns |
| --- | --- | --- |
| `detect_framework` | `directory?` (default: where the server was started) | `{ directory, framework, supported, tulaPackages }` |
| `scaffold_provider` | `framework` | `{ framework, files: [{ path, contents }], dependencies, environment, notes }` |
| `scaffold_protected_route` | `framework` | the same |
| `scaffold_sign_in_page` | `framework` | the same |

`framework` is `nextjs` (App Router) or `react-vite`. The files are the ones the example apps
and `create-tula` use. **The server writes nothing**: your client writes the files, after you
agree. `detect_framework` reads one `package.json`, only inside the directory the server was
started in, and returns nothing of it but the framework and which Tula packages it names.

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

- A request to the API has 15 seconds; `run_doctor` has 30 for all of its requests. When a
  call runs out of time, or your client cancels it, the requests it made are aborted. A call
  cancelled before its turn never runs and is answered `cancelled`.
- Four read, draft or propose tools run at once and sixteen more wait their turn. A call beyond
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
| `not_configured` | No key (or API URL) was configured, or it was refused at start. For a propose tool: no agent key. |
| `path.outside_root` | `detect_framework` was asked about a directory outside the server's own. |
| `path.not_found` | No such directory, or no `package.json` in it. |
| `package.invalid` | The `package.json` is not a readable JSON file. |
| `output.too_large` | The result could not be cut to the size limit. |
| `change.invalid` | `draft_settings_change` was asked for a change no config file could hold. `problems` lists a path and a closed word for each; nothing was drafted. |
| `settings.unreadable` | `draft_settings_change` could not read the environment's settings document as this version knows it, so it drafted nothing. Use a `tula` of the API's version. |
| `busy` | Four read or propose calls are running and sixteen are waiting. Try again when some have answered. |
| `cancelled` | The call was cancelled before its turn came; nothing was asked of the API. |
| `internal` | Something unforeseen; its name is on standard error. |
