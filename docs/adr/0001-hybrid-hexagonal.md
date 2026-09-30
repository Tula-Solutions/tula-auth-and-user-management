# ADR 0001 — Hybrid hexagonal server architecture

- Status: accepted
- Date: 2026-09-29

## Context

The business plan (§5.2, §5.6) requires one codebase to run as a multi-tenant cloud, a self-hosted
single tenant, and embedded inside a customer's Hono app, with pluggable session stores (§5.3) and
swappable email/SMS providers. SignaPay's payhub-api uses a flat functional module pattern
(`router.ts` / `service.ts` / `schema.ts`) where services take a Drizzle `db` directly.

## Decision

Keep payhub's module shape, naming and functional style, but services receive a `deps` object of
**ports** (interfaces in `apps/api/src/ports/`) instead of `db`. Adapters live in
`apps/api/src/adapters/` and are wired once in `container.ts`. A port is introduced only when there
are two or more real implementations on the V1 roadmap (e.g. session store, mailer, breach checker,
key store, clock). No DI framework, no classes for services.

## Consequences

- Unit tests run against in-memory adapters with a fixed clock: fast and deterministic.
- `createApp(deps)` can be mounted by a host app (embedded mode).
- Slightly more indirection than payhub; mitigated by only porting what genuinely varies.
