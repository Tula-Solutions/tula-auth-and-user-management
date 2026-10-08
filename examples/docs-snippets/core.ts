import { createTulaClient, isStepUpRequired, isTulaError, stepUpMethods } from '@tula/core'

// The `@tula/core` calls shown in docs/methods/*.md. Each `#region` is copied into a page by
// `bun run docs:generate`, and this file is compiled by `bun run typecheck:scripts`: a sample
// that no longer matches the SDK fails the build instead of misleading a reader.
//
// Nothing here runs. The functions exist so that every sample has the values it needs.

// #region client
const tula = createTulaClient({
  publishableKey: 'tula_pk_dev_…',
  baseUrl: 'https://auth.example.com',
})
// #endregion

/** Sign up with a password, then prove the address with the emailed code. */
export async function passwordSignUp(email: string, password: string, code: string) {
  // #region password-sign-up
  const flow = await tula.signUp.start({ email, password, firstName: 'Maya' })
  // flow.step.status === 'needs_email_verification'
  const step = await flow.verifyEmail({ code })
  // step.status === 'complete': the client is signed in
  // #endregion
  return step
}

/** Sign in with a password. */
export async function passwordSignIn(email: string, password: string) {
  // #region password-sign-in
  const flow = await tula.signIn.start({ identifier: email })
  try {
    const step = await flow.submitPassword({ password })
    // 'complete', 'needs_email_verification', 'needs_second_factor' or 'needs_factor_enrolment'
    return step
  } catch (error) {
    if (isTulaError(error) && error.code === 'auth.invalid_credentials') {
      // The same answer for a wrong password and an unknown address.
    }
    throw error
  }
  // #endregion
}

/** Reset a forgotten password and change a known one. */
export async function passwordReset(email: string, code: string, newPassword: string) {
  // #region password-reset
  const flow = await tula.resetPassword.start({ email })
  // The code and the new password travel together.
  const step = await flow.submit({ code, password: newPassword })
  // #endregion
  // #region password-change
  await tula.user.changePassword({ currentPassword: 'the old one', newPassword })
  // #endregion
  return step
}

/** Sign in with a 6-digit code sent by email. */
export async function emailCode(email: string, code: string) {
  // #region email-code
  const flow = await tula.signIn.start({ identifier: email })
  // flow.step: { status: 'needs_first_factor', strategies: [...] } where the method is on
  await flow.prepareFirstFactor({ strategy: 'email_code' }) // sends the email
  const step = await flow.attemptFirstFactor({ strategy: 'email_code', code })
  // #endregion
  // #region passwordless-sign-up
  // Where the environment's `signUp.password` is 'optional', a sign-up may leave it out.
  const signUp = await tula.signUp.start({ email })
  await signUp.verifyEmail({ code })
  // #endregion
  return step
}

/** Ask for an emailed link and wait for it to be opened in this browser. */
export async function emailLink(email: string, signal: AbortSignal) {
  // #region email-link
  const flow = await tula.signIn.start({ identifier: email })
  if (tula.signIn.canUseEmailLink()) {
    await flow.prepareFirstFactor({
      strategy: 'email_link',
      // An allowed redirect URL, exactly, on this page's own origin.
      redirectUrl: `${location.origin}/auth/link`,
    })
    const step = await flow.waitForEmailLink({ signal }) // resolves when the link was opened
    return step
  }
  // #endregion
  return flow.step
}

/** On the page the emailed link leads to. */
export async function emailLinkLanding() {
  // #region email-link-landing
  const { status } = await tula.signIn.handleEmailLink()
  // 'signed_in' | 'verified' | 'different_browser' | 'expired' | 'none'
  // #endregion
  return status
}

/** Start a provider sign-in, and finish it on the callback page. */
export async function oauth() {
  // #region oauth-start
  // Keeps a binding for this tab and navigates to the provider.
  await tula.signIn.withOAuth({
    provider: 'google',
    redirectUrl: `${location.origin}/oauth/callback`,
  })
  // #endregion
  // #region oauth-callback
  // On /oauth/callback, on every load:
  const outcome = await tula.signIn.handleOAuthCallback()
  switch (outcome.status) {
    case 'complete': // signed in
      break
    case 'needs_step': // outcome.flow.step is needs_second_factor or needs_factor_enrolment
      break
    case 'linked': // a link started with tula.user.identities.link(): outcome.identity
      break
    case 'different_browser': // this browser did not start it; nothing was completed
      break
    case 'error': // outcome.code: 'oauth.account_exists', 'oauth.access_denied', …
      break
    case 'none': // no OAuth answer in the address
      break
  }
  // #endregion
  // #region oauth-identities
  const identities = await tula.user.identities.list()
  await tula.user.identities.link({
    provider: 'github',
    redirectUrl: `${location.origin}/oauth/callback`,
  })
  // #endregion
  return identities
}

