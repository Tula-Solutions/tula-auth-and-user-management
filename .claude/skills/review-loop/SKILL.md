---
name: review-loop
description: Tula's Definition-of-Done feedback loop. Runs /verify, then the ollie-reviewer subagent (otterbot-review on Sonnet 5.5, local mode), fixes verified findings with failing-first regression tests, and repeats until the gate is green and Ollie reports no blocking findings. Use when finishing any feature or fix, or when asked to "review and fix", "run the loop", or "make sure it's done".
---

# Review loop

Run the rounds below in order. Keep a findings ledger in the conversation
(`id | severity | where | status | resolution`) and update it every round.

## Preconditions

- `~/.claude/skills/otterbot-review` exists. If it doesn't, stop and tell the user to install it:
  `git clone https://github.com/otternaut/otterbot ~/tools/otterbot && ~/tools/otterbot/scripts/install`.
- You know the scope: uncommitted changes, otherwise the branch against `develop`.

## Each round (max 4)

1. **Gate.** Run the `verify` skill until `bun run verify` is green. Don't spend a review on red
   code.
2. **Review.** Spawn the `ollie-reviewer` subagent (it is pinned to `claude-sonnet-5-5`). Prompt:
   (Project agents register at session start. If `ollie-reviewer` is "not found" in a session
   where `.claude/agents/ollie-reviewer.md` was just created, spawn `general-purpose` with
   `model: sonnet`, tell it to read that file and follow it, and to invoke the `otterbot-review`
   skill.)
   - Round 1: "Round 1. Review the local changes in this repo (uncommitted, else branch vs
     develop). Return the structured output from your instructions."
   - Round N>1: "Round N re-review. Previous findings: <paste ledger rows>. Check each, then
     review the interdiff since round N-1."
3. **Triage** every finding against the code yourself. Ollie verifies before reporting, but you own
   the change:
   - 🔴 / 🟠: must fix.
   - 🟡: fix now, or defer only with a written reason plus an issue (ask the user before
     creating one).
   - 🔵: optional; fix if it's cheap and clearly better.
   - If you believe a finding is wrong, mark it `dismissed` with concrete evidence (file:line,
     test name). Never dismiss by assertion.
4. **Fix each accepted finding test-first:**
   1. Write a regression test that reproduces the finding and **watch it fail**.
   2. Make the smallest fix that makes it pass.
   3. Run the affected package's tests.
5. **Exit check:** `bun run verify` is green **and** Ollie's verdict is `no blocking findings` with
   no unresolved 🔴/🟠 and every 🟡 fixed or deferred → exit the loop. Otherwise start the next
   round.

After round 4 without converging, stop and report the outstanding findings with your analysis.
Don't keep looping.

## Final report

```
Review loop: <converged in N rounds | stopped after 4 rounds>
Final gate: bun run verify ✅
Final Ollie verdict: <verdict> (Sonnet 5.5, local mode)
Fixed:     F1 🟠 session/service.ts:88 — reuse inside grace window revoked family → test 'reuse within grace…'
Dismissed: F4 🟡 … — evidence …
Deferred:  F6 🟡 … — issue #…
Tests added: <n> (list names)
```

Copy this report into the PR's "🦦 Ollie review" section.

## Posting to GitHub (only on request)

If the user asks for a PR review, spawn `ollie-reviewer` with the PR URL. Include
"user approved posting" **only** if they explicitly said to post. Otherwise it runs with
`--shadow`.
