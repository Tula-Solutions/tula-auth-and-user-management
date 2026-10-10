# Two-step verification

An authenticator app (TOTP) with ten single-use backup codes, a user's passkey as the second
step, and **step-up**: proving who you are again before a sensitive change. The policy is
`optional` by default: a user may turn it on.
The reasoning is in [ADR 0025](../adr/0025-mfa.md).

## Switch it on

`mfa.policy` says who must use it:

| `mfa.policy` | Meaning |
| --- | --- |
| `optional` (default) | A user may turn it on in the account page. |
| `required` | A user without a second factor sets one up before a sign-in, sign-up or password reset completes, and cannot turn it off. |
| `off` | Nobody can set it up. Users who already have it are still asked for their code. |

| Where | How |
| --- | --- |
| Dashboard | **Sign-in methods**: the two-step verification policy. A user's page: reset two-step verification. |
| `tula.config.ts` | `mfa.policy`. |
| Admin API | `PUT /v1/admin/settings`; `DELETE /v1/admin/users/<id>/factors` for the reset. |

<!-- snippet: examples/tula-config/tula.config.ts#mfa -->
```ts
mfa: { policy: 'required' },
```
<!-- /snippet -->

<!-- snippet: examples/docs-snippets/admin.ts#settings-mfa -->
```ts
const { data } = await admin.call('getEnvironmentSettings')
await admin.call('replaceEnvironmentSettings', {
  headers: { 'If-Match': ifMatch(data.revision) },
  body: { ...data.settings, mfa: { policy: 'required' } },
})
```
<!-- /snippet -->

