---
'@tula-tech/admin': minor
---

Two operations, `runSignInTest` (an agent key, `POST /v1/agent/sign-in-tests`) and
`runSignInTestAsAdmin` (a secret key, `POST /v1/admin/sign-in-tests`): the server signs a
throwaway user up and in through the environment's real flow, deletes it and answers a
report of each step ([ADR 0058](../docs/adr/0058-test-signin.md)). Refused with
`auth.forbidden` where the environment's `agents.testSignIn` does not allow it.
