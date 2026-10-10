# Password

An email address and a password: sign-up with an emailed verification code, sign-in, "forgot
password" and changing it in the account page. It is on by default.
The reasoning is in [ADR 0006](../adr/0006-passwords.md) (hashing and policy),
[ADR 0038](../adr/0038-password-history.md) (password history),
[ADR 0041](../adr/0041-password-expiry.md) (password expiry),
[ADR 0015](../adr/0015-password-reset.md) (reset) and
[ADR 0011](../adr/0011-rate-limits-and-lockout.md) (limits and lockout).

## Switch it on

| Where | How |
| --- | --- |
| Dashboard | **Sign-in methods**: the password switch and whether a sign-up needs one. **Password policy**: a preset or custom rules ([dashboard.md](../dashboard.md#screens)). |
| `tula.config.ts` | `signIn.methods.password`, `signUp.password` and `password`, then `tula apply` ([config.md](../config.md)). |
| Admin API | `PUT /v1/admin/settings` with the whole document and `If-Match` ([self-host.md](../self-host.md#settings-of-an-environment)). |

The methods, in a config file:

<!-- snippet: examples/tula-config/tula.config.ts#methods -->
```ts
signIn: {
  methods: {
    password: { enabled: true },
    emailCode: { enabled: true },
    emailLink: { enabled: true },
  },
},
```
<!-- /snippet -->

A custom policy (leave `password` out and the deployment's `PASSWORD_POLICY` stays in force):

<!-- snippet: examples/tula-config/tula.config.ts#password -->
```ts
password: {
  preset: 'custom',
  minLength: 12,
  maxLength: 128,
  requireLowercase: false,
  requireUppercase: false,
  requireNumber: false,
  requireSpecial: false,
  minCharacterClasses: 0,
  specialChars: '!@#$%^&*()-_=+[]{};:,.?/\\|\'"`~<>',
  disallowUserInfo: true,
  disallowCommon: true,
  breachCheck: 'block',
  maxRepeatedChars: null,
  blockSequences: false,
  history: 5,
  expiryDays: null,
},
```
<!-- /snippet -->

The same through the admin API, with `@tula/admin`:

<!-- snippet: examples/docs-snippets/admin.ts#client -->
```ts
// Server-side only: the secret key can do anything in its environment.
const admin = createAdminClient({ baseUrl: 'https://auth.example.com', secretKey })
```
<!-- /snippet -->

<!-- snippet: examples/docs-snippets/admin.ts#settings-sign-up -->
```ts
const { data } = await admin.call('getEnvironmentSettings')
try {
  await admin.call('replaceEnvironmentSettings', {
    headers: { 'If-Match': ifMatch(data.revision) },
    body: {
      ...data.settings,
      signIn: {
        methods: {
          ...data.settings.signIn?.methods,
          password: { enabled: true },
          emailCode: { enabled: true },
        },
      },
      signUp: { password: 'optional' },
    },
  })
} catch (error) {
  if (isTulaAdminError(error) && error.code === 'precondition.failed') {
    // Someone else changed the settings since they were read: read them again.
  }
  throw error
}
```
<!-- /snippet -->

At least one sign-in method must stay on. The password may be switched off only when another
method (an emailed code, a passkey or a provider) is on.

## What the user sees

- **Sign-up**: name (optional), address, password with a live checklist of the policy's rules,
  then "Check your email" for the 6-digit code. The account exists but is not signed in until
  the address is verified.
- **Sign-in**: the address, then the password. A wrong password and an unknown address get the
  same message.
- **Forgot password**: a code by email, typed together with the new password. The user is
  signed in afterwards.
- **Account page**: change the password (the current one is asked for).
- **Where the policy remembers passwords** (`password.history` of 1 or more), the checklist
  under a new password on the account page and in the reset has one more line, "Not one of
  your last 5 passwords" ("Not your current password" for a history of 1). A browser cannot
  judge it, so the line says "Checked when you save" and is never ticked; when the server
  refuses the password the line is marked as not met and the field shows the server's
  message. A sign-up does not show it: a first password has no history.

- **Where passwords expire** (`password.expiryDays`), a user who signs in with a password
  older than that sees "Your password has expired" after the password (and after their
  second factor, where they have one), with one field for a new password and the policy's
  checklist. Its last line is "Not your current password" (or the history's line, where
  the policy remembers more): the expired password cannot be chosen again. They are signed
  in once the new password is accepted, and every other session of theirs ends.

A password that is set, reset or changed is announced to the owner by email
(`notifications.passwordChanged`).

## Security properties and limits

- Passwords are hashed with Argon2id and checked against the policy only when they are set.
  `tula policy test` tries one against an environment's policy without sending it anywhere
  ([cli.md](../cli.md#tula-policy-test)).
- `password.minLength` cannot be set below 8. The `recommended` preset is length plus a breach
  check; `BREACH_CHECK=hibp` asks Have I Been Pwned with a 5-character hash prefix.
- **Password history.** `password.history: N` (0 to 24; 0, the default, is off) refuses, as a
  user's new password, their current password and the N − 1 before it, in a change and in a
  reset, with `password.reused`. The answer carries the policy's number and nothing about
  which password matched. The server keeps the N − 1 previous hashes per user (Argon2id, as
  the current one), deletes them with the user, and compares only after the caller has
  proven what the route asks for (the current password for a change, the emailed code for a
  reset) and the password has passed every other rule. A reset refused this way has not
  used its code up.
  - **A reset is proven by the emailed code alone, also for a user with two-step
    verification**: the new password is stored first and the second factor is asked for
    before the session. So someone who holds only the inbox of such an account can learn
    from `password.reused` that a password they try is one of the owner's last N. That is
    accepted: it is at most ten tries an hour for the account, and a try that is not refused
    really replaces the password, which ends every session and emails the owner
    (`notifications.passwordChanged`). The same person could replace the password anyway.
  - **Lowering the number deletes hashes**: a user's at their next password change, everyone
    else's by the retention job. **Raising it brings nothing back**: after a change from 2
    to 10 a user is held to ten passwords only once they have had ten. A deployment that set
    `history` before it was enforced (the `strict` preset has it at 5) starts with an empty
    history.
  - **A password an administrator sets is not compared** (`PUT /v1/admin/users/:id/password`,
    the dashboard's "set a new password"): an administrator does not know a user's old
    passwords and must not learn them from a refusal. It is remembered, so the user cannot
    change straight back to the one before it.
  - **At most ten comparisons an hour per user.** With a history on, a user's eleventh
    attempt to change or reset their password within an hour is `rate_limited` with
    `Retry-After`, whichever address it comes from. A full history of 24 costs about a
    second and a half of one core per attempt.
  - An account with no password (it signed up with a provider or an emailed code) is
    compared with nothing: its first password is never refused as reused.
- **Password expiry.** `password.expiryDays: N` (a whole number of days, at least 1; `null`,
  the default, is off; the `legacy` preset has 90) stops a sign-in **with the password**
  whose password was set N days ago or longer: the attempt waits on `needs_new_password`
  with `reason: "expired"` and no session, until a new password is sent to
  `POST /v1/client/sign-ins/{attemptId}/new-password`.
  - **Only a right password is ever answered that way.** A wrong password, an unknown
    address and a locked-out address get the answers they always got, at the same cost:
    expiry says nothing about an account to someone who cannot sign in to it.
  - **A second factor comes first.** A user with two-step verification proves it before the
    new password is asked for, so the old password alone never replaces the password.
  - **Only the password is affected.** An emailed code or link, a texted code, a passkey and
    a provider sign in whatever the password's age, and sessions that exist when a password
    expires go on. Where every sign-in has to pass through a fresh password, the password
    has to be the only method.
  - **The expired password is refused as the new one** (`password.reused`, `params.history`
    of at least 1), also where `password.history` is 0. With no history nothing is kept of
    it, so the user can change back to it later through the account page; set a history to
    close that.
  - The new password is the user's own change: held to the policy and the history, at most
    ten comparisons an hour per user, announced to the owner, recorded as
    `user.password_changed` with `method: "self"`.
  - **Age is counted from when the password was last set** (a sign-up, a change, a reset, an
    administrator's set-password). The server's own re-hashing of a password after a sign-in
    does not make it newer. Passwords that existed before the server recorded that time
    count from the last time their row was written ([upgrading](../self-host.md#upgrading)).
  - If the account's password is replaced some other way while the attempt waits (a reset,
    an administrator), the attempt ends with `flow.invalid_step`: start the sign-in again.
  - **The new password can be stored and the sign-in still fail.** After the password is
    stored the server ends the user's earlier sessions (three tries), then asks the
    `before_session` hook and creates the session. If the sessions cannot be ended the
    answer is `service.unavailable` (503): the password is the new one, the sessions made
    under the old one stay alive until they end or are ended, and the server logs an error
    with the environment's and the user's id. End them with
    `DELETE /v1/admin/users/{userId}/sessions`. If a hook refuses, or the session cannot be
    created, the password is the new one and the earlier sessions have ended. Either way the
    user signs in again with the new password; sending the request again answers
    `flow.invalid_step`.
  - **Clients older than this feature do not know the step**: an older `@tula/react` shows
    "This step is not supported", so a user with an expired password cannot sign in through
    it. Upgrade the clients before setting `expiryDays`.
  - There is no warning before a password expires and no grace period.
- Sign-in failures are always `auth.invalid_credentials`: nothing says whether the address has
  an account.
- Wrong guesses are counted per address and per client address; after too many the answer is
  `rate_limited` with `Retry-After`, for the right password too, until the lock lapses.
- A sign-up, sign-in or reset attempt lives ten minutes and is bound to the client that started
  it; a browser attempt is refused from an origin the environment does not allow.
- A reset stops at the second factor for a user who has one: an emailed code alone never gets
  past two-step verification.
- A password on an account whose address is still unverified (an administrator created it so)
  is removed when the address is first proven by someone who did not prove that password: an
  [emailed code](email-code.md) or [link](email-link.md), or the code after a
  [passkey](passkeys.md) sign-in. The owner is sent a notice where
  `notifications.passwordChanged` is on (with it off the removal is recorded in the audit log
  only) and sets a password by reset.
  After a password sign-in, in a sign-up and in a reset the password stays.

## SDK calls

`@tula/react` and `@tula/nextjs`: `<SignUp>` and `<SignIn>` draw every screen above, including
the reset; `<UserProfile>` holds the password change. These are the example app's pages:

<!-- snippet: examples/nextjs-app-router/app/sign-up/page.tsx -->
```tsx
import { SignUp } from '@tula/nextjs'

export default function SignUpPage() {
  return <SignUp signInUrl='/sign-in' afterSignUpUrl='/dashboard' collectName />
}
```
<!-- /snippet -->

<!-- snippet: examples/nextjs-app-router/app/sign-in/page.tsx -->
```tsx
import { SignIn } from '@tula/nextjs'
import { safeRedirectPath } from '@tula/nextjs/server'

/**
 * The sign-in page. The proxy sends signed-out visitors here with `redirect_url`: where they
 * were going. Anyone can write that parameter, so it goes through `safeRedirectPath`, which
 * accepts a path on this origin and nothing else.
 */
export default async function SignInPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { redirect_url: target } = await props.searchParams
  return <SignIn signUpUrl='/sign-up' afterSignInUrl={safeRedirectPath(target, '/dashboard')} />
}
```
<!-- /snippet -->

`@tula/core`, when you draw the screens yourself:

<!-- snippet: examples/docs-snippets/core.ts#client -->
```ts
const tula = createTulaClient({
  publishableKey: 'tula_pk_dev_…',
  baseUrl: 'https://auth.example.com',
})
```
<!-- /snippet -->

<!-- snippet: examples/docs-snippets/core.ts#password-sign-up -->
```ts
const flow = await tula.signUp.start({ email, password, firstName: 'Maya' })
// flow.step.status === 'needs_email_verification'
const step = await flow.verifyEmail({ code })
// step.status === 'complete': the client is signed in
```
<!-- /snippet -->

<!-- snippet: examples/docs-snippets/core.ts#password-sign-in -->
```ts
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
```
<!-- /snippet -->

<!-- snippet: examples/docs-snippets/core.ts#password-expired -->
```ts
const flow = await tula.signIn.start({ identifier: email })
const step = await flow.submitPassword({ password })
if (step.status === 'needs_new_password' && step.reason === 'expired') {
  // The password was right and is older than the environment allows. Nobody is signed in
  // until a new one is accepted; a refused one (`password.*`) can be tried again.
  await flow.submitNewPassword({ password: newPassword })
}
```
<!-- /snippet -->

<!-- snippet: examples/docs-snippets/core.ts#password-reset -->
```ts
const flow = await tula.resetPassword.start({ email })
// The code and the new password travel together.
const step = await flow.submit({ code, password: newPassword })
```
<!-- /snippet -->

<!-- snippet: examples/docs-snippets/core.ts#password-change -->
```ts
await tula.user.changePassword({ currentPassword: 'the old one', newPassword })
```
<!-- /snippet -->

`@tula/expo` has the same calls as hooks and draws nothing: the app's screen follows
`screen`, and its last branch is "not supported" ([expo.md](../expo.md)). The example app's
sign-up:

<!-- snippet: examples/expo/app/src/screens.tsx#sign-up -->
```tsx
/** Sign up with an email address and a password, then prove the address with the emailed code. */
export function SignUpScreen(props: { onSignIn(): void }) {
  const signUp = useSignUp()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')

  switch (signUp.screen) {
    case null:
      return (
        <Screen title='Create an account'>
          <Field kind='email' label='Email' value={email} onChangeText={setEmail} />
          <Field kind='new-password' label='Password' value={password} onChangeText={setPassword} />
          <Problem error={signUp.error} />
          <Action
            label='Sign up'
            pending={signUp.isPending}
            onPress={() => void signUp.start({ email, password })}
          />
          <Action quiet label='I have an account' onPress={props.onSignIn} />
        </Screen>
      )
    case 'needs_email_verification':
      return (
        <Screen title='Check your email'>
          <Note>We sent a 6-digit code to {email}.</Note>
          <Field kind='code' label='Code' value={code} onChangeText={setCode} />
          <Problem error={signUp.error} />
          <Action
            label='Verify'
            pending={signUp.isPending}
            onPress={() => void signUp.verifyEmail({ code })}
          />
          <Action quiet label='Send a new code' onPress={() => void signUp.resendCode()} />
        </Screen>
      )
    case 'complete':
      // The client is signed in by now, and the app shows its signed-in screen instead.
      return null
    default:
      return <NotSupported onBack={signUp.reset} />
  }
}
```
<!-- /snippet -->

Reference: [`@tula/core`](../reference/core.md), [`@tula/react`](../reference/react.md),
[`@tula/nextjs`](../reference/nextjs.md), [`@tula/expo`](../reference/expo.md).

## Troubleshooting

| Code | What it means and what to do |
| --- | --- |
| `auth.invalid_credentials` | Wrong password or unknown address; the answer is the same on purpose. |
| `auth.method_disabled` | The password method is off for this environment. Switch it on, or offer the methods `GET /v1/client/config` lists. |
| `password.too_short` | One of the `password.*` codes: the new password breaks a rule of the policy. The response's `errors` list names each broken rule. |
| `password.breached` | The password is in a known breach (or the common-password list). Choose another. |
| `password.reused` | The new password is the user's current one or one of the last `params.history` they had (`password.history` in the policy). Choose one that was not used before. Nothing says which one matched. A password that replaces an expired one gets it for the expired password itself, whatever the history. |
| `flow.invalid_step` | On `…/new-password`: the sign-in is not waiting for a new password, or the account's password was replaced some other way since the attempt proved it (also by this attempt's own earlier request, whose answer was an error after the password was stored). Start the sign-in again. |
| `service.unavailable` | On `…/new-password`, among its other causes: the new password was stored and the user's earlier sessions could not be ended. Nobody was signed in. Sign in again with the new password; an administrator ends the earlier sessions (`DELETE /v1/admin/users/{userId}/sessions`). |
| `password.not_set` | The account has no password (it signed up without one or with a provider). "Forgot password" gives it one. |
| `verification.invalid_code` | Wrong emailed code; `params` says how many attempts are left. |
| `verification.too_many_attempts` | The code is spent. Ask for a new one. |
| `verification.expired` | The code is too old. Ask for a new one. |
| `flow.not_found` | The attempt expired (ten minutes), or the call did not come from the client that started it. Start again. |
| `request.origin_not_allowed` | The page's origin is not in `urls.allowedOrigins`. Add it exactly: scheme, host and port. |
| `rate_limited` | Too many tries or emails. Wait for `Retry-After`. |
