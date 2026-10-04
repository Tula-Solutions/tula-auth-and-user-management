---
'@tula/contract': minor
'@tula/admin': minor
---

How a user signs in, for a server or the dashboard.

- `@tula/contract`: `UserAuthenticationSchema` / `UserAuthentication`, the answer of
  `GET /v1/admin/users/{userId}/authentication`: whether the account has a password and a
  verified address, its linked provider accounts, its confirmed second factors with the number
  of unused backup codes, its passkeys, and `canSignInWithoutPasskeys` (whether a reset of
  two-step verification would leave the user a way in). Never a secret or a credential id.
- `@tula/admin`: the admin client gains `getUserAuthentication`.
