---
'@tula/contract': patch
---

`tula doctor` says when a session profile requires a device key on a deployment that can
accept none ([ADR 0043](../docs/adr/0043-device-binding.md#a-deployment-that-cannot-bind-and-a-profile-that-requires-a-key-added-2026-10-12-tula-72),
[docs/device-binding.md](../docs/device-binding.md#a-deployment-that-cannot-bind)). The
server's diagnostics answer one more check, `device_binding`: `ok` where a device-binding
proof can name `PUBLIC_URL`; a warning where none can (no session is bound, and a sign-in
that brings a key is refused); a failure, with a count of environments, where the profile a
native app gets by default also says `deviceBinding: "required"`, because a native sign-in
there is refused with a key and without; and a warning with a count where only a profile a
sign-in has to ask for requires one. Nothing about a sign-in changed: the setting is still
saved, and `required` is never skipped.

**`@tula/contract`**: the OpenAPI document's description of `getInstanceDiagnostics` names
the check. No schema changed: a check's `id` was and is a string.

`@tula/cli` and `@tula/mcp` print whatever checks the server answers and are unchanged.
