---
'@tula/config': minor
'@tula/cli': minor
---

Hooks in `tula.config.ts` ([docs/config.md](../docs/config.md#hooks)). An environment can
list its hooks by point (`hooks: { before_sign_up: { url, enabled?, deadlineMs?,
failureMode? } }`); `@tula/config` exports `HookConfig` and `HooksConfig`. There is no field
for a signing secret, and an environment without the key is not read, not changed and keeps
its fingerprint. `tula diff` plans them (a hook is its point, so a changed address is an
update) and marks as weaker a hook that lets failures through (`failureMode: 'allow'`), one
switched off and one that is on and removed; `tula apply --yes` refuses such a plan without
`--allow-weaker`. A created hook's signing secret goes where a new webhook endpoint's goes
(`--secrets-file`, `--show-secrets` or `--discard-secrets`; required before any write), and
`--json` gains `hooks`, `hookSecrets` and `applyRequires.hookSecrets`.
