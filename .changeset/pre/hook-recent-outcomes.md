---
'@tula-tech/contract': minor
'@tula-tech/admin': minor
---

A hook's read answer says what its recent calls came to
([ADR 0035](../docs/adr/0035-hooks.md#2026-10-12-recent-outcomes-tula-67),
[docs/hooks.md](../docs/hooks.md)). The server counts every call of a hook, by the hour,
as `allowed`, `denied`, `failed` or `timed_out`, and `GET /v1/admin/hooks` (and every other
answer that carries a hook) has `recentOutcomes`: the four counts of the current hour and
the 23 before it, where the window starts, when the hook was last asked and what that call
came to. A count is written after the sign-in was answered and is not waited for, so it
may land a moment later, and a server killed hard loses the ones on their way.
`lastCallAt` is the time of the latest sign-in or sign-up that asked the hook, to the
millisecond, and is answered by the admin API only. Counts
only: no call is kept by itself, and nothing of a question or of an answer but which of
the four it was. `lastFailedAt` and `lastFailureReason` are unchanged.

**`@tula-tech/contract`**: `HOOK_OUTCOMES`, `HookOutcome`, `HOOK_OUTCOME_WINDOW_HOURS`,
`hookFailureOutcome(reason)`, `hookLastCallFailed(lastOutcome)` (whether the most recent
call failed or timed out; it does not say a hook is failing now, the call may be up to a
day old), `HookRecentOutcomesSchema`, and the
required `recentOutcomes` of `HookSchema`.

**`@tula-tech/admin`**: the generated type of a hook has `recentOutcomes`. A server from before
this change does not send it.

The dashboard's Hooks screen shows the counts and what the most recent call came to, with
when it was ("Last call failed", never "failing now"). `@tula-tech/cli` and `@tula-tech/mcp` are unchanged: neither reads the field.
