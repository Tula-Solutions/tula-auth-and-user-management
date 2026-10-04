---
'@tula/react': minor
---

Passkeys in the prebuilt components (ADR 0027).

- `<SignIn>`: "Sign in with a passkey" on the first screen (no address needed) where the
  environment has passkeys on and the browser has WebAuthn; the address field carries
  `autocomplete="username webauthn"` and, where the browser supports it, offers the user's
  passkeys in its autofill. After an address, `passkey` is one of the ways to sign in. A
  dismissed dialog is said quietly, in a neutral tone (not the success colour: nothing was
  done), and the button works again. After any try with the button that did not sign in
  (dismissed, refused, failed) the address field offers passkeys in its autofill again.
- The second-factor screen and the step-up dialog ask for the user's passkey where the server
  offers it ("Use your passkey"), next to the other ways or alone.
- `<UserProfile>`: a "Passkeys" section (list with name, synced or on one device, added and
  last used; add, rename, remove after a confirmation). The list is always loaded: where the
  environment has passkeys off, a user who still has passkeys sees them and can rename and
  remove them, with a line in place of "Add a passkey" (`passkey.addUnavailable`); a user who
  has none sees no section.
- `useSignIn()`: `withPasskey()`, `canUsePasskey()` and `submitSecondFactorWithPasskey()`;
  `useResetPassword()`: `submitSecondFactorWithPasskey()`. `adopt()` now discards the attempt
  it replaces.
- New localization group `passkey`, and element names `passkeyIcon`, `passkeyList`,
  `passkeyItem` and `confirmation`.
- A passkey sign-in signs the client in before its flow comes back. `<SignIn>` holds its
  "already signed in" redirect for exactly as long as a passkey request of its own (the button
  or the autofill one) is in flight, so the app's `onComplete` is always what completes such a
  sign-in. Nothing depends on timing, and a user who was signed in when `<SignIn>` or
  `<SignUp>` mounted is sent to `afterSignInUrl` as before.
- `Status` messages have a neutral tone (class `tula-is-neutral` on the `status` element, the
  muted text colour) beside the success one.
