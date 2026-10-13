---
'@tula/config': minor
---

`agents.testSignIn` in `tula.config.ts`: whether a sign-in test may run in the
environment ([ADR 0058](../docs/adr/0058-test-signin.md)). Left out it is the server's
default by the environment's kind and takes no part in the fingerprint; `true` is a
weakening `tula apply --yes` refuses without `--allow-weaker`.
