# Tula Auth — Claude Code notes

@../AGENTS.md

Everything above is the canonical standard. This file only adds Claude Code specifics.

## The feedback loop in Claude Code

- **Hooks run automatically** (`.claude/settings.json`):
  - `protect-files.sh` blocks edits to generated or locked files. If it blocks you, use the
    generator named in the message; don't work around it.
  - `format-file.sh` runs Biome on every file you edit.
  - `stop-gate.sh` runs `bun run verify:changed` when you try to finish. If it exits with errors,
    **fix them and keep going**. Don't summarize and stop. After 5 failed attempts it lets you stop,
    and you must then report the remaining failures honestly.
- **`/review-loop`** is mandatory before calling a feature or fix done. It runs `/verify`, then the
  `ollie-reviewer` subagent (otterbot-review on **Sonnet 5.5**, local mode, no GitHub writes), then
  fixes plus regression tests, and repeats until green with no blocking findings.
- Posting a review to a GitHub PR is outward-facing: only when the user asks, and use `--shadow`
  first unless they explicitly said to post.

## Skills

| Skill | Use it when |
| --- | --- |
| `/verify` | Run the full quality gate and fix what fails. |
| `/review-loop` | Finishing any feature or fix (Definition of Done). |
| `/new-module <name>` | Adding an API module under `apps/api/src/modules/`. |
| `/contract-change` | Changing anything in `packages/contract` or any route/response shape. |
| `/tech-debt scan\|fix <area>` | Scoped cleanup or audit. |
| `otterbot-review` (global) | Ad-hoc review of a diff or PR. Prefer `/review-loop` for the in-repo loop. |

## Rules

Path-scoped rules in `.claude/rules/` load automatically when you touch matching files. Seven
are general (`api.md`, `database.md`, `contract.md`, `security.md`, `testing.md`, `frontend.md`,
`sdk.md`); the rest hold one area each (webhooks, the Swift client, the dashboard, …) and are
listed in `AGENTS.md`, "Area rules". A new rule goes in its area's file, not in `AGENTS.md`,
which `.claude/hooks/agent-rules.test.ts` holds to 70,000 bytes. When you brief a subagent,
name the area files it needs: it loads them only for the files it touches.

## Personal settings

`.claude/settings.local.json` is gitignored. Use it for machine-specific permissions or env,
e.g. `{ "permissions": { "allow": ["Bash(docker compose down:*)"] } }`.
