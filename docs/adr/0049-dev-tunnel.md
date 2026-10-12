# ADR 0049: `tula dev --tunnel`

- **Status:** accepted
- **Date:** 2026-10-12
- **Ticket:** TULA-21 (phase 2, step 2.12)

## Context

A phone cannot reach `localhost`, and a passkey, an app link and a native sign-in need an
https address with a certificate the phone trusts. `tula dev` starts a stack that answers on
this machine only. A developer who wants to try the native paths on a device needs the same
stack under a public https address, and needs that address to be **the same on every run**:
it is the passkey relying party, the associated domain compiled into the app, an allowed
origin and a redirect URL, and every one of those is typed somewhere.

Three things in the server stand against doing that carelessly, and none of them is changed
here:

- `env.ts` refuses to start with `OAUTH_MOCK_PROVIDER=true` or `SMS_PROVIDER=dev` unless
  `PUBLIC_URL` is a loopback address. The mock provider signs anyone in as any address, and
  the inbox hands every texted code to whoever asks.
- The development-only routes answer a request only when its `Host` header names this
  machine (`isLoopbackHost`).
- `PUBLIC_URL` is the issuer of every access token and the address of the server's requests
  to itself: a deployment has one.

## Decision

### The service: Tailscale Funnel

`tula dev --tunnel` opens the tunnel with Tailscale Funnel: the machine's own name under its
tailnet's `ts.net` domain, served over https by the Tailscale client that already runs on the
machine.

What was read, on the vendors' own pages, on 2026-10-10 and 2026-10-12:

| Service | Read | Where |
| --- | --- | --- |
| **ngrok** | The Free plan has one "dev domain", "specific to your account", "a stable, auto-assigned hostname" whose URL "cannot be changed"; a free account cannot choose or reserve another. Monthly: 20,000 HTTP requests, 1 GB of data out. "Interstitial page on HTTP/S endpoints" for "all HTML browser traffic on the free tier", not for "users serving APIs", passed by a request header or a non-browser user agent. The agent is a process that runs for as long as the tunnel is open; its local API (`http://127.0.0.1:4040/api`) lists the endpoints with their URL. `--host-header` is deprecated in favour of a traffic policy. An account and an authtoken are needed. | `ngrok.com/pricing`, `ngrok.com/docs/pricing-limits/free-plan-limits/`, `ngrok.com/docs/universal-gateway/domains/`, `ngrok.com/docs/agent/cli/`, `ngrok.com/docs/agent/api/` |
| **Cloudflare Tunnel** | A quick tunnel needs no account, and "the hostname changes each time you create a Quick Tunnel"; 200 requests in flight, no Server-Sent Events, "no uptime guarantee". "For stable hostnames and production traffic, create a Cloudflare Tunnel." | `developers.cloudflare.com/cloudflare-one/…/do-more-with-tunnels/trycloudflare/` |
| **Tailscale Funnel** | "Available for all plans"; the Personal plan is "$0", "free forever". The address is the machine's name in the tailnet's `ts.net` domain. Ports 443, 8443 and 10000 only. Needs MagicDNS, HTTPS certificates switched on for the tailnet and a `funnel` node attribute (the command offers to add it). Certificates come from Let's Encrypt, and machine names are "published in the public ledger" (Certificate Transparency). "Non-configurable bandwidth limits", unstated. Marked beta. `tailscale funnel --bg` keeps serving after the command returns; `tailscale funnel status --json` prints the configuration; `--set-path` serves one path from another target. | `tailscale.com/kb/1223/funnel`, `tailscale.com/kb/1311/tailscale-funnel`, `tailscale.com/kb/1153/enabling-https`, `tailscale.com/pricing`, `tailscale.com/download` |

Read in Tailscale's source (`github.com/tailscale/tailscale`, `main`, the same days), because
the documentation does not say:

