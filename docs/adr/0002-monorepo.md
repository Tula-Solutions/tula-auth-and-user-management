# ADR 0002 — Bun workspaces monorepo with Turborepo

- Status: accepted
- Date: 2026-09-29

## Context

payhub splits services and shared packages across repos and consumes shared code as git
dependencies with committed `dist/`. Tula ships a server plus a shared contract and ~8 SDK/tool
packages that must change together (§5.7: "the contract is the product").

## Decision

One repo with Bun workspaces: `apps/` (deployables), `packages/` (libraries), `native/` (Swift and
Kotlin, Phase 2), `conformance/` (cross-SDK scenarios). Turborepo provides task caching and
`--affected` runs. Workspace packages are consumed from source; publishable packages are built with
bunup at release time only — no committed `dist/`.

## Consequences

Contract changes and their consumers land in one PR. CI runs a single `bun run verify`.
