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

A user who has lost both the authenticator and the backup codes cannot get in by email. An
administrator resets them, which also removes their passkeys, signs them out everywhere and
emails them:

<!-- snippet: examples/docs-snippets/admin.ts#reset-factors -->
```ts
// Removes the user's authenticator, backup codes and passkeys, and signs them out everywhere.
await admin.call('resetUserFactors', { params: { userId } })
```
<!-- /snippet -->

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
| `mfa.already_enabled` | The user already has an authenticator. |
| `mfa.not_enabled` | The call needs an authenticator the user does not have. |
| `mfa.enrolment_expired` | A started enrolment lasts ten minutes. Start again. |
| `mfa.not_available` | `mfa.policy` is `off`. |
| `mfa.required_by_policy` | `mfa.policy` is `required`: it cannot be turned off. |
| `auth.step_up_required` | The sign-in is too old, or did not include the second factor. `params.methods` lists what the user may prove with; an empty list means sign in again. |
| `auth.invalid_credentials` | A wrong password in a step-up. |
| `verification.invalid_code` | A wrong emailed code in a step-up. |
| `rate_limited` | Too many wrong codes, or a step-up code asked for again within a minute. |
| `flow.not_found` | The sign-in attempt expired while the second step was open. Start again. |
