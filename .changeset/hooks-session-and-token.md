---
'@tula/contract': minor
'@tula/admin': minor
'@tula/core': patch
---

Hooks before a session and before a token ([docs/hooks.md](../docs/hooks.md)). An
environment can register two more hooks: `before_session`, asked once every factor of a
sign-in is proven and able to refuse it, and `before_token`, which answers with claims that
are issued under `ext` of the session's access tokens. The contract gains the two points
(`HOOK_POINTS`), their questions (`HookBeforeSessionDataSchema`,
`HookBeforeTokenDataSchema`, in `HOOK_QUESTION_SCHEMAS` and `HOOK_QUESTION_FIXTURES`), the
claims answer (`HookClaimsAnswerSchema`, `readHookClaimsAnswer`), the failure reasons
`claims_invalid` and `claims_too_large`, `checkCustomClaims` in `@tula/contract/custom-claims`,
and the optional `hookBypassed` and `claimsHookBypassed` on `session.created` and
`claimsHookBypassed` on `session.stepped_up`. `@tula/admin`'s `verifyHook` accepts the two new
questions, `TulaHookQuestion` is a union to narrow on `type`, and `TulaHookClaimsAnswer` is
the answer of a claims hook. No error code is added: `hook.denied` and `hook.unavailable`
now answer a refused sign-in too, and their messages no longer say "sign-up" ("This was not
allowed.", "This is unavailable right now. Try again later."), which is the whole change to
`@tula/core`.