- `ipn/ipnlocal/serve.go`: a request passed to a local server keeps the `Host` it arrived
  with (`r.Out.Host = r.In.Host`); `X-Forwarded-Host`, `X-Forwarded-Proto`,
  `X-Forwarded-For` and `Tailscale-Funnel-Request` are added. A handler is chosen by exact
  path first, and a path mounted exactly is passed to its target's own path.
- `cmd/tailscale/cli/serve_v2.go`: `off` without `--set-path` removes every handler on the
  port, and asks first unless `--yes`.

What decided it, in the order the criteria were given:

1. **A name that stays the same, without payment.** ngrok and Tailscale both have one.
   Cloudflare does not without a named tunnel, which needs a domain on Cloudflare (that last
   clause was **not confirmed** on the page read; that a quick tunnel's name changes was).
2. **A certificate the public trusts.** Both.
3. **A command line that takes an argument vector and reports its address in a form a
   program reads.** Both, differently, and this is where they part: an ngrok tunnel is a
   process that has to be kept running and stopped, and `tula dev` is a command that starts
   a stack and returns. Tailscale's client is already a service; `--bg` hands it a
   configuration and returns, `status --json` reads it back, `off` removes it. Nothing new
   has to run, be supervised or be found again after a crash.
4. **How little a developer sets up.** ngrok is less: an account and one command. Tailscale
   needs the client installed and signed in, MagicDNS and HTTPS certificates switched on,
   and Funnel allowed. This criterion alone would have chosen ngrok.

Two more facts weighed against ngrok's free plan for this use: a page in front of every
HTML answer (the provider callback and the emailed link's page are HTML navigations on a
phone), and a monthly cap of 20,000 requests. And one for
Tailscale: `--set-path` lets the tunnel answer the two paths Apple and Android fetch at a
domain's root (below), which the other two cannot do without a proxy of the developer's.

**Not confirmed:** that Funnel is in the free plan's feature list (the pricing table's
cells were not readable; the Funnel page says "all plans"); what the bandwidth limits are;
what `tailscale funnel --bg` does on a tailnet where Funnel is not allowed yet (the code
that asks was not in what was read; a command that waits is ended by its timeout);
ngrok's JSON log format.

**Costs taken with the choice.** The machine's name and the tailnet's name become public in
Certificate Transparency when HTTPS is switched on, and are in every address given to a
phone. The address changes if the machine or the tailnet is renamed. Funnel is in beta.

The service is one value of `TunnelService` (`packages/cli/src/tunnel.ts`): the argument
vectors, how the status is read, and the fixed words for a missing tool and for no address.
One is built. A second is a second value, and a decision.

### Credentials

The Tailscale client's sign-in and the tailnet's settings are the developer's own. `tula
dev` passes no credential, reads none, names no file that holds one, and sets no variable
for the tool. What the tool prints is captured, never passed through; the lines of a refusal
that are shown go through `printable()` and the output's redaction.

**No command makes a tunnel rewrite the `Host` header**, and the target is always
`http://127.0.0.1:<port>`, never a name. A test holds the argument vectors to that.

### What `--tunnel` writes, and what it only says

It writes:

- **Three variables in its block of `.env.local`**: `TULA_PUBLIC_URL` (the address),
  `TULA_ISSUER` (the issuer of the stack's tokens under it, which `@tula/nextjs` reads when
  the issuer is not where it reaches the API) and `TULA_TUNNEL_TARGET` (where the tunnel
  sends requests: the tunnel's record, written before it is opened, and what a later run
  compares before it closes anything; "The order of a run" below). `TULA_API_URL`
  stays the local address: `tula` and a server on this machine reach the API there, and the
  secret key never crosses the tunnel on their account. No line outside the block changes.
- **`TULA_PUBLIC_URL` in the environment of the one `docker compose up` that starts the
  API.** The scaffold's Compose file reads `PUBLIC_URL` from it and falls back to loopback.
  Compose puts the process's environment above the project's `.env`, so no file of the
  project is edited. A `docker compose up` of the developer's own starts the API on
  loopback again.
