# ADR 0003 — Biome for lint and format

- Status: accepted
- Date: 2026-09-29

## Context

payhub-api uses ESLint + Prettier; payhub-portal (newer) uses Biome. The monorepo needs one tool
for server, dashboard and SDK code.

## Decision

Biome 2.x at the root, configured to payhub-api's style: single quotes, semicolons only where
needed, trailing commas `es5`, width 100, 2 spaces, LF. `noExplicitAny`, `useBlockStatements`
(payhub's `curly`), `noConsole` (pino only) and unused-variable rules are errors.

## Consequences

One fast command (`bun run check`) for lint + format + import ordering across the repo.
