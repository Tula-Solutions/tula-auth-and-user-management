# @tula-tech/cli

The `tula` command line for [Tula Auth](../../README.md): `tula dev` (the local stack),
`tula doctor` (check a deployment), `tula policy test` (try a password against a policy),
`tula mcp` (the MCP server, [docs/mcp.md](../../docs/mcp.md)), and
`tula diff` / `tula apply`, which keep an environment's settings and OAuth providers in step
with a `tula.config.ts`. Every command is in [docs/cli.md](../../docs/cli.md); settings as code
in [docs/config.md](../../docs/config.md); the decisions in
[ADR 0030](../../docs/adr/0030-config-and-apply.md) and
[ADR 0031](../../docs/adr/0031-instance-admin-and-cli.md).

```sh
bun add -d @tula-tech/cli@alpha      # then: bunx tula <command>
```

**Install it first.** The package is `@tula-tech/cli`; `tula` is only the name of its command.
A bare `bunx tula` or `npx tula` without the local install resolves to an unrelated package
named `tula` on npm, which would be downloaded and run with whatever is in your environment.
Where there is no project to install into (an MCP client's configuration, a one-off check),
name the package: `bunx --package @tula-tech/cli@alpha tula <command>`.

> **Alpha.** Released under the `alpha` dist-tag: commands and flags may change from one
> alpha to the next. The executable runs on [Bun](https://bun.sh) 1.2 or later, not on Node.
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

A new command is one object of the `Command` shape added to `COMMANDS` in `src/index.ts`.