- **The tunnel's routes**: `/` to the API, and `/.well-known/apple-app-site-association`
  and `/.well-known/assetlinks.json` to the development environment's own files (the API
  serves them under the environment's path only, ADR 0040).

It only says, with the text to paste: `passkeys.rpId`, `urls.allowedOrigins`,
`urls.allowedRedirectUrls` and `nativeApps`. `tula dev` has never written a setting, the
settings document is replaced whole under a revision by `tula apply`, and a relying party
changed under a developer's passkeys is not a thing to do unasked. The exact lines are
printed, for `tula.config.ts` and `tula apply`.

A Compose file from before this change has a fixed `PUBLIC_URL`. `--tunnel` asks Compose
what it would start the API with (`docker compose config --format json`, with a probe
value), sees that the address was not taken, and stops with the line to write. It never
edits the file. The resolved file holds the stack's secrets: it is parsed and never printed.

### The development-only routes

Under `--tunnel` the API runs with a `PUBLIC_URL` that is not loopback, so it **cannot** run
with the mock provider or the development inbox: `env.ts` refuses the boot, and that rule
is not loosened. `tula dev --tunnel` says so before it starts anything, and when the
resolved Compose file has either switched on it stops there, with nothing started, opened
or written. It does not switch a line of the developer's off, and it does not override the
variable for the run: a stack that silently differs from its `.env` is the surprise this
avoids. `tula dev` without the flag keeps both.

That covers the tunnel `tula dev` opens. A tunnel a developer opens by hand in front of a
stack that still calls itself `localhost` is not covered by it, and for that the routes
defend themselves: **each of the mock provider's routes and the inbox answers a loopback
`Host` only**. The ID-token route and the inbox already did. The consent page did not
(TULA-68): it now does, in the router's own middleware, with a bare 403. A tunnel that
keeps the `Host` it was asked for (Tailscale's source says it does; no other tool's
behaviour was read) is refused; a forwarding header is never read.

A tunnel that rewrites `Host` to `localhost` would pass that check. Nothing here can stop a
developer from running one; `tula dev` never does.

### Lifetime

`tula dev` starts a stack and returns, and the tunnel has the stack's lifetime, not the
command's. It is closed:

- by `tula dev down`, before the stack stops;
- by `tula dev` without `--tunnel`, which also starts the API on loopback again;
- by the run that opened it, if anything after that fails or the run is interrupted: an
  address is not left open in front of a stack that was not set up for it.

**A port that serves anything of somebody else's is never touched.** Before opening or
closing, the configuration is read and judged: `ours` only when every path on port 443 is
one of this project's routes, going where this project sends it. Otherwise opening is
refused and closing is skipped, with a warning. It is judged twice on the way to opening:
once before anything is started (no migration, no seed, no container for a port that is
somebody else's; the environment is not known yet, so the port is somebody else's only when
it fits the routes of no environment the block or the port itself names), and again when
the tunnel is opened, because what is served can change in between. A tunnel that cannot be
closed is a warning with the command that closes it, never a failed stop.

Every command goes through `Host`: an argument vector, a timeout, no shell. A tool that
does not come back is ended by its timeout and reported as "no address in time".

### The order of a run, and what an interrupted one leaves

After the migrations and the seed, in this order:

1. **The API's container is stopped** (`docker compose stop api`), when a route is about to
   be opened. A container from an earlier run was started without the tunnel, perhaps with
   the mock provider or the development inbox on; the routes defend themselves by `Host`,
   and it is still not what a new public address should first reach.
2. **The tunnel's record is written to the block**: `TULA_TUNNEL_TARGET` and
   `TULA_ENVIRONMENT_ID`, which together are the routes. **The record exists before the
   address does.** `TULA_PUBLIC_URL` and `TULA_ISSUER` are *not* part of it: the name is
   the tool's to report and is known only once the tunnel is open, and writing a guessed
   name, or a placeholder, into a variable applications read would be worse than leaving
   it out. What closes a tunnel is where it sends requests, which is known beforehand; so
   that is what the record is, and a block with the target and no address means "a tunnel
   was being opened, or could not be closed".
