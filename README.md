# Tula Auth

Open-source, self-hostable authentication and user management: Clerk-level developer experience
and prebuilt UI, first-class native mobile, and data you own.

> **Status: Phase 1 is built; nothing is published.** There is no package on npm and no image
> in a registry: everything runs from a checkout of this repository. Sign-in with Google,
> GitHub and Apple has only ever been run against a built-in mock provider, and passkeys only
> against a virtual authenticator ([everything that was not verified against the real
> thing](docs/plans/phase-1-unverified.md)). Not ready for production.

## What works

- **Sign-in methods**, each switched on per environment: [password](docs/methods/password.md)
  (sign-up, reset, policy), [emailed code](docs/methods/email-code.md) and
  [emailed link](docs/methods/email-link.md), [Google, GitHub and Apple](docs/methods/oauth.md),
  [passkeys](docs/methods/passkeys.md), and
  [two-step verification](docs/methods/two-step-verification.md) (authenticator app, backup
  codes, step-up).
- **[Sessions](docs/methods/sessions.md)**: rotating refresh tokens with reuse detection,
  session profiles, cookie-only stateful sessions, device list, a concurrent-session limit.
- **SDKs for the web**: a headless client, React components, and a Next.js App Router SDK.
- **Operations**: per-environment settings, settings as code (`tula diff`, `tula apply`), a
  dashboard, `tula doctor`, an audit log, a read-only MCP server, and `create-tula` to scaffold
  a project.
- **Self-hosting**: one image, PostgreSQL, and Redis for more than one instance
  ([docs/self-host.md](docs/self-host.md)).
- **A conformance suite** that the server passes in process, as two packaged instances, behind
  one address, and through the client SDK.

