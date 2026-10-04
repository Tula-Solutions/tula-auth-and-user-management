# The `tula` command line

`tula` (the `@tula/cli` package) and `create-tula` run on [Bun](https://bun.sh). The design is
in [ADR 0030](adr/0030-config-and-apply.md) and [ADR 0031](adr/0031-instance-admin-and-cli.md).
Nothing is published yet: inside this repository run `bun run tula -- <command>`, and see
[quickstart.md](quickstart.md) for a project of your own.

| Command | What |
| --- | --- |
| [`create-tula`](#create-tula) | Scaffold a project. |
| [`tula dev`](#tula-dev) | Start the local stack: Compose, migrations, seed, development keys. |
| [`tula doctor`](#tula-doctor) | Check a deployment, each problem with its fix. |
| [`tula policy test`](#tula-policy-test) | Which password rules a password passes. |
| [`tula diff`, `tula apply`](config.md) | Settings as code. |

## Credentials are never arguments

A command line is recorded in shell history and visible in process lists, so no option takes a
secret. `--secret-key`, `--admin-token` and `--password` do not exist, and say what to do
instead.

| What | Where it comes from |
| --- | --- |
| API URL | `--api-url`, else `TULA_API_URL_<NAME>` (with `--env <name>`), else `TULA_API_URL`. `https`, or this machine; `--insecure-http` for a private network. |
| Secret key (an environment's) | `TULA_SECRET_KEY_<NAME>`, else `TULA_SECRET_KEY`, or `--secret-key-file <path>`. |
| Instance admin token (the deployment's) | `TULA_ADMIN_TOKEN`, or `--admin-token-file <path>` (`-` for a pipe). |

Bun loads `.env` and `.env.local` from the current directory, so in a scaffolded project
`tula` finds the URL and the keys `tula dev` wrote, and the admin token `create-tula`
generated, with nothing exported.

## `create-tula`

```sh
bun create tula my-app                         # asks for the framework
bunx create-tula my-app --framework nextjs     # no questions
```

| Option | What |
| --- | --- |
| `--framework react-vite \| nextjs` | The example app. Asked for on a terminal; required without one. |
| `--api-image <ref>` | The Tula API image (`TULA_API_IMAGE` in `.env`). Default `tula-api:local`. |
| `--api-port <port>`, `--mailpit-port <port>` | Host ports of the API (3003) and Mailpit's inbox (8025). |
| `--tula-packages <dir>` | Install the `@tula/*` packages from tarballs in this directory. |
| `--force` | Write into a directory that is not empty. `.env` and `.env.local` are never replaced; an existing `.gitignore` keeps its lines and gains the ones it lacks. |

The name is the directory, the package name and the Compose project name: lowercase letters,
digits, dashes and underscores. Exit codes: 0 created, 1 an error (nothing is written).

It writes `compose.yaml`, `.env` (mode 0600; a generated `TULA_MASTER_KEY`,
`TULA_ADMIN_TOKEN` and two database passwords, never a default), `.gitignore`, `.env.example`,
`tula.config.ts`, `README.md`, `docker/postgres/init.sh` and the app. **Back up
`TULA_MASTER_KEY`.** `.gitignore` is written first and `.env` last, so the secrets are never on
disk without the file that keeps them out of git. A symbolic link where a file or directory
would be written (or as the project directory) is refused before anything is written.

## `tula dev`

```sh
tula dev                       # start, or continue: running it again changes nothing
tula dev --show-keys           # also print the secret key
tula dev down                  # stop; the data is kept
tula dev down --volumes        # stop and delete the database (asks first; --yes without a terminal)
```

Runs in a project made by `create-tula`: a directory whose Compose file has `api` and
`migrate` services. It:

1. runs the migrations (`docker compose run --rm migrate`) and the seed, with the commands the
   API image ships;
2. starts the API and waits until it is ready;
3. mints a publishable and a secret development key, unless `.env.local` already has keys the
   stack accepts;
4. writes them to its own block of `.env.local` (readable by you only) as `TULA_API_URL`,
   `TULA_ENVIRONMENT_ID`, `TULA_PUBLISHABLE_KEY`, `TULA_SECRET_KEY`, and the names Vite and
   Next.js read (`VITE_TULA_API_URL`, `VITE_TULA_PUBLISHABLE_KEY`,
   `NEXT_PUBLIC_TULA_PUBLISHABLE_KEY`);
5. prints the URLs of the API, its reference and Mailpit.

Lines of `.env.local` outside the block are never changed, and a `TULA_SECRET_KEY` of your
own is used as it is. The block is the lines from `# tula:dev:start` to the first
`# tula:dev:end` after it (each a whole line). The file's mode is checked on every run, not
only when its contents change: one that other users could read is set back to 0600, with a
warning. If the stack no longer accepts the keys in the block (its database was
wiped by hand), `tula dev` says so and changes nothing: `--rotate-keys` mints new ones.

| Option | What |
| --- | --- |
| `-p, --project-name <name>` | The Compose project. Default: `COMPOSE_PROJECT_NAME`, then the directory's name. |
| `--show-keys` | Print the secret key. |
| `--rotate-keys` | Mint new keys and replace the block. |
| `--timeout <seconds>` | How long one step may take (default 900: the first run pulls images). |
| `--volumes`, `-y, --yes` | With `down`. |

Ports come from the Compose file and its `.env` (`API_PORT`, `MAILPIT_UI_PORT`). Exit codes:
0 done, 1 an error, with the step that failed and the last lines Docker said.

## `tula doctor`

```sh
tula doctor                    # table; a fix line under everything that is not ok
tula doctor --strict           # a warning fails too
tula doctor --json             # for a pipeline
```

```text
  ok       api          The API answers.
  FAIL     smtp         The mail relay cannot be reached or refused the connection.
                        fix: Check SMTP_URL (host, port, user, password, …)
```

| Check | Runs | What |
| --- | --- | --- |
| `api` | here | The API URL answers `/v1/status`. |
| `version` | here | The CLI and the API are the same version. |
| `local_clock` | here | This machine's clock against the API's (5 s warns, 30 s fails). |
| `database` | server | The API reaches Postgres. |
| `migrations` | server | The database is migrated to what the running version ships. |
| `master_key` | server | `TULA_MASTER_KEY` opens the stored signing keys and provider credentials of the 200 oldest environments. With more, it is a warning that says how many were checked. |
| `smtp` | server | The mail relay accepts a connection and the credentials. Nothing is sent. |
| `redis` | server | Redis answers (`skipped` without `REDIS_URL`). |
| `clock` | server | The API's clock against the database's. |
| `public_url` | server, or here | `PUBLIC_URL` reaches the API. A loopback one is checked from this machine, and only when it is the API URL you gave: an address the server names is never requested otherwise (`skipped`; run `tula doctor --api-url <PUBLIC_URL>`). |
| `oauth_redirect_uris` | server | The redirect URI to register with each enabled provider (listed, not verified). |
| `server_checks` | here | Appears when the server's checks could not run, with why. |

The server's checks need the instance admin token: set `TULA_ADMIN_TOKEN` in the API's
environment (`openssl rand -hex 32`; at least 32 characters) and the same value where `tula`
runs. Without it on the server the route does not exist and `doctor` says so; without it here
only the local checks run. The CLI never connects to the database, and a check's text never
contains a connection string, a key or a driver's message: the reason is in the API's log.

Exit codes: 0 nothing failed, 1 a check failed (or warned, with `--strict`) or an error.

## `tula policy test`

```sh
tula policy test                                   # asks for the password; nothing is shown
printf %s "$PW" | tula policy test --email maya@example.com --name "Maya Lin"
tula policy test --env prod --json
```

Shows which rules of the environment's password policy a password passes. The policy is read
with the secret key; the rules are evaluated **on your machine** by the same code the server
uses. The password is never sent anywhere, printed or logged.

- On a terminal it is asked for with echo off; piped, it is read from standard input (one
  trailing line break is dropped).
- `tula policy test "<password>"` works too, with a warning: the command line is recorded in
  your shell's history.
- `--email` and `--name` feed the "does not contain the user's name or email" rule.
- The breached-password check is reported as **not run**: the server makes it when a password
  is set, and there is deliberately no route that checks an arbitrary password.

Exit codes: 0 the password would be accepted, 2 it would be refused, 1 an error.

## `tula mcp`

```sh
TULA_API_URL=https://auth.example.com TULA_SECRET_KEY=… tula mcp
```

Serves Tula's [Model Context Protocol](https://modelcontextprotocol.io) server on standard
input and output, for an MCP client to start as a child process. It has read tools (users,
sessions, audit entries, settings, OAuth providers, the doctor's checks) and scaffold tools
(the provider, a protected route, a sign-in page). **No tool changes live data and none
returns a secret.** The tools, the client configuration and exactly what is returned are in
[docs/mcp.md](mcp.md).

| Option | |
| --- | --- |
| `--env <name>` | Read `TULA_API_URL_<NAME>` and `TULA_SECRET_KEY_<NAME>` first. |
| `--api-url <url>` | The API. Default: `TULA_API_URL_<NAME>`, then `TULA_API_URL`. |
| `--secret-key-file <path>` | Read the secret key from a file. Default: `TULA_SECRET_KEY_<NAME>`, then `TULA_SECRET_KEY`. |
| `--admin-token-file <path>` | Read the instance admin token from a file (`run_doctor` only). Default: `TULA_ADMIN_TOKEN`. |
| `--insecure-http` | Allow a plain http API URL that is not localhost. |

- Nothing is required. Without a secret key the read tools answer `not_configured` and the
  scaffold tools still work.
- `-` is refused for both files: standard input carries the protocol.
- Standard output carries only protocol messages. What is configured, one line per tool call
  (the tool, the outcome, the time; never an argument) and every error go to standard error.
- It does not load `tula.config.ts`.
- It exits 0 when the client closes standard input, and on SIGTERM or SIGINT.

## `tula diff` and `tula apply`

See [config.md](config.md). Exit codes of `diff`: 0 no changes, 2 changes pending, 1 an error.
