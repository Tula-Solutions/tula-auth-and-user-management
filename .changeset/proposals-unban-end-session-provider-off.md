---
'@tula/contract': minor
'@tula/admin': minor
'@tula/mcp': minor
'@tula/cli': minor
'@tula/config': minor
---

An agent can propose three more changes, each of which an administrator can put back with
one call: lifting a ban (`unban_user`), ending one session by its id (`end_session`) and
switching one OAuth provider off (`disable_oauth_provider`: `enabled: false`, its
credentials kept, and refused when it would remove an environment's last way to sign in,
when it is proposed and again when it is approved). `@tula/mcp` gains
`propose_unban_user`, `propose_end_session` and `propose_disable_oauth_provider`;
`tula approve` shows and asks about each in words of its own.

A production environment accepts proposals only where its settings say so: the new
setting `agents.proposalsInProduction`, off by default. Switching it on is a weakening
(recorded in the audit log, asked about in the dashboard, and refused by
`tula apply --yes` without `--allow-weaker`). In `tula.config.ts` the key left out is
`false`; the default does not change a config's fingerprint.

Proposals are limited to five a minute for each operation, beside the ten a minute an
environment's agents share. A proposal's `target.id` is a UUID for a user and a session
and a provider's name for a provider; `failureReason` gains `last_sign_in_method`, and an
approval can be refused with `production_environment`.