3. The tunnel is opened. 4. The API is started under the address. 5. The keys are minted
   or reused and the whole block is written, the address now in it.

A tunnel that was already open with exactly this project's routes (an earlier run's) is
used as it is: nothing is stopped, and it is recorded if the block did not record it.

**The record goes only when the tunnel has.** A close that ended in `closed` or `gone`
takes the tunnel's variables out of the block (a block that held nothing else goes with
them, and a file the run created is removed). A close that failed, or found somebody
else's on the port, leaves the record where it is, in the run that opened the tunnel, in a
plain `tula dev` and in `tula dev down` (with `--volumes` too: the keys go, the record
stays). `tula dev --tunnel` with a record for another port or environment that it cannot
close opens nothing.

**Signals.** From before the first of those steps until the stack is reported, the run
listens for `SIGINT` (Ctrl-C), `SIGTERM` and `SIGHUP` (a closed terminal window) through
`Host.onInterrupt` (never `process.on` in a command). On one it stops at its next step (the
waits for the API and for the tunnel's address look between tries, a child process is
stopped by the host, and the run looks once more after its last commands, just before it
reports the stack), closes the tunnel it opened, takes
the record out if that worked, and ends as a failed run. The commands of that close are
run **shielded** (`RunOptions.shielded`: in a process group of their own and not stopped
by a signal), so a second Ctrl-C says that the tunnel is being closed and does not cut it
short; each still has its timeout.

What is guaranteed is exactly this: **a record before an address, and a close on
`SIGINT`, `SIGTERM` and `SIGHUP`.** What is not: `SIGKILL` (it cannot be caught),
`SIGQUIT` (it is not listened for), a crash of the CLI or of Bun, a power loss, or a tool
that does not answer the close. Those leave the tunnel open, and the record in the block:
`tula dev down`, or the next `tula dev`, closes it by that. A signal that arrives after the
run's last look, while the stack is being reported, ends nothing: the tunnel is open and
recorded, as a finished run leaves it. A tunnel the run found open and used closes on none
of them: it was not this run's to close, and it is recorded.

Accepted edges, said here because they are not fixed: the record's routes depend on the
environment's id, so a tunnel left open in front of a database that was then wiped reads as
somebody else's and is left alone, with the command that closes it by hand; and a plain
`tula dev` that cannot close a tunnel still starts the API on loopback behind it (the
development-only routes do not answer the tunnel's `Host`, and the warning says the tunnel
is open).

### What reaches the internet

Everything the API serves: the client routes, the admin routes behind the secret key, the
instance routes behind the admin token, the dashboard's sign-in, the API reference. The
stack is still `ENVIRONMENT=local`, with what that tier allows. The secrets are the ones
`create-tula` generated. The documentation says this where the flag is described.

## Consequences

- A scaffolded project's Compose file gains one variable. An older project is told the line.
- The mock provider's consent page refuses a request without a loopback `Host`. A browser
  and a tool on the machine send one; a test that hands the app a request directly has to
  say so (`~/testing/local-host`).
- `tula dev` and `tula dev down` run `tailscale` only when the block says a tunnel was
  opened, or `--tunnel` asks for one.

## What was not verified

`docs/plans/phase-2-unverified.md`, "Step 2.12, `tula dev --tunnel`". In short: no tunnel
was opened. The command was run against a fake host only.

## Not decided here

- A second tunnel service.
- Writing the settings (`passkeys.rpId`, the allowed origins) from the command.
- A check, after opening, that the address answers from outside.
- `TRUST_PROXY` under a tunnel: every request through it arrives from one address, and
  shares one per-address rate limit.
