---
'@tula/contract': minor
'@tula/core': minor
'@tula/react': minor
'@tula/nextjs': minor
'@tula/admin': patch
---

`password.history` takes effect: where it is 1 or more, the server refuses, as a user's new
password, their current password and the ones before it, as many as the number says, in a
password change and in a reset.

**Check the setting in every environment before you upgrade the server.** Until now the
number was stored and did nothing, and the `strict` preset has it at 5. The history starts
empty (migration `0026`): only passwords changed after the upgrade are remembered. Lowering
the number deletes the stored hashes it no longer covers; raising it brings nothing back.

- `@tula/contract`: the error code `password.reused` (422, `params.history`), and
  `MAX_PASSWORD_HISTORY` (24), the ceiling `history` already had.
- `@tula/core`: the message of `password.reused`. `user.changePassword` and a reset's
  `submit` can now throw it.
- `@tula/react` (and `@tula/nextjs`, which has the same components): the checklist under a
  new password on `<UserProfile>` and in the reset of `<SignIn>` lists the rule where the
  policy remembers passwords, as "checked when you save" and, once the server refuses the
  password, as not met; it is never drawn as met. New strings in the localization:
  `password.history`, `password.historyCurrent`, `password.checkedOnSave`. A custom
  localization that is a complete `Localization` object has to add them.
- `@tula/admin`: the generated types name the new error code. A password an administrator
  sets (`setUserPassword`) is remembered and is not compared with the history.