**A texted code as the second step** is a separate switch, `mfa.smsCode`, off by default
(dashboard: **Text messages**, "Texted code as the second step"; `tula.config.ts`:
`mfa: { smsCode: { enabled: true } }`). It needs text messages on
([phone numbers](../phone-numbers.md#switch-it-on)) and a number the user has already added.
It is the weakest second step there is, whoever receives the number's messages passes it,
and it is treated so:

- A user with an authenticator app or a passkey is never offered it and cannot turn it on;
  one who turns either on later is asked for that from then on.
- Its token says `sms` in `amr` and never `mfa`.
- Where the policy is `required`, switching it on is flagged as weakening security: the
  policy can then be met with a text message.
- **Upgrade `@tula/core` and `@tula/react` before switching it on**: older clients show
  "not supported" at a second step that is a texted code.
- **Switching it off does not let its users in without it.** They are still asked for the
  code, which can no longer be sent, until it is back on or you reset them.

A user who has lost both the authenticator and the backup codes cannot get in by email. An
administrator resets them, which also removes their passkeys, signs them out everywhere and
emails them:

<!-- snippet: examples/docs-snippets/admin.ts#reset-factors -->
```ts
// Removes the user's authenticator, backup codes and passkeys, and signs them out everywhere.
await admin.call('resetUserFactors', { params: { userId } })
```
<!-- /snippet -->

The reset also turns off a texted code as the second step. The phone number stays on the
account.

How long a sign-in counts as recent is the session profile's `stepUpAfter`
([sessions](sessions.md#switch-it-on); ten minutes unless set).

## What the user sees

- **Account page**: "Turn on" shows a QR code and a setup key, asks for a code from the app,
  then shows ten backup codes once (copy or download) and waits for "I have saved these codes".
  Later: how many codes are left, "New backup codes", "Turn off".
- **Sign-in**: after the first factor, "Two-step verification" asks for the app's code, with
  "Use a backup code" (and the passkey, for a user who has one).
- **Required and not set up**: the sign-in stops at "Set up two-step verification" and enrols
  inside the sign-in; the backup codes stay on top of the app until they are saved.
- **Texted code**: where it is on and the user has a number and nothing stronger, the account
  page offers "Use a texted code"; it texts a code to the number and asks for it. At a
  sign-in the second step shows a "Text me a code" button: nothing is sent until it is
  pressed, and the code field appears once the message went. A user who has just added the
  number waits a minute before the first code can be sent.
- **Step-up**: a "Confirm it is you" dialog before a sensitive change made on an old sign-in.
  It asks for the second factor when the user has one, and otherwise for the password or a
  code by email. The change is then retried by itself.

## Security properties and limits

- **No session before the second factor**: a password, an emailed code or a provider alone
  yields no token for a user who has one. A passkey sign-in is the exception, because it
  verifies the user itself.
- A password reset stops at the second factor too. There is no emailed bypass, and nothing
  removes a second factor except its owner (after a step-up) or an administrator's reset.
- An authenticator code is accepted once, for the current 30-second step and the one on either
  side: keep the servers' clocks in sync. After a wrong guess wait for the app's next code.
- Wrong codes are counted per user across every route that checks one; too many is
  `rate_limited`.
- The secret is stored encrypted with `TULA_MASTER_KEY` and backup codes as keyed hashes:
  **changing the master key breaks every user's second factor**.
- The secret, its `otpauth://` URI and the backup codes are shown once and kept nowhere in the
  SDK.
- Access tokens carry `auth_time` and `amr` (for example `["pwd","otp","mfa"]`), so your own
  backend can demand a recent or a two-factor sign-in without calling Tula.
- A user with a second factor steps up with it, never with the password alone, and never
  with an emailed code.
- **A texted code is never used beside a stronger factor.** It is offered, at a sign-in, a
  reset and a step-up, only to a user whose only second step it is. It never removes or
  resets another factor and is no way back in for someone who lost their authenticator.
  It cannot be turned on by a user who has an authenticator app or a passkey
  (`mfa.sms_not_allowed`), also when that factor arrived while the code was on its way.
- **A texted code a user already had is dormant beside a stronger factor, and live again
  when the stronger factor goes.** Adding an authenticator app or a passkey does not remove
  it: it is not asked for while the stronger method exists, and it is the second step
  again once that method is removed. `Factors.sms.inUse` tells the two states apart, and
  the account page says so.
- **A passkey added by a user with a texted code replaces it as the second step, and a
  passkey has no backup codes.** After a password such a user is asked for the passkey and
  nothing else. If they lose it, an administrator's reset is the way back in. `<UserProfile>`
  says this above "Add a passkey" before the browser is asked for anything.
- **Two texted codes are one factor.** A user whose second step is a texted code cannot
  sign in with a code texted to the same number (`mfa.needs_other_sign_in`): they use the
  password or an emailed code first.
- A texted code as the second step goes with its number: removing or replacing the number
  turns it off, and the user is emailed.
- Turning it on, off, a reset, new backup codes and a backup code used to sign in are announced
  to the user by email (`notifications.mfaChanged`).

## SDK calls

`<SignIn>` draws the second step and the in-flow enrolment; `<UserProfile>` the section; the
provider draws the step-up dialog and the backup codes of an in-flow enrolment, because the
page that asked may be gone by then. Nothing needs a prop:

<!-- snippet: examples/nextjs-app-router/app/profile/page.tsx -->
```tsx
import { UserProfile } from '@tula/nextjs'

/** The account page. The proxy protects it; the component talks to the API from the browser. */
export default function ProfilePage() {
  return <UserProfile afterSignOutUrl='/' />
}
```
<!-- /snippet -->

`@tula/core`:

<!-- snippet: examples/docs-snippets/core.ts#totp-enrol -->
```ts
const { secret, uri } = await tula.mfa.startTotp() // show `uri` as a QR code, `secret` for typing
const { codes } = await tula.mfa.confirmTotp({ code }) // ten backup codes, shown once
```
<!-- /snippet -->

<!-- snippet: examples/docs-snippets/core.ts#second-factor -->
```ts
const flow = await tula.signIn.start({ identifier: email })
await flow.submitPassword({ password })
// flow.step: { status: 'needs_second_factor', options: ['totp', 'backup_code'] }
const { step } = await flow.submitSecondFactor({ method: 'totp', code })
// or a backup code, which is spent:
// await flow.submitSecondFactor({ method: 'backup_code', code })
// or the user's passkey, where the options list it:
// await flow.submitSecondFactorWithPasskey()
```
<!-- /snippet -->

<!-- snippet: examples/docs-snippets/core.ts#factor-enrolment -->
```ts
// Where `mfa.policy` is 'required' and the user has no second factor, the flow stops to enrol.
if (flow.step.status === 'needs_factor_enrolment') {
  const enrolment = await flow.startTotpEnrolment() // { secret, uri }
  const { backupCodes } = await flow.confirmTotpEnrolment({ code }) // signed in
  return { enrolment, backupCodes }
}
```
<!-- /snippet -->

Step-up. The SDK never prompts and never retries by itself; your UI does:

<!-- snippet: examples/docs-snippets/core.ts#step-up -->
```ts
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
```
<!-- /snippet -->

Reference: [`@tula/core`](../reference/core.md), [`@tula/react`](../reference/react.md).

## Troubleshooting

| Code | What it means and what to do |
| --- | --- |
| `mfa.invalid_code` | Wrong authenticator or backup code, or an authenticator code that was already used. Wait for the next code. If every code is wrong, the device's clock is off. |
| `mfa.already_enabled` | The user already has an authenticator, or already has a texted code as the second step. |
| `mfa.not_enabled` | The call needs an authenticator, or a texted second step, the user does not have. |
| `mfa.enrolment_expired` | A started enrolment lasts ten minutes. Start again. |
| `mfa.not_available` | `mfa.policy` is `off`. |
| `auth.method_disabled` | A texted code as the second step is switched off (`mfa.smsCode`). A user who has it cannot finish signing in until it is back on or an administrator resets them. The prebuilt screens show the message and remove "Text me a code" (as they do for `sms.disabled` and `sms.country_not_allowed`): asking again would be refused again. |
| `mfa.phone_number_required` | Turning on a texted code needs a phone number on the account. Add one first. |
| `mfa.sms_not_allowed` | The user has an authenticator app or a passkey: a texted code is not used beside it. |
| `mfa.needs_other_sign_in` | The sign-in was started with the phone number and the user's second step is a texted code. Sign in with the password or an emailed code. |
| `sms.unavailable` | The text message could not be sent. Nothing was stored: an earlier code still works. |
| `mfa.required_by_policy` | `mfa.policy` is `required`: it cannot be turned off. |
| `auth.step_up_required` | The sign-in is too old, or did not include the second factor. `params.methods` lists what the user may prove with; an empty list means sign in again. |
| `auth.invalid_credentials` | A wrong password in a step-up. |
| `verification.invalid_code` | A wrong emailed code in a step-up. |
| `rate_limited` | Too many wrong codes, or a code (by email or by text) asked for again within a minute. A number is texted once a minute whoever asks. |
| `flow.not_found` | The sign-in attempt expired while the second step was open. Start again. |
