---
'@tula/contract': minor
'@tula/core': minor
'@tula/react': minor
'@tula/admin': minor
'@tula/config': minor
'@tula/cli': minor
'@tula/mcp': minor
---

A device-binding option on a session profile
([docs/device-binding.md](../docs/device-binding.md), ADR 0043): `deviceBinding` is `none`,
`optional` or `required`. Under `required` a native app that starts a sign-in without a
device key is refused; under `none` one that brings a key is. Browsers are not affected by
any value. The default is `none` for the `web` profile and `optional` for every other, which
is how sessions behaved before. A change applies to new sign-ins only.

- `@tula/contract`: `DeviceBindingPolicySchema`, `DeviceBindingPolicy`,
  `defaultDeviceBinding(name)` and `WebSessionProfileSchema`; `deviceBinding` on a session
  profile; the error code `device.binding_required` (400); `deviceBound` on `SessionSchema`
  (the session lists); and `settingsWeakenings` lists
  `sessions.profiles.<name>.deviceBinding` when a profile asks less for a key.
- `@tula/core`: the message of `device.binding_required`, which never ends the local
  session; `session.list()` entries carry `deviceBound`.
- `@tula/react`: `<UserProfile>` marks a session that is bound to a device key, in words
  (`userProfile.deviceBound`).
- `@tula/admin`: the generated types carry the option, the code and `deviceBound`.
- `@tula/config`: `deviceBinding` on a profile in `tula.config.ts`. Left out, it is the
  profile's default and is not part of the file's hash.
- `@tula/cli`: `tula diff` shows the option and flags a profile that asks less as
  `! weakens security`; `tula apply --yes` refuses that without `--allow-weaker`.
- `@tula/mcp`: `list_user_sessions` returns `deviceBound` (a yes or no, never a key) and
  `get_settings` a profile's `deviceBinding`.
