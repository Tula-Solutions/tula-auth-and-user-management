---
'@tula/mcp': minor
'@tula/cli': minor
---

A tool, `test_signin`: an assistant checks that sign-up and sign-in work
([ADR 0058](../docs/adr/0058-test-signin.md)). The server runs the test and answers a
report of each step; no token, code, attempt secret or address is in it. **It is the one
tool that changes live data**: a throwaway user is made and deleted, the environment's
hooks are asked and its events delivered. It runs with an agent key or a secret key, only
where the environment's `agents.testSignIn` allows it (off in production by default), a
few times an hour. `tula mcp` now serves 14 tools and its first line says which one
changes data. `@tula/mcp` exports `TEST_TOOL_NAMES`, `signInTester` and `TEST_OPERATIONS`;
the read-only and proposing facades are unchanged.
