---
'@tula/react': minor
---

Passkeys in the prebuilt components (ADR 0027).

- `<SignIn>`: "Sign in with a passkey" on the first screen (no address needed) where the
  environment has passkeys on and the browser has WebAuthn; the address field carries
  `autocomplete="username webauthn"` and, where the browser supports it, offers the user's
  passkeys in its autofill. After an address, `passkey` is one of the ways to sign in. A
  dismissed dialog is said quietly and the button works again.
- The second-factor screen and the step-up dialog ask for the user's passkey where the server
  offers it ("Use your passkey"), next to the other ways or alone.
- `<UserProfile>`: a "Passkeys" section (list with name, synced or on one device, added and
  last used; add, rename, remove after a confirmation). Left out where the environment has
  passkeys off.
- `useSignIn()`: `withPasskey()`, `canUsePasskey()` and `submitSecondFactorWithPasskey()`;
  `useResetPassword()`: `submitSecondFactorWithPasskey()`. `adopt()` now discards the attempt
  it replaces.
- New localization group `passkey`, and element names `passkeyIcon`, `passkeyList`,
  `passkeyItem` and `confirmation`.
- **Changed:** a user who is already signed in when `<SignIn>` or `<SignUp>` mounts is sent to
  `afterSignInUrl` one turn of the event loop later than before, so that a passkey sign-in's
  own completion (and the app's `onComplete`) is not mistaken for it.
