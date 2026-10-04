# @tula/cli

The `tula` command line for [Tula Auth](../../README.md). Today: `tula diff` and `tula apply`,
which keep an environment's settings and OAuth providers in step with a `tula.config.ts`. The
full guide is [docs/config.md](../../docs/config.md); the decisions are in
[ADR 0030](../../docs/adr/0030-config-and-apply.md).

> Not published yet. Inside this repository: `bun run tula -- <command>`.

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
