# Tula Auth

Open-source, self-hostable authentication and user management: Clerk-level developer experience
and prebuilt UI, first-class native mobile, and data you own.

> **Status: Phase 0 in progress.** The API skeleton, environments, API keys and access-token
> signing keys work end to end. Sign-up, sign-in and sessions are next. Not ready for production.

## What's here

A Bun + TypeScript monorepo. The auth API is [Hono](https://hono.dev) over PostgreSQL
([Drizzle](https://orm.drizzle.team)), validated with Zod v4. Its OpenAPI document is committed
as the public contract that every SDK, the dashboard, the CLI and the MCP server are built from.

| Path | What |
| --- | --- |
| [`apps/api`](apps/api) | `@tula/api`, the auth server |
| [`packages/contract`](packages/contract) | `@tula/contract`: schemas, flow protocol, error codes, token claims, password policy, [`openapi.json`](packages/contract/openapi.json) |
| [`packages/db`](packages/db) | `@tula/db`: Drizzle schema, migrations, row-level security, tenant helpers |
| [`docs/`](docs) | [Business plan](docs/business-plan.md), [architecture decisions](docs/adr), [designs](docs/design/Design.pdf) |

## Quickstart (local)

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

Browsers and apps call `/v1/client/*` with a publishable key (`tula_pk_…`) in the
`x-tula-publishable-key` header. Servers call `/v1/admin/*` with a secret key (`tula_sk_…`) as a
Bearer token. Every error has the same shape (`{ status, code, detail, params?, errors? }`) with a
stable, machine-readable `code`.

## Roadmap

Phase 0, the core of V1 (see the [business plan](docs/business-plan.md)):

- [x] Monorepo, agent harness and quality gate
- [x] Public contract (`@tula/contract`)
- [x] Postgres schema with fail-closed tenant isolation
- [x] API skeleton: config, errors, key and session middleware, OpenAPI
- [x] Environments and API keys
- [x] Ed25519 signing keys, rotation and JWKS
- [ ] Passwords (argon2id, policy, breach checks)
- [ ] Server-driven sign-up / sign-in flows
- [ ] Email verification
- [ ] Sessions with rotating refresh tokens and reuse detection
- [ ] User admin, rate limiting and lockout, audit log
- [ ] Conformance suite and self-host packaging

Phases 1 to 3 add social sign-in, passkeys, MFA, the web and native SDKs, the dashboard,
organizations and importers.

## Contributing

Read [`AGENTS.md`](AGENTS.md) first. It is the canonical standard for every contributor, human or
AI. In short:

- Branch from `develop` (`feat/…`, `fix/…`, `docs/…`) and open a PR into `develop`. `main` is
  release-only.
- `bun run verify` must pass (Biome, typecheck, tests with coverage, schema and contract drift
  checks). CI runs the same gate.
- Conventional commits, enforced by a hook.