/** Sign in with a passkey, and manage the signed-in user's passkeys. */
export async function passkeys(signal: AbortSignal) {
  // #region passkey-sign-in
  if (tula.signIn.canUsePasskey()) {
    // The browser's passkey dialog; no address is typed.
    const flow = await tula.signIn.withPasskey()
    if (flow.step.status === 'complete') {
      // Signed in: a passkey needs no second step.
    }
  }
  // #endregion
  // #region passkey-autofill
  // Offer passkeys in the address field's autofill (`autocomplete="username webauthn"`).
  void tula.signIn.withPasskey({ autofill: true, signal })
  // #endregion
  // #region passkey-manage
  const passkey = await tula.user.passkeys.add({ name: 'Work laptop' })
  await tula.user.passkeys.rename({ passkeyId: passkey.id, name: 'Laptop' })
  const all = await tula.user.passkeys.list()
  await tula.user.passkeys.remove({ passkeyId: passkey.id })
  // #endregion
  return all
}

/** Turn two-step verification on, and sign in with it. */
export async function twoStep(email: string, password: string, code: string) {
  // #region totp-enrol
  const { secret, uri } = await tula.mfa.startTotp() // show `uri` as a QR code, `secret` for typing
  const { codes } = await tula.mfa.confirmTotp({ code }) // ten backup codes, shown once
  // #endregion
  // #region second-factor
  const flow = await tula.signIn.start({ identifier: email })
  await flow.submitPassword({ password })
  // flow.step: { status: 'needs_second_factor', options: ['totp', 'backup_code'] }
  const { step } = await flow.submitSecondFactor({ method: 'totp', code })
  // or a backup code, which is spent:
  // await flow.submitSecondFactor({ method: 'backup_code', code })
  // or the user's passkey, where the options list it:
  // await flow.submitSecondFactorWithPasskey()
  // #endregion
  // #region factor-enrolment
  // Where `mfa.policy` is 'required' and the user has no second factor, the flow stops to enrol.
  if (flow.step.status === 'needs_factor_enrolment') {
    const enrolment = await flow.startTotpEnrolment() // { secret, uri }
    const { backupCodes } = await flow.confirmTotpEnrolment({ code }) // signed in
    return { enrolment, backupCodes }
  }
  // #endregion
  return { secret, uri, codes, step }
}

/** Prove who the user is again before a sensitive change. */
export async function stepUp(code: string) {
  // #region step-up
  try {
    await tula.mfa.regenerateBackupCodes()
  } catch (error) {
    if (!isStepUpRequired(error)) {
      throw error
    }
    const methods = stepUpMethods(error) // e.g. ['totp', 'backup_code', 'passkey']
    if (methods.includes('totp')) {
      await tula.session.stepUp({ method: 'totp', code })
    } else if (methods.includes('passkey')) {
      await tula.session.stepUpWithPasskey()
    } else if (methods.includes('email_code')) {
      await tula.session.prepareStepUp({ method: 'email_code' }) // emails a code
      await tula.session.stepUp({ method: 'email_code', code })
    } else if (methods.includes('password')) {
      await tula.session.stepUp({ method: 'password', password: code })
    }
    await tula.mfa.regenerateBackupCodes() // repeat the call
  }
  // #endregion
}

/** A phone number on the account, proven with a texted code (ADR 0037). */
export async function phoneNumber(code: string) {
  // #region phone-number
  // Both calls need a recent authentication: handle `auth.step_up_required` as above.
  const sent = await tula.user.phone.request({ phoneNumber: '+1 (415) 555-0142' })
  // sent.destination === '***42'; the code is in the text message, never in an answer
  const user = await tula.user.phone.verify({ code })
  // user.phoneNumber === '+14155550142', user.phoneNumberVerifiedAt is when
  await tula.user.phone.remove()
  // #endregion
  return { sent, user }
}

/** Tokens, devices and sign-out. */
export async function sessions() {
  // #region sessions
  const token = await tula.session.getToken() // refreshed first if needed; null when signed out
  const devices = await tula.session.list() // `current` marks this one
  const other = devices.find((device) => !device.current)
  if (other) {
    await tula.session.revoke(other.id)
  }
  await tula.session.revokeOthers()
  await tula.session.signOut()
  // #endregion
  // #region session-profile
  // Ask for a named profile; granted only if the environment marks it `clientSelectable`.
  const backOffice = createTulaClient({
    publishableKey: 'tula_pk_dev_…',
    baseUrl: 'https://auth.example.com',
    sessionProfile: 'back-office',
  })
  // #endregion
  return { token, backOffice }
}
