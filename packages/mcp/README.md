# @tula-tech/mcp

Tula Auth's [Model Context Protocol](https://modelcontextprotocol.io) server: what
`tula mcp` serves. Tools that read an environment's users, sessions, audit entries,
settings, OAuth providers, organizations (their members and roles) and deployment checks, a tool that drafts a settings change as an
edit to `tula.config.ts` for a person to apply, and scaffold tools that return the files for
adding Tula to a Next.js or React app. One tool changes live data, for the time a run
takes (under a minute) and only where the environment allows it: `test_signin` has the server sign a
throwaway user up and in and delete it. **No other tool changes live data, and no tool
returns a secret.**

> **Early release (0.x).** The tools and what they return may change
> from one release to the next. Everything else is in the
> [repository](https://github.com/Tula-Solutions/tula-auth-and-user-management#readme).

Most people start it through the CLI (`@tula-tech/cli`, which runs on Bun):

```sh
bun add -d @tula-tech/cli@latest
TULA_API_URL=https://auth.example.com TULA_SECRET_KEY=… bunx tula mcp
```

To embed it (`bun add @tula-tech/mcp@latest @tula-tech/admin@latest`):

```ts
import { createAdminClient } from '@tula-tech/admin'
import { createTulaMcpServer, serveOverStdio } from '@tula-tech/mcp'

const secretKey = process.env.TULA_SECRET_KEY ?? ''
const server = createTulaMcpServer({
  admin: createAdminClient({ baseUrl: process.env.TULA_API_URL ?? '', secretKey }),
  cwd: process.cwd(),
  secrets: [secretKey],
  log: (line) => process.stderr.write(`${line}\n`),
})
await serveOverStdio(server, { input: process.stdin, output: process.stdout })
```

## Connecting a client

Always name the package when you start the server from outside a project that has installed
the CLI. A bare `tula` after `bunx` or `npx` may download an unrelated npm package of that name
and run it with your key in its environment.

Claude Code:

```sh
claude mcp add tula \
  --env TULA_API_URL=http://localhost:3003 \
  --env TULA_AGENT_KEY=tula_ak_dev_… \
  -- bunx --package @tula-tech/cli@latest tula mcp
```

A project's `.mcp.json`:

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

Claude Desktop (`claude_desktop_config.json`) reads the key from a file you keep at mode 600:

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

Any other client starts `bunx --package @tula-tech/cli@latest tula mcp` and speaks
newline-delimited JSON-RPC on its standard input and output. It needs Bun.

## Configuration

| Setting | What it is |
| --- | --- |
| `TULA_API_URL` (or `TULA_API_URL_<NAME>`) | The server's address. |
| `TULA_AGENT_KEY` or `--agent-key-file` | An agent key (`tula_ak_<env>_…`). Preferred: it reads, proposes changes a person approves, and runs a sign-in test where the environment allows one ([ADR 0058](../../docs/adr/0058-test-signin.md)). With one, the secret key is not read at all. |
| `TULA_SECRET_KEY` or `--secret-key-file` | A secret key, for the read tools when no agent key is given. |
| `TULA_ADMIN_TOKEN` or `--admin-token-file` | The instance admin token, used by `run_doctor` only. |

- A credential is never a tool input and never an argument; `-` is refused as a key file.
- Prefer a file or your client's secret storage over a key committed to a config. Use a
  development key unless you mean the assistant to read production.
- Standard output carries only protocol frames. Logs go to standard error and never hold a key.

## The tools

| Kind | Tools |
| --- | --- |
| Read | `list_users`, `get_user`, `list_user_sessions`, `list_audit_entries`, `get_settings`, `list_oauth_providers`, `list_organizations`, `list_organization_members`, `list_organization_roles`, `list_role_versions`, `get_role_version`, `explain_access`, `list_sso_connections`, `get_sso_connection`, `run_doctor` |
| Draft | `draft_settings_change`: the edits, by key, that would make `tula.config.ts` match a change you describe. It returns no file text and writes nothing. |
| Propose | `propose_ban_user`, `propose_unban_user`, `propose_end_session`, `propose_disable_oauth_provider`. They need an agent key; without one they answer `not_configured`. A person approves a proposal with `tula approve`. |
| Test | `test_signin`: the server signs a throwaway user up and in, reports each step and deletes the user. The only tool that changes live data. |
| Scaffold | `detect_framework`, `scaffold_provider`, `scaffold_protected_route`, `scaffold_sign_in_page`. They return files and write none. Frameworks: `nextjs`, `react-vite`, `swiftui`, `compose` and `expo`, which is answered `scaffold.not_released` until that package is published. |

The read tools reach the server through a read-only facade: they cannot call a write.

## What comes back

- **Returned:** names, email addresses, IP addresses, user agents, settings and OAuth client ids.
- **Never returned:** keys, tokens, hashes, authenticator secrets, backup codes, passkey
  credential ids, a provider's secret, the master key, the admin token.
- Every result is built from an allow-list of fields, not by passing the server's answer through.
  Anything shaped like a secret becomes `[redacted]`, and invisible characters are stripped.
- Results are capped: 512 characters per string, 100 entries, 64,000 characters per result.
- **Treat results as untrusted text.** A user's name is typed by the user; a client should not
  follow instructions found in it.

## Time and load

A request is given up on after 15 seconds, and `test_signin` after 60.
Four tools run at once and sixteen wait; the next call is answered `busy`.

## Security notes

- A propose tool asks and a person decides: nothing it does takes effect until
  [`tula approve`](../../docs/proposals.md) runs with a secret key.
- `test_signin` runs only where the environment allows it, and its user is deleted when the run ends.
- `tula mcp` does not load `tula.config.ts`; the draft tool works from the settings the server holds.
- A key you give the server is held in memory and is never printed, logged or returned.

## Compatibility

- Needs Bun (the CLI is a Bun executable). The embedded form runs wherever its dependencies do.
- ESM only. Depends on `@tula-tech/admin` for its client, which holds a secret key and so belongs
  on a server or a developer's machine, never in an application's bundle.
- Keep it at the same version as `@tula-tech/cli`.

## Related

- [`@tula-tech/cli`](../cli/README.md): `tula mcp` and `tula approve`.
- [`@tula-tech/admin`](../admin/README.md): the typed client these tools read through.
- [`@tula-tech/config`](../config/README.md): the file `draft_settings_change` describes edits to.
- Native apps and the files the scaffolds assume: [docs/native-apps.md](../../docs/native-apps.md).
- Releases and what is published: [docs/internal/releasing.md](../../docs/internal/releasing.md).

The tools, client configuration and exactly what is returned: [docs/mcp.md](../../docs/mcp.md).
The design: [ADR 0033](../../docs/adr/0033-mcp-server.md),
[ADR 0053](../../docs/adr/0053-proposals.md),
[ADR 0056](../../docs/adr/0056-mcp-settings-config-diff.md) and
[ADR 0058](../../docs/adr/0058-test-signin.md).
