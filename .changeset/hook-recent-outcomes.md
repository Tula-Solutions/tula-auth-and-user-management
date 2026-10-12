---
'@tula/contract': minor
'@tula/admin': minor
---

A hook's read answer says what its recent calls came to
([ADR 0035](../docs/adr/0035-hooks.md#2026-10-12-recent-outcomes-tula-67),
[docs/hooks.md](../docs/hooks.md)). The server counts every call of a hook, by the hour,
as `allowed`, `denied`, `failed` or `timed_out`, and `GET /v1/admin/hooks` (and every other
answer that carries a hook) has `recentOutcomes`: the four counts of the last 24 hours,
where the window starts, when the hook was last called and what that call came to. Counts
only: no call is kept by itself, and nothing of a question or of an answer but which of
the four it was. `lastFailedAt` and `lastFailureReason` are unchanged.

**`@tula/contract`**: `HOOK_OUTCOMES`, `HookOutcome`, `HOOK_OUTCOME_WINDOW_HOURS`,
`hookFailureOutcome(reason)`, `hookIsFailing(lastOutcome)` (the one rule for "failing
now": the most recent call failed or timed out), `HookRecentOutcomesSchema`, and the
required `recentOutcomes` of `HookSchema`.

**`@tula/admin`**: the generated type of a hook has `recentOutcomes`. A server from before
this change does not send it.

The dashboard's Hooks screen shows the counts and says "failing now" from the most recent
call. `@tula/cli` and `@tula/mcp` are unchanged: neither reads the field.
