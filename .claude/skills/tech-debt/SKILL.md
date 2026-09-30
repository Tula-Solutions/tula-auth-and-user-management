---
name: tech-debt
description: Scan or fix technical debt in a scoped area of the Tula monorepo (documentation, dead code, complexity, duplication, performance, security hygiene). Use for "scan <area>" audits or "fix <findings>" cleanups; ordinary features and reviews don't need it.
argument-hint: scan|fix <area>
---

# Technical debt (adapted from payhub-portal)

`AGENTS.md` is the authority for standards and protected files. Stay scoped to the requested area.

## Principles

- **Clean Code:** meaningful domain names, cohesive functions, visible inputs/outputs/side effects.
- **DRY:** consolidate repeated rules that must change together. Similar-looking code that
  represents different concepts stays separate.
- **KISS:** the simplest design that meets today's requirements. No speculative ports, options or
  layers. Hexagonal ports exist only where there are two or more real adapters (ADR 0001).
- Don't enforce arbitrary length limits, and don't turn style preferences into findings.

## Mode

- `scan <area>`: report only, no code edits. For an ongoing audit, save coverage to
  `docs/technical-debt/<area>.md`.
- `fix <findings|area>`: implement selected findings. Every behaviour-affecting fix gets a
  regression test, and the work ends with `/review-loop`.

## Scan

1. Record branch, HEAD and relevant local changes. Establish a baseline with `bun run verify`.
2. Inventory the area with `rg --files`. Follow imports, consumers and tests with `rg`.
3. Check: JSDoc accuracy and presence; dead code (trace lazy route imports and container wiring
   before calling anything unused); complexity and duplication; performance (N+1 queries, missing
   indexes, repeated hashing); security hygiene against `.claude/rules/security.md`; test gaps on
   failure paths.
4. Deduplicate by root cause. Separate confirmed issues from hypotheses.

## Report

```
Scope: target, branch/HEAD, local changes, exclusions.
Baseline: commands + outcomes.
Coverage: files reviewed in depth / context-only / remaining.
Findings: ID, category, priority, confidence, file:line, evidence, impact, proposed fix, verification.
Next pass: highest-priority unresolved items and unreviewed areas.
```
