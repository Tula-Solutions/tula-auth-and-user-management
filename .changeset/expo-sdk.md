---
'@tula/expo': minor
---

`@tula/expo`: the headless Expo SDK ([docs/expo.md](../docs/expo.md), ADR 0046).

- `createTulaExpoClient(options)`: `@tula/core`'s client as an `ios` or `android` client,
  with its refresh token in the device's secure store (`expo-secure-store`) and its access
  token in memory only. It refuses any other platform, Expo web included, and takes no
  `client`, `storage` or `deviceKey`.
- `<TulaProvider client>` and the hooks `useAuth`, `useUser`, `useSession`, `useSignUp`,
  `useSignIn`, `useResetPassword` and `useTula`. No screen is drawn: a flow hook says which
  screen to draw (`screen`), and `not_supported` for a step, or a step whose every offered
  way, this version does not know (`flowScreen`).
- `secureStoreStorage(store, options)` for an app that builds its own client:
  `keychainAccess` (`when_unlocked`, the default, or `after_first_unlock`; both stay on the
  device) and `keychainService`. A value over `MAX_SECURE_VALUE_BYTES` (2,048) is refused
  before the store is asked, and a store that cannot be read or written is
  `storage.failed`, never "signed out".

Sign-up, sign-in with a password, an emailed or a texted code, password reset, the second
step (authenticator app, backup code, texted code) and the session's devices. Device
binding, passkeys and sign-in with a provider are not part of this version. Nothing of it
has been run in Expo Go, on a simulator or on a device yet (`docs/plans/phase-2-unverified.md`).
