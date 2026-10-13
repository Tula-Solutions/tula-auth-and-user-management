# The `tula` command line

`tula` (the `@tula-tech/cli` package) and `create-tula` run on [Bun](https://bun.sh). The design is
in [ADR 0030](adr/0030-config-and-apply.md) and [ADR 0031](adr/0031-instance-admin-and-cli.md).
Both are released to npm as alphas (`bun add -d @tula-tech/cli@alpha`, then `bunx tula <command>`;
[releasing.md](releasing.md)). **Run `bunx tula` only in a project that has the CLI
installed**: anywhere else the name resolves to an unrelated npm package called `tula`. Outside a
project, name the package: `bunx --package @tula-tech/cli@alpha tula <command>`. Inside this
repository run `bun run tula -- <command>`, and see
[quickstart.md](quickstart.md) for a project of your own.

| Command | What |
| --- | --- |
| [`create-tula`](#create-tula) | Scaffold a project. |
| [`tula dev`](#tula-dev) | Start the local stack: Compose, migrations, seed, development keys. |
| [`tula doctor`](#tula-doctor) | Check a deployment, each problem with its fix. |
| [`tula policy test`](#tula-policy-test) | Which password rules a password passes. |
| [`tula mcp`](#tula-mcp) | The MCP server an AI assistant reads and proposes through. |
| [`tula approve`](#tula-approve) | Approve a change an assistant proposed. |
| [`tula diff`, `tula apply`](config.md) | Settings as code. |

## Credentials are never arguments

A command line is recorded in shell history and visible in process lists, so no option takes a
secret. `--secret-key`, `--admin-token` and `--password` do not exist, and say what to do
instead.

| What | Where it comes from |
| --- | --- |
| API URL | `--api-url`, else `TULA_API_URL_<NAME>` (with `--env <name>`), else `TULA_API_URL`. `https`, or this machine; `--insecure-http` for a private network. |
| Secret key (an environment's) | `TULA_SECRET_KEY_<NAME>`, else `TULA_SECRET_KEY`, or `--secret-key-file <path>`. |
| Agent key (an environment's, `tula mcp` only) | `TULA_AGENT_KEY_<NAME>`, else `TULA_AGENT_KEY`, or `--agent-key-file <path>`. |
| Instance admin token (the deployment's) | `TULA_ADMIN_TOKEN`, or `--admin-token-file <path>` (`-` for a pipe). |

Bun loads `.env` and `.env.local` from the current directory, so in a scaffolded project
`tula` finds the URL and the keys `tula dev` wrote, and the admin token `create-tula`
generated, with nothing exported.

## `create-tula`

```sh
bunx create-tula@alpha my-app                        # asks for the framework
bunx create-tula@alpha my-app --framework nextjs     # no questions
```

| Option | What |
| --- | --- |
| `--framework react-vite \| nextjs \| expo \| swiftui \| compose` | The example app: two web ones, three native ones. Asked for on a terminal; required without one. |
| `--tula-repo <dir>` | A checkout of the Tula repository. Required for `swiftui` and `compose`, refused for the others: the Swift package and the Kotlin libraries are published nowhere, so the project names them by a path into the checkout. `--tula-repo` must be a checkout you trust: building the project runs its build scripts. |
| `--api-image <ref>` | The Tula API image (`TULA_API_IMAGE` in `.env`). Default `tula-api:local`. |
| `--api-port <port>`, `--mailpit-port <port>` | Host ports of the API (3003) and Mailpit's inbox (8025). |
| `--tula-packages <dir>` | Install the `@tula-tech/*` packages from tarballs in this directory. |
| `--force` | Write into a directory that is not empty. `.env` and `.env.local` are never replaced; an existing `.gitignore` keeps its lines and gains the ones it lacks. |

The name is the directory, the package name and the Compose project name: lowercase letters,
digits, dashes and underscores. Exit codes: 0 created, 1 an error (nothing is written).

It writes `compose.yaml`, `.env` (mode 0600; a generated `TULA_MASTER_KEY`,
`TULA_ADMIN_TOKEN` and two database passwords, never a default), `.gitignore`, `.env.example`,
`tula.config.ts`, `README.md`, `docker/postgres/init.sh` and the app. **Back up
`TULA_MASTER_KEY`.** `.gitignore` is written first and `.env` last, so the secrets are never on
disk without the file that keeps them out of git. A symbolic link where a file or directory
would be written (or as the project directory) is refused before anything is written.

A web app is the project itself. A native app is a directory of its own beside the stack's
files: `app` (Expo, with a `package.json` of its own that installs by itself), `ios` (an
Xcode project) or `android` (a Gradle build, run with the checkout's wrapper: the project
has none). The path from the project to `--tula-repo` holds letters, digits, dots, dashes and
underscores, and nothing else: a space among them (the Compose project's start command
prints the path in a shell line) stops the run before anything is written, with a sentence
that does not repeat the path. A native
project holds no key: the app is given the API's address and a publishable key when it is
started. [The native path of the quickstart](quickstart.md#the-native-path) has the steps,
and says what nobody has run.

## `tula dev`

```sh
tula dev                       # start, or continue: running it again changes nothing
tula dev --show-keys           # also print the secret key
tula dev --tunnel              # the same stack at a public https address a phone can reach
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
| `--tunnel` | Open a public https address for the stack ([below](#tula-dev---tunnel)). |
| `--show-keys` | Print the secret key. |
| `--rotate-keys` | Mint new keys and replace the block. |
| `--timeout <seconds>` | How long one step may take (default 900: the first run pulls images). |
| `--volumes`, `-y, --yes` | With `down`. |

Ports come from the Compose file and its `.env` (`API_PORT`, `MAILPIT_UI_PORT`). Exit codes:
0 done, 1 an error, with the step that failed and the last lines Docker said.

### `tula dev --tunnel`

A phone cannot reach `localhost`, and a passkey, an app link and a native sign-in need https
on a name the phone trusts. `--tunnel` starts the same stack under a public https address
that is the same on every run, through
[Tailscale Funnel](https://tailscale.com/kb/1223/funnel): the machine's own name in your
tailnet's `ts.net` domain ([ADR 0049](adr/0049-dev-tunnel.md) has why this service).

**Nobody has run this against a phone, and no tunnel was opened while it was built**: the
command is tested against a stand-in for Tailscale
([what was not verified](plans/phase-2-unverified.md#step-212-tula-dev---tunnel-tula-21-adr-0049)).

Before the first run, once, with Tailscale's own tools (`tula` takes no credential of
Tailscale's, reads none and stores none):

1. Install Tailscale (<https://tailscale.com/download>; on Linux
   `curl -fsSL https://tailscale.com/install.sh | sh`) and sign the machine in
   (`tailscale up`).
2. In the tailnet's admin console, on the DNS page, enable MagicDNS and HTTPS certificates.
   Tailscale warns there that machine names and the tailnet's name are published in a public
   ledger (Certificate Transparency): the tunnel's address is made of both.
3. Run `tailscale funnel 443` once by hand: Tailscale's own command is what asks for
   whatever is still missing (its documentation says it offers to add the `funnel`
   attribute to the tailnet's policy). Stop it with Ctrl-C.

Then `tula dev --tunnel`:

1. asks Compose what the API would be started with, and **stops, with nothing started, if
   the mock OAuth provider (`OAUTH_MOCK_PROVIDER=true`) or the development SMS inbox
   (`SMS_PROVIDER=dev`) is on**. The API refuses to start with either under an address that
   is not this machine's, and `tula dev` neither changes your `.env` nor works around the
   rule: switch them off, or run `tula dev` without `--tunnel` to keep them;
2. looks at what Tailscale serves on port 443 and **stops, with nothing started, if that is
   something else**; then runs the migrations and the seed;
3. stops the API's container if one is running (it was started without the tunnel), and
   writes the tunnel's record, `TULA_TUNNEL_TARGET`, to its block of `.env.local`: where
   the tunnel will send requests. The record is there before the address is;
4. opens the tunnel: everything at the address goes to the API's published port, and
   `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` go to the
   development environment's own [association files](native-apps.md);
5. starts the API with that address as its `PUBLIC_URL` (the issuer of its tokens), by
   setting `TULA_PUBLIC_URL` for the one `docker compose up` that starts it;
6. adds `TULA_PUBLIC_URL` and `TULA_ISSUER` to the block, with the keys. `TULA_API_URL`
   stays the local address: `tula` and a server on this machine keep reaching the API
   directly;
7. prints the address and the settings it did **not** change.

**It changes no setting of the environment.** For passkeys and a native app at the address,
put what it prints into `tula.config.ts` and run `tula apply`: `passkeys.rpId` (the
address's host name), the address among `urls.allowedOrigins`, any redirect URL or app link
under it in `urls.allowedRedirectUrls`, and the app under `nativeApps`, with the host name
as its associated domain.

What to know:

- **Anyone who has the address reaches everything the API serves**: the sign-in routes, the
  dashboard's sign-in, the API reference, the admin and instance routes behind their keys.
  The stack is still a local one (`ENVIRONMENT=local`). Close the tunnel when you are done.
- **The tunnel lasts as long as the stack, not the command.** `tula dev down` closes it,
  and so does `tula dev` without `--tunnel`, which also starts the API on its local
  address again. A run that fails after it opened the tunnel closes it before it exits.
  `tailscale funnel status` shows what is open; `tailscale funnel --https=443 off` closes
  it by hand.
- **Ctrl-C closes the tunnel the run opened.** From before the tunnel is opened until the
  stack is reported, `SIGINT` (Ctrl-C), `SIGTERM` (`kill`) and `SIGHUP` (a closed terminal
  window) stop the run at its next step, close the tunnel and take its record out of
  `.env.local`, and the command exits with an error. A second Ctrl-C while the tunnel is
  being closed does not cut the close short. **What that does not cover**: `SIGKILL`
  (`kill -9`), `SIGQUIT` (Ctrl-\\), a crash or a power loss leave the tunnel open. Its record is in `.env.local` by then (`TULA_TUNNEL_TARGET` with no
  `TULA_PUBLIC_URL` beside it), and `tula dev down`, or the next `tula dev`, closes the
  tunnel by it.
- **A tunnel that could not be closed stays recorded.** `tula dev` and `tula dev down` warn,
  with the command that closes it by hand, and keep `TULA_TUNNEL_TARGET` in the block so
  that the next run tries again; the line goes once the tunnel has.
- **It uses port 443 of the machine's Tailscale, and never touches what is already there.**
  If Funnel or `tailscale serve` already serves something else on that port, `--tunnel`
  stops and says so, and a later `tula dev down` leaves it alone.
- **The mock provider's pages and the SMS inbox do not answer through a tunnel**, whoever
  opened it: they answer only a request whose `Host` header names this machine. `tula`
  never asks a tunnel to rewrite that header; do not either.
- A project made before this option has a fixed `PUBLIC_URL` in its Compose file.
  `--tunnel` does not edit the file: it prints the line to put there
  (`PUBLIC_URL: ${TULA_PUBLIC_URL:-http://localhost:${API_PORT:-3003}}`).
- A `docker compose up` of your own starts the API on its local address: the public one
  comes from `tula dev --tunnel`, run by run. Do not put `TULA_PUBLIC_URL` in `.env`.
- Every request through the tunnel reaches the API from one address, so all of them share
  one per-address rate limit.
- The address changes if the machine or the tailnet is renamed.

When Tailscale is not installed, `--tunnel` says so with where to get it and starts
nothing. When it opens nothing in time (Funnel not allowed yet, the machine signed out) it
says that, closes what it opened and takes the tunnel's record out of `.env.local` again
(a file it created is removed). The API's container was stopped by then: `tula dev` starts
it again.

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
| `webhook_worker` | server | No event has waited a minute or more to be queued for delivery (in the 200 oldest environments). With `WEBHOOK_WORKER=separate` a waiting event is a failure: the worker is not running, or it cannot keep up or cannot work (the check cannot tell which). Where the API instances deliver it is a warning. It looks at what waits, never at the worker: `ok` with nothing waiting says nothing about whether a worker runs ([self-host.md](self-host.md#the-webhook-worker-as-its-own-service)). |
| `sms_sender` | server | Whether the deployment can send the text messages its environments were told to send. A warning when `SMS_PROVIDER` is `none` and an environment (of the 200 oldest) has text messages switched on: nothing is sent, and a request for a code is answered `sms.unavailable`. A failure when such an environment also signs in with a texted code (`signIn.methods.smsCode`): the method is then offered to nobody. `ok` with a sender; it sends nothing and does not ask the provider, so `ok` does not show that the credentials work ([self-host.md](self-host.md#text-messages-with-twilio)). |
| `device_binding` | server | Whether a session profile requires a device key in a deployment that can accept none ([device-binding.md](device-binding.md#a-deployment-that-cannot-bind)). `ok` when a device-binding proof can name `PUBLIC_URL`; nothing is read then, and no proof is made or checked. Where it cannot (most often a space, a percent sign or a letter outside ASCII in the path of `PUBLIC_URL`; the check names no cause): a warning, because no session is bound and a sign-in that brings a key is refused. A **failure** with a count when, in an environment (of the 200 oldest), the profile a native app gets by default (`mobile`) says `deviceBinding: "required"`: a native sign-in there is refused, `device.binding_required` without a key and `device.binding_not_supported` with one, unless it asks for a profile that requires none. A **warning** with a count when only a profile a sign-in has to ask for (`clientSelectable`) requires a key: a sign-in that asks for it cannot succeed, and one that asks for none is unaffected. Past 200 environments every answer begins with how many were not read. It names `PUBLIC_URL` and never its value, and no environment or profile. |
| `native_app_identities` | server | Every native app registered (in the 200 oldest environments) is well formed: a bundle ID, a package name, a team ID, certificate fingerprints and link paths this version would accept, and an Android app with at least one fingerprint. A failure counts the apps that are not; the API's log names them by id. It does **not** show that an identifier is the one your app really has: a bundle ID with a typing mistake in it is still a bundle ID. `skipped` with no app registered ([native-apps.md](native-apps.md#checking-with-tula-doctor)). |
| `native_app_files` | server | The two association files. What the server builds for each environment names exactly its registered apps (an app's link paths included: `applinks` and `handle_all_urls` are expected where an app has a path, and nowhere else), and for a sample (one file per platform) the server fetches its own copy at `PUBLIC_URL`: HTTP 200, `application/json`, no redirect, the body it built. A redirect, another status or an answer that is not JSON is a failure. A `401` or a `403` is a warning: an access wall or a firewall in front of the API's own host answered, which says nothing about what your apps' domain serves. A body that differs is a warning too (a cache may keep a copy for five minutes), and so is no answer. A loopback `PUBLIC_URL` is not fetched. It never requests **your** domain: `ok` is about the server's own copies, not about whether Apple or Android can reach them where your app looks. `skipped` with no app registered. |
| `native_app_passkeys` | server | Where an environment has native apps and passkeys are on: the relying party (`passkeys.rpId`) is a domain a platform can associate with an app, so not `localhost` or a loopback name. Otherwise a warning, never a failure: the apps there cannot use passkeys. Passkeys switched off is `ok` and said with a count (the apps there use the association files for saved passwords only), so `--strict` does not fail it. With `ENVIRONMENT=local` a `localhost` or `*.localhost` relying party is `ok` too, with a note that no platform can associate an app with it; a relying party that is not set or is no domain name is a warning in every tier. It does not look at whether that domain serves the association files. `skipped` with no app registered. |
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
TULA_API_URL=https://auth.example.com TULA_AGENT_KEY=… tula mcp
```

Serves Tula's [Model Context Protocol](https://modelcontextprotocol.io) server on standard
input and output, for an MCP client to start as a child process. It has read tools (users,
sessions, audit entries, settings, OAuth providers, the doctor's checks), scaffold tools
(the provider, a protected route, a sign-in page), a sign-in test and, with an agent key,
propose tools (ask for a user to be banned or a ban lifted, one session ended, one provider
switched off). **One tool changes live data, while it runs: `test_signin`** has the server
sign a throwaway user up and in and delete it, where the environment allows it
([mcp.md](mcp.md#the-sign-in-test)). No other tool does, and none returns a secret: a
proposal does nothing until a person approves it with [`tula approve`](#tula-approve). The
tools, the client configuration and exactly what is returned are in [docs/mcp.md](mcp.md).

| Option | |
| --- | --- |
| `--env <name>` | Read `TULA_API_URL_<NAME>` and `TULA_SECRET_KEY_<NAME>` first. |
| `--api-url <url>` | The API. Default: `TULA_API_URL_<NAME>`, then `TULA_API_URL`. |
| `--agent-key-file <path>` | Read the agent key from a file. Default: `TULA_AGENT_KEY_<NAME>`, then `TULA_AGENT_KEY`. With one, the secret key is not read. |
| `--secret-key-file <path>` | Read the secret key from a file. Default: `TULA_SECRET_KEY_<NAME>`, then `TULA_SECRET_KEY`. |
| `--admin-token-file <path>` | Read the instance admin token from a file (`run_doctor` only). Default: `TULA_ADMIN_TOKEN`. |
| `--insecure-http` | Allow a plain http API URL that is not localhost. |

- Nothing is required. Without a key the read tools answer `not_configured` and the
  scaffold tools still work; without an agent key the propose tools answer
  `not_configured` (a secret key does not propose).
- **With an agent key the secret key is not read at all**, although Bun has loaded
  `.env.local`: the server holds nothing that can change or approve anything, and says on
  standard error that the secret key was left unread.
- `-` is refused for all three files: standard input carries the protocol.
- Standard output carries only protocol messages. What is configured, one line per tool call
  (the tool, the outcome, the time; never an argument) and every error go to standard error.
- It does not load `tula.config.ts`.
- It exits 0 when the client closes standard input, and on SIGTERM or SIGINT.

## `tula approve`

```sh
tula approve 0199c2f4-7a10-7c3e-9b1a-5d2e8f4a6c01
```

A person's answer to a change an assistant proposed through `tula mcp`
([proposals.md](proposals.md), [ADR 0053](adr/0053-proposals.md)). It reads the proposal,
and what it is about, with **your secret key**: a user with their address and whether they
are banned, a session with whose it is (the user's id, address and name), the kind of
client, when it was signed in and whether it is live now or has already ended (live by
what is stored; a profile tightened since may end it at its next request), a provider
as it is now ("on now", "already off", "not configured now"). What could not be read is
said in those words beside the id ("could not be read", "no such session now") and never
guessed: you decide with that in front of you. For a provider that is on, the question
also says how many accounts can sign in only with it, as the server counted them just
then ("at least" when it did not look at every account; "no account was found" for none):
they are locked out while the provider is off. When that count could not be read, or the
server is from before the count, the question says so in fixed words and gives no number.
The server counts again when it switches the provider off, and that count is the one in
the audit entry. It prints who asked, what approving does, to what and when the proposal
expires; asks; and approves exactly what it printed. The
change is carried out at once and recorded with the agent as its actor and your key as the
one that approved. When there was nothing left to change by then (the session had already
ended, the user was not banned, the provider was already off) the command says so, in
place of the sentence that describes the change, and exits 0.

**It needs a terminal.** The question names the operation and what it is carried out on,
and the answer is the word `yes`, typed. Where standard input and standard error are not
both a terminal (a pipe, a redirect, a script, CI, an assistant's shell tool) the command
refuses before it reads or changes anything, whatever options it was given. There is no
`--yes`: an approval is yours to give, and an assistant that can run commands must not be
able to give it by running this one. The cost is that nothing can approve through this
command unattended; a program that must calls `POST /v1/admin/proposals/:id/approve` with
a secret key, and then nobody was asked.

| Option | |
| --- | --- |
| `--env <name>` | Read `TULA_SECRET_KEY_<NAME>` and `TULA_API_URL_<NAME>` first. |
| `--api-url <url>` | The API. Default: `TULA_API_URL_<NAME>`, then `TULA_API_URL`. |
| `--secret-key-file <path>` | Read the secret key from a file. Not `-`: standard input is where the answer is typed. |
| `--json` | Print the proposal as it stands after the run as JSON; everything else, the proposal as shown and the question among it, goes to standard error. |
| `--insecure-http` | Allow a plain http API URL that is not localhost. |

- Not at a terminal there is nobody to ask: nothing is read and nothing is changed, and
  no option changes that. `--yes` and `-y` are unknown options here (they are
  [`tula apply`](config.md)'s).
- A terminal is not proof of a person: a program that drives a pseudo-terminal can type
  the answer. What keeps an assistant from approving is that its agent key cannot, and
  that your secret key is not where it can read it
  ([what approval does not protect against](proposals.md#what-approval-does-not-protect-against)).
- An agent key cannot approve, and is refused before any request.
- A proposal is approved once and only before it expires (ten minutes). An expired one,
  one already approved, and one that changed since it was printed are each said as what
  they are, and nothing is changed.
- A proposal whose agent key was revoked is said as that (the read shows it as expired
  for that reason, before any question is asked), and nothing is changed.
- **A ban that was only half carried out is said as that, and exits 1**: when the account
  was banned and ending its sessions failed, `tula approve` prints that the user is banned,
  that their sessions may still be live, and how to end them
  (`DELETE /v1/admin/users/<id>/sessions`, or the dashboard). It never reports this as
  carried out, and nothing is tried again.
- **A provider that is the last way to sign in is not switched off.** The server judges
  that when the proposal is approved; `tula approve` then prints that it was approved,
  that nothing was changed, that the provider is still on and that the proposal is spent,
  and exits 1.
- **A production environment that does not accept proposals approves none**
  (`agents.proposalsInProduction`, off by default): said as that, nothing changed, and
  the proposal is not spent, so it can still be approved before it expires if the setting
  is switched on.
- A proposal whose operation this version of `tula` does not know is not approved: update
  `tula`.
- Text from the server (the summary, the user's address and name) is printed with what a
  terminal would act on or hide taken out.
- **`--yes` in the hands of an assistant that has a shell and your secret key approves
  without you.** An approval shows that a credential the assistant's tools do not hold was
  used, not that a person looked: an assistant that can run commands where the secret key
  is in the environment (or in `.env.local`) can run this command itself. The approval is
  worth what the separation of the two keys is worth:
  [what approval does not protect against](proposals.md#what-approval-does-not-protect-against).

Exit codes: 0 approved and carried out; 1 anything else (declined, expired, the agent key
revoked, already approved, refused for a production environment, approved but not carried
out or only half carried out, an error).

## `tula diff` and `tula apply`

See [config.md](config.md). Exit codes of `diff`: 0 no changes, 2 changes pending, 1 an error.

Options of `tula apply` for [webhook endpoints in the file](config.md#webhook-endpoints):

| Option | |
| --- | --- |
| `--allow-webhook-removal` | with `--yes`: apply a plan that removes a webhook endpoint (`--prune`), with its pending deliveries and its delivery log |
| `--secrets-file <path>` | write the signing secret of each endpoint the run creates to a new file, mode 0600. The file is created exclusively: whatever is at the path (a file, a symbolic link, a named pipe, a directory) is refused and left as it is |
| `--show-secrets` | print those secrets on standard output. As with `tula dev --show-keys`, nothing is printed unless asked |
| `--discard-secrets` | keep none; rotate later to get one |

A run that creates an endpoint and is given none of the last three is refused before any
write: the server shows a signing secret once.

[Native apps in the file](config.md#native-apps) need no option of their own: registering
one, or widening one, is a weaker plan (`--allow-weaker` with `--yes`), and `--prune`
removes the ones the file leaves out.

[Hooks in the file](config.md#hooks) use the same three options for the signing secret of a
hook the run creates, and the same file: a hook's entry in it begins with `"hook": "<point>"`.
A hook's secret cannot be rotated, so `--discard-secrets` means removing the hook and adding
it again to get one. A plan that lets a hook's failures through, switches a hook off or
removes one that is on is a weakening: with `--yes` it needs `--allow-weaker`. There is no
option of its own for removing a hook.
