---
'@tula-tech/contract': minor
'@tula-tech/admin': minor
'@tula-tech/core': patch
---

Hooks: an environment can register an endpoint the server asks before a sign-up creates an
account (`/v1/admin/hooks`, [docs/hooks.md](../docs/hooks.md)). The contract gains the hook's
schemas, its question (`HOOK_QUESTION_SCHEMAS`, `HOOK_QUESTION_FIXTURES`) and answer
(`HookAnswerSchema`), `hookWeakenings`, the event types `hook.created`, `hook.updated` and
`hook.deleted`, the optional `hookBypassed` on `user.created`, and the error codes
`hook.denied`, `hook.unavailable` and `hook.url_not_allowed`. `@tula-tech/admin` gains
`verifyHook`, `TulaHookQuestion` and `TulaHookAnswer`, and the typed operations
`createHook`, `listHooks`, `getHook`, `updateHook` and `deleteHook`. `@tula-tech/core` carries the
three new codes and their messages: 50 bytes gzipped, and its bundle budget moved from 15,500
to 15,550 bytes with them.
