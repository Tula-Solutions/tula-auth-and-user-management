---
'@tula-tech/contract': minor
'@tula-tech/react': patch
---

Security notice emails, and a loading-state fix.

- `@tula-tech/contract`: `EnvironmentSettings` gains `notifications: { passwordChanged, newSignIn }`
  (both `true` by default): whether an account's owner is emailed when their password changes
  and when the account is signed in to from a new device. Additive; documents saved earlier
  read as "on".
- `@tula-tech/react`: `useSession` reports `isLoading: true` for the whole first fetch under
  React's StrictMode. The effect runs twice in development; its second run cleared the flag and
  then joined the first run's request without setting it again.
