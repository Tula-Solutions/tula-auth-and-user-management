# The MCP server (`tula mcp`)

`tula mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server. An MCP
client (Claude Code, Claude Desktop, an editor) starts it as a child process and talks to it
over standard input and output. It lets an assistant **read** an environment (users,
sessions, audit entries, settings, deployment checks) and gives it the files for adding Tula
to an app.

**There are no write tools in Phase 1.** No tool changes live data: nothing bans a user,
revokes a session or edits a setting, and the scaffold tools return files without writing
them. The server never returns a secret, a token or key material. The design is in
[ADR 0033](adr/0033-mcp-server.md).

## Configuration

The server reads its credentials from the environment the client starts it with, the same
way every `tula` command does ([docs/cli.md](cli.md)). None is required.

| Variable | Used for |
| --- | --- |
| `TULA_API_URL` (or `TULA_API_URL_<NAME>` with `--env <name>`) | Where the Tula API is. https, or this machine. |
| `TULA_SECRET_KEY` (or `TULA_SECRET_KEY_<NAME>`), or `--secret-key-file <path>` | The read tools. The key decides the environment. |
| `TULA_ADMIN_TOKEN`, or `--admin-token-file <path>` | `run_doctor`'s server-side checks only. |

- Without a secret key the read tools answer `not_configured`; the scaffold tools work with
  no configuration at all.
- A credential is never an argument and never a tool input. `--secret-key-file -` is refused:
  standard input carries the protocol.
- Prefer a file or your client's secret storage over writing a key into a config file that
  is committed. Use a development key unless you mean to read production.

### Claude Code

```sh
claude mcp add tula \
  --env TULA_API_URL=http://localhost:3003 \
  --env TULA_SECRET_KEY=tula_sk_dev_… \
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
        "TULA_SECRET_KEY": "${TULA_SECRET_KEY}"
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
      "args": ["tula", "mcp", "--secret-key-file", "/Users/you/.config/tula/dev.key"],
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

Every tool is annotated read-only. Inputs are strict: a property a tool does not name is
refused.

### Read tools (need a secret key)

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
  `tenant` (Microsoft's: an alias or a tenant id, not a secret), `callbackUrl`, `updatedAt`.
- `run_doctor` needs only `TULA_API_URL`; with `TULA_ADMIN_TOKEN` it includes the checks the
  API makes of itself.

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
- **Never returned**: secret or publishable keys, signing keys, access or refresh tokens,
  password hashes, TOTP secrets, backup codes, passkey credential ids, provider client
  secrets, the master key, the admin token. There is no tool that lists API keys. There is none for
  [native apps](native-apps.md) either: not because they are secret (they are in two public
  files), but because no tool has needed them yet.
- Results are built from an allow-list of fields, so a field the API gains later is not
  returned by default. Values that look like a secret (a `tula_sk_…` key, a JWT, a password
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
- Four read tools run at once and sixteen more wait their turn. A call beyond that is refused
  at once with `busy`: wait for some answers and call again. The scaffold tools are not
  counted.
- Only `tula mcp` loads the server and its SDK; other `tula` commands start without them.

## Errors

A failed call is a tool error: `{ "error": { "code", "message", "status"?,
"retryAfterSeconds"? } }`. `code` is a contract error code (`resource.not_found`,
`auth.invalid_key`, `rate_limited`, …), a client code (`network.failed`, `network.timeout`)
or one of the server's own:

| Code | Meaning |
| --- | --- |
| `not_configured` | No secret key (or API URL) was configured, or it was refused at start. |
| `path.outside_root` | `detect_framework` was asked about a directory outside the server's own. |
| `path.not_found` | No such directory, or no `package.json` in it. |
| `package.invalid` | The `package.json` is not a readable JSON file. |
| `output.too_large` | The result could not be cut to the size limit. |
| `busy` | Four read calls are running and sixteen are waiting. Try again when some have answered. |
| `cancelled` | The call was cancelled before its turn came; nothing was asked of the API. |
| `internal` | Something unforeseen; its name is on standard error. |
