---
'@tula/contract': minor
'@tula/core': minor
---

Passkeys (WebAuthn): registration, usernameless sign-in, second factor and step-up.

- `@tula/contract`: the `passkey` schemas (`Passkey`, creation and request options, the
  browser's registration and assertion responses, the register, rename and sign-in requests),
  `signIn.methods.passkey` and `passkeys.rpId` in the environment settings (with
  `isRelyingPartyId` and `originMatchesRelyingParty`), `passkey` as a second-factor proof and a
  step-up method, the `amr` values `hwk`, `swk` and `user`, the audit actions
  `user.passkey_*`, and the error codes `passkey.registration_failed`,
  `passkey.already_registered`, `passkey.limit_reached` and `passkey.last_sign_in_method`.
- `@tula/core`: `signIn.canUsePasskey()`, `signIn.canAutofillPasskey()` and
  `signIn.withPasskey({ signal, autofill })`; `flow.submitSecondFactorWithPasskey()` on the
  sign-in and password-reset flows; `session.stepUpWithPasskey()`;
  `user.passkeys.{list,add,rename,remove}`. No dependency: the client calls
  `navigator.credentials` itself. New client codes, all `status: 0`: `passkey.unsupported`,
  `passkey.cancelled`, `passkey.already_on_device` and `passkey.failed`. `stepUpMethods` now
  returns `passkey` where the server lists it.