Not built yet: native SDKs and Expo, webhooks, SMS, more providers, organizations and roles
(see [Roadmap](#roadmap)).

## Try it

[docs/quickstart.md](docs/quickstart.md) goes from this checkout to a scaffolded app with a
signed-in user: build the image, pack the packages, `create-tula`, `tula dev`. To work on Tula
itself, see [Development](#development) below.

## What's here

A Bun + TypeScript monorepo. The auth API is [Hono](https://hono.dev) over PostgreSQL
([Drizzle](https://orm.drizzle.team)), validated with Zod v4. Its OpenAPI document is committed
as the public contract that every SDK, the dashboard, the CLI and the MCP server are built from.

| Path | What |
| --- | --- |
| [`apps/api`](apps/api) | `@tula/api`, the auth server |
| [`apps/dashboard`](apps/dashboard) | The operator's [dashboard](docs/dashboard.md), served by the API at `/dashboard` |
| [`packages/contract`](packages/contract) | `@tula/contract`: schemas, flow protocol, error codes, token claims, password policy, [`openapi.json`](packages/contract/openapi.json) |
| [`packages/core`](packages/core) | `@tula/core`: the [headless TypeScript client](packages/core/README.md) (flows, session, token refresh) |
| [`packages/react`](packages/react) | `@tula/react`: [provider, hooks and prebuilt components](packages/react/README.md) |
| [`packages/nextjs`](packages/nextjs) | `@tula/nextjs`: the [Next.js App Router SDK](packages/nextjs/README.md) |
| [`packages/admin`](packages/admin), [`packages/config`](packages/config), [`packages/cli`](packages/cli) | The typed admin client, `tula.config.ts`, and the [`tula` CLI](docs/cli.md) |
| [`packages/mcp`](packages/mcp) | `@tula/mcp`: the read-only [MCP server](docs/mcp.md) |
| [`packages/create-tula`](packages/create-tula) | `create-tula`: scaffolds a project |
| [`packages/db`](packages/db) | `@tula/db`: Drizzle schema, migrations, row-level security, tenant helpers |
| [`packages/conformance`](packages/conformance) | `@tula/conformance`: runs the conformance scenarios, in process or against a live server |
| [`conformance/`](conformance) | Language-neutral [scenarios](conformance/README.md) every server and SDK must pass |
| [`examples/`](examples) | A [Next.js app](examples/nextjs-app-router/README.md) and a [Vite + React app](examples/react-vite/README.md) built from the SDKs, an example `tula.config.ts`, and a browser test bench for `@tula/core` |
| [`docs/`](docs/README.md) | The [documentation index](docs/README.md): quickstart, one page per method, the generated SDK reference, self-hosting, architecture decisions |

## Development

Requires [Bun](https://bun.sh) 1.4+ and Docker.

```bash
bun install
cp .env.example .env
# Set TULA_MASTER_KEY in .env to the output of:
openssl rand -hex 32

docker compose up -d        # Postgres, Redis, Mailpit (http://localhost:8025)
bun run db:migrate          # create the schema
bun run seed                # local workspace + project; prints the environment ids
bun run api-key:create --environment <development-environment-id>
                            # prints your first secret key (shown once)
bun run dev                 # API on http://localhost:3003, reference at /v1/docs
```

Try it:

```bash
curl http://localhost:3003/v1/ready
curl http://localhost:3003/v1/admin/api-keys -H "Authorization: Bearer <secret key>"
curl http://localhost:3003/v1/environments/<environment-id>/.well-known/jwks.json
```

Keep `TULA_MASTER_KEY` safe: it encrypts the signing keys at rest, and losing or changing it
makes them unreadable.

## API at a glance

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /v1/status`, `GET /v1/ready` | none | Liveness and readiness |
| `GET /v1/openapi.json`, `GET /v1/docs` | none | The contract and its reference UI |
| `GET /v1/environments/:id/.well-known/jwks.json` | none | Public keys that verify access tokens |
| `GET /v1/admin/environments` | secret key | The project's environments |
| `GET, POST /v1/admin/api-keys`, `DELETE /v1/admin/api-keys/:id` | secret key | Manage API keys |
| `GET /v1/admin/signing-keys`, `POST /v1/admin/signing-keys/rotate` | secret key | Signing-key lifecycle |
| `GET, POST /v1/admin/users`, `GET, DELETE /v1/admin/users/:id`, `POST …/ban`, `POST …/unban`, `PUT …/password` | secret key | Manage users |
| `GET, PUT /v1/admin/settings` | secret key | The environment's settings: app name, password policy, sign-in methods, allowed origins (`If-Match` on the revision) |
| `GET /v1/admin/audit-logs` | secret key | The record of auth events and admin actions |
| `GET /v1/client/config` | publishable key | What a sign-in screen needs: app name, sign-in methods, password policy |
| `GET /v1/client/password-policy` | publishable key | Password rules for the live checklist |
| `POST /v1/client/sign-ups`, `…/sign-ups/:id/verify-email`, `…/sign-ups/:id/resend-code` | publishable key | Sign up with email and password, verified by an emailed code |
| `POST /v1/client/sign-ins`, `…/sign-ins/:id/password`, `…/sign-ins/:id/verify-email`, `…/sign-ins/:id/resend-code` | publishable key | Sign in; each call returns the next step |
| `POST /v1/client/password-resets`, `…/password-resets/:id/password`, `…/password-resets/:id/resend-code` | publishable key | Replace a forgotten password (or set a first one) with an emailed code |
| `POST /v1/client/sessions/refresh`, `POST /v1/client/sessions/sign-out` | publishable key + refresh token | Rotate tokens; sign out |
| `GET /v1/client/sessions`, `DELETE /v1/client/sessions/:id`, `POST /v1/client/sessions/revoke-others` | publishable key + access token | The user's devices |
| `GET /v1/client/me`, `POST /v1/client/me/password` | publishable key + access token | The signed-in user; change my password |

Browsers and apps call `/v1/client/*` with a publishable key (`tula_pk_…`) in the
`x-tula-publishable-key` header. Servers call `/v1/admin/*` with a secret key (`tula_sk_…`) as a
Bearer token. Every error has the same shape (`{ status, code, detail, params?, errors? }`) with a
stable, machine-readable `code`.

Starting a sign-up, sign-in or password reset returns an `attemptSecret` once. Every later call
on that attempt (`…/:id/…`) sends it in the `x-tula-attempt` header; without it the attempt
answers `flow.not_found`, so an attempt id seen in a URL or a log is useless on its own.

## Roadmap

Phase 0, the core of V1 (see the [business plan](docs/business-plan.md)):

- [x] Monorepo, agent harness and quality gate
- [x] Public contract (`@tula/contract`)
- [x] Postgres schema with fail-closed tenant isolation
- [x] API skeleton: config, errors, key and session middleware, OpenAPI
- [x] Environments and API keys
- [x] Ed25519 signing keys, rotation and JWKS
- [x] Passwords (argon2id, policy, breach checks)
- [x] Server-driven sign-up / sign-in flows
- [x] Email verification (codes; magic links in Phase 1)
- [x] Forgotten-password reset by emailed code
- [x] Sessions with rotating refresh tokens and reuse detection
- [x] User admin, rate limiting and lockout, audit log
- [x] Conformance suite
- [x] Self-host packaging ([docs/self-host.md](docs/self-host.md))

Phase 1 ([plan and exit-criteria evidence](docs/plans/phase-1.md)):

- [x] Per-environment settings; Redis and several instances
- [x] `@tula/core`, `@tula/react`, `@tula/nextjs`
- [x] Emailed codes and same-browser links; sign-up without a password
- [x] Two-step verification: authenticator app, backup codes, step-up
- [x] Google, GitHub and Apple (tested against a mock provider only)
- [x] Passkeys (tested against a virtual authenticator only)
- [x] Session profiles, stateful sessions, the concurrent-session limit
- [x] Settings as code, the CLI, `create-tula`, the dashboard, the MCP server
- [ ] Published packages and image

Phase 2 adds native SDKs and Expo, webhooks, SMS codes and more providers; Phase 3
organizations, roles, invitations and importers.

## Contributing

Read [`AGENTS.md`](AGENTS.md) first. It is the canonical standard for every contributor, human or
AI. In short:

- Branch from `develop` (`feat/…`, `fix/…`, `docs/…`) and open a PR into `develop`. `main` is
  release-only.
- `bun run verify` must pass (Biome, typecheck, tests with coverage, schema, contract and
  documentation drift checks). CI runs the same gate, the browser tests (`bun run e2e`) and the
  packaged stack.
- Conventional commits, enforced by a hook.
