# Password

An email address and a password: sign-up with an emailed verification code, sign-in, "forgot
password" and changing it in the account page. It is on by default.
The reasoning is in [ADR 0006](../adr/0006-passwords.md) (hashing and policy),
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

A password that is set, reset or changed is announced to the owner by email
(`notifications.passwordChanged`).

## Security properties and limits

- Passwords are hashed with Argon2id and checked against the policy only when they are set.
  `tula policy test` tries one against an environment's policy without sending it anywhere
  ([cli.md](../cli.md#tula-policy-test)).
- `password.minLength` cannot be set below 8. The `recommended` preset is length plus a breach
  check; `BREACH_CHECK=hibp` asks Have I Been Pwned with a 5-character hash prefix.
- Sign-in failures are always `auth.invalid_credentials`: nothing says whether the address has
  an account.
- Wrong guesses are counted per address and per client address; after too many the answer is
  `rate_limited` with `Retry-After`, for the right password too, until the lock lapses.
- A sign-up, sign-in or reset attempt lives ten minutes and is bound to the client that started
  it; a browser attempt is refused from an origin the environment does not allow.
- A reset stops at the second factor for a user who has one: an emailed code alone never gets
  past two-step verification.

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

Reference: [`@tula/core`](../reference/core.md), [`@tula/react`](../reference/react.md),
[`@tula/nextjs`](../reference/nextjs.md).

## Troubleshooting

| Code | What it means and what to do |
| --- | --- |
| `auth.invalid_credentials` | Wrong password or unknown address; the answer is the same on purpose. |
| `auth.method_disabled` | The password method is off for this environment. Switch it on, or offer the methods `GET /v1/client/config` lists. |
| `password.too_short` | One of the `password.*` codes: the new password breaks a rule of the policy. The response's `errors` list names each broken rule. |
| `password.breached` | The password is in a known breach (or the common-password list). Choose another. |
| `password.not_set` | The account has no password (it signed up without one or with a provider). "Forgot password" gives it one. |
| `verification.invalid_code` | Wrong emailed code; `params` says how many attempts are left. |
| `verification.too_many_attempts` | The code is spent. Ask for a new one. |
| `verification.expired` | The code is too old. Ask for a new one. |
| `flow.not_found` | The attempt expired (ten minutes), or the call did not come from the client that started it. Start again. |
| `request.origin_not_allowed` | The page's origin is not in `urls.allowedOrigins`. Add it exactly: scheme, host and port. |
| `rate_limited` | Too many tries or emails. Wait for `Retry-After`. |
