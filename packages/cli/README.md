# @tula-tech/cli

The `tula` command line for [Tula Auth](../../README.md): `tula dev` (the local stack),
`tula doctor` (check a deployment), `tula policy test` (try a password against a policy),
`tula import` (move users, with their password hashes, from Clerk, Auth0, Firebase, Supabase or
better-auth), `tula mcp` (the MCP server, [docs/mcp.md](../../docs/mcp.md)), and
`tula diff` / `tula apply`, which keep an environment's settings and OAuth providers in step
with a `tula.config.ts`. Every command is in [docs/cli.md](../../docs/cli.md); settings as code
in [docs/config.md](../../docs/config.md); the decisions in
[ADR 0030](../../docs/adr/0030-config-and-apply.md) and
[ADR 0031](../../docs/adr/0031-instance-admin-and-cli.md).

```sh
bun add -d @tula-tech/cli@latest      # then: bunx tula <command>
```

**Install it first.** The package is `@tula-tech/cli`; `tula` is only the name of its command.
A bare `bunx tula` or `npx tula` without the local install resolves to an unrelated package
named `tula` on npm, which would be downloaded and run with whatever is in your environment.
Where there is no project to install into (an MCP client's configuration, a one-off check),
name the package: `bunx --package @tula-tech/cli@latest tula <command>`.

> **Early release (0.x).** Commands and flags may change from one release to the next. The executable runs on [Bun](https://bun.sh) 1.2 or later, not on Node.
> Inside this repository it is `bun run tula -- <command>`. Everything else is in the
> [repository](https://github.com/Tula-Solutions/tula-auth-and-user-management#readme).

```sh
export TULA_API_URL=https://auth.example.com
export TULA_SECRET_KEY=…            # never on the command line

tula diff --env prod                # what would change; exit 2 when something would
tula apply --env prod               # the same plan, a confirmation, then the changes
tula apply --env prod --yes         # in CI
```

| Exit code | `tula diff` | `tula apply` |
| --- | --- | --- |
| `0` | no changes | applied, or nothing to do |
| `1` | an error | an error, or the confirmation was declined |
| `2` | changes pending | (not used) |

`apply --yes` never weakens security and never resets a setting a newer server has: those
plans are refused unless `--allow-weaker` / `--allow-unknown` say so. The API URL must be
https (or localhost; `--insecure-http` for a private network you trust).

`tula` runs on **Bun** (`#!/usr/bin/env bun`): the first thing every command does is import
the project's `tula.config.ts`, which Bun runs as it is.

## Commands

| Command | What |
| --- | --- |
| `tula dev` | Start the local stack of a project `create-tula` made: Compose, migrations, seed, development keys. |
| `tula dev down` | Stop it; the data is kept. `--volumes` also deletes the database (asks first). |
| `tula doctor` | Check a deployment, each problem with its fix. `--strict` fails on a warning, `--json` is for a pipeline. |
| `tula policy test` | Which rules of an environment's password policy a password passes. |
| `tula mcp` | The MCP server an AI assistant reads and proposes through, on standard input and output. |
| `tula approve <id>` | Approve a change an assistant proposed, after showing what it does. |
| `tula import --from <provider> <file>` | Move users, with their password hashes, from Clerk, Auth0, Firebase, Supabase or better-auth. Prints a report; `--yes` imports. |
| `tula audit export` | Stream the audit log as NDJSON or CSV (`--format`, `--from`, `--to`, `--action`, `--organization`, `--resume`). |
| `tula diff`, `tula apply` | Settings as code: compare, then change an environment to match `tula.config.ts`. |

```sh
tula dev                       # start, or continue; running it again changes nothing
tula dev --tunnel              # the same stack at a public https address a phone can reach
tula doctor --strict
printf %s "$PW" | tula policy test --env prod --email maya@example.com
tula import --from supabase supabase-users.csv          # a report; nothing is sent
tula import --from supabase supabase-users.csv --yes
tula audit export --from 2026-01-01 --to 2026-02-01 > january.ndjson
```

Options shared by the commands that talk to an API: `--env <name>`, `--api-url <url>`,
`--insecure-http` and `--secret-key-file <path>`. `tula apply` also takes `--yes`,
`--prune`, `--allow-weaker`, `--allow-unknown` and `--allow-webhook-removal`; a run that
creates a webhook endpoint needs `--secrets-file`, `--show-secrets` or `--discard-secrets` to
say what happens to its signing secret. Exit codes differ per command and are listed with each
in [docs/cli.md](../../docs/cli.md).

## Credentials are never arguments

A command line is kept in shell history and shows in process lists, so no option takes a
secret: `--secret-key`, `--admin-token` and `--password` do not exist.

| What | Where it comes from |
| --- | --- |
| API URL | `--api-url`, else `TULA_API_URL_<NAME>` (with `--env <name>`), else `TULA_API_URL`. |
| Secret key | `TULA_SECRET_KEY_<NAME>`, else `TULA_SECRET_KEY`, or `--secret-key-file <path>`. |
| Agent key (`tula mcp` only) | `TULA_AGENT_KEY_<NAME>`, else `TULA_AGENT_KEY`, or `--agent-key-file <path>`. |
| Instance admin token | `TULA_ADMIN_TOKEN`, or `--admin-token-file <path>` (`-` for a pipe). |

Bun loads `.env` and `.env.local` from the current directory, so in a project made by
[`create-tula`](../create-tula/README.md) the URL and keys `tula dev` wrote are found with
nothing exported.

## Security notes

- The API URL must be https, or this machine; `--insecure-http` is for a private network you
  trust.
- `tula policy test` evaluates the rules on your machine: the password is never sent, printed
  or logged. `tula import` reads the provider's export locally, prints no hash, token or whole
  address, and keeps its progress file at mode `0600` with no hash in it.
- `tula dev` writes keys to `.env.local` at mode `0600` and prints the secret key only with
  `--show-keys`.
- `tula mcp` with an agent key does not read the secret key at all.
- The CLI never connects to your database; `tula doctor` asks the API.

## Requirements

[Bun](https://bun.sh) 1.2 or later (`engines.bun`). The executable is `#!/usr/bin/env bun`,
and every command imports the project's `tula.config.ts` as it is. `tula dev` also needs
Docker with Compose.

## Running it

| Where | How |
| --- | --- |
| A project, after `bun add -d @tula-tech/cli@latest` | `bunx tula <command>` |
| Anywhere else | `bunx --package @tula-tech/cli@latest tula <command>` |
| This repository | `bun run tula -- <command>` |

In CI, install the package as a dev dependency and call `tula diff --env prod` as a check
(exit 2 means the file and the environment disagree) before `tula apply --env prod --yes`.
Keep the secret key in the CI system's secret store and pass it as `TULA_SECRET_KEY_PROD`.

## Learn more

- [docs/cli.md](../../docs/cli.md): every command, option and exit code.
- [docs/config.md](../../docs/config.md): `tula.config.ts`, `diff` and `apply`.
- [docs/mcp.md](../../docs/mcp.md): the MCP server and `tula approve`.
- [docs/quickstart.md](../../docs/quickstart.md): a project of your own.

## Contributing

A new command is one object of the `Command` shape added to `COMMANDS` in `src/index.ts`.
