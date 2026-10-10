# Emailed code

A 6-digit code sent to the user's address: as a way to sign in beside or instead of the
password, and as the way in for accounts that signed up without a password. Off by default.
The reasoning is in [ADR 0024](../adr/0024-email-sign-in.md) and
[ADR 0007](../adr/0007-verification-codes.md).

## Switch it on

| Where | How |
| --- | --- |
| Dashboard | **Sign-in methods**: "emailed code", and whether a sign-up needs a password. |
| `tula.config.ts` | `signIn.methods.emailCode`, and `signUp.password: 'optional'` for sign-up without a password. |
| Admin API | `PUT /v1/admin/settings` ([self-host.md](../self-host.md#settings-of-an-environment)). |

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

Through the admin API, switching the code on and making the sign-up password optional:

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

`signUp.password: 'optional'` is refused unless the emailed code is on: the account could
never sign in.

## What the user sees

- With the password on as well: after the address, the password screen lists **Email me a
  code** under "Other ways to sign in". Nothing is sent until it is chosen.
- As the only method: the address leads straight to "Check your email".
- The code is typed where the sign-in started, on any device. A wrong code says how many
  attempts are left.
- **Sign-up without a password**: the password field is labelled optional. Such an account
  signs in by code, and can get a password later through "Forgot password".
- An address with no account sees the same screens and is sent a short notice with no code.

## Security properties and limits

- The first factors a sign-in offers depend only on the environment's settings, never on the
  address: the start does not look the address up, and asking for a code answers the same
  for every address.
- A code is stored as a keyed hash, works once, and counts against the same per-address
  lockout as the password.
- An address is emailed at most once a minute; asking sooner is `rate_limited` with
  `Retry-After` and sends nothing.
- A code issued for one purpose (verifying an address, a reset, a sign-in, a step-up) is never
  accepted for another.
- A user with two-step verification still gets the second step after the code.
- A code that proves an address for the first time removes a password the account already had
  (one an administrator set with `emailVerified: false`): whoever chose it did not prove the
  address. The owner is sent a notice where `notifications.passwordChanged` is on (with it
  off the removal is recorded in the audit log only) and sets a password of their own by a
  [reset](password.md).
- Mail goes through your `SMTP_URL`; `tula doctor` checks that the relay accepts a connection.

## SDK calls

`<SignIn>` and `<SignUp>` need no prop for this: they draw what the environment enables.

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

`@tula/core`:

<!-- snippet: examples/docs-snippets/core.ts#email-code -->
```ts
const flow = await tula.signIn.start({ identifier: email })
// flow.step: { status: 'needs_first_factor', strategies: [...] } where the method is on
await flow.prepareFirstFactor({ strategy: 'email_code' }) // sends the email
const step = await flow.attemptFirstFactor({ strategy: 'email_code', code })
```
<!-- /snippet -->

<!-- snippet: examples/docs-snippets/core.ts#passwordless-sign-up -->
```ts
// Where the environment's `signUp.password` is 'optional', a sign-up may leave it out.
const signUp = await tula.signUp.start({ email })
await signUp.verifyEmail({ code })
```
<!-- /snippet -->

`@tula/expo`, in the example app's sign-in screen: the code is asked for with a button,
never sent on arrival ([expo.md](../expo.md)).

<!-- snippet: examples/expo/app/src/screens.tsx#sign-in -->
```tsx
/** Sign in with a password, or with a code emailed to the address where the environment offers one. */
export function SignInScreen(props: { onSignUp(): void }) {
  const signIn = useSignIn()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const step = signIn.step

  switch (signIn.screen) {
    case null:
      return (
        <Screen title='Sign in'>
          <Field kind='email' label='Email' value={email} onChangeText={setEmail} />
          <Problem error={signIn.error} />
          <Action
            label='Continue'
            pending={signIn.isPending}
            onPress={() => void signIn.start({ identifier: email })}
          />
          <Action quiet label='Create an account' onPress={props.onSignUp} />
        </Screen>
      )
    case 'needs_password':
      return (
        <Screen title='Your password'>
          <Field kind='password' label='Password' value={password} onChangeText={setPassword} />
          <Problem error={signIn.error} />
          <Action
            label='Sign in'
            pending={signIn.isPending}
            onPress={() => void signIn.submitPassword({ password })}
          />
          <Action quiet label='Start again' onPress={signIn.reset} />
        </Screen>
      )
    case 'needs_first_factor': {
      // The server says which ways this environment offers; the app shows the ones it has.
      const offered = step?.status === 'needs_first_factor' ? step.strategies : []
      const emailed = step?.status === 'needs_first_factor' && step.prepared !== undefined
      return (
        <Screen title='Sign in'>
          {offered.includes('password') && !emailed ? (
            <>
              <Field kind='password' label='Password' value={password} onChangeText={setPassword} />
              <Action
                label='Sign in'
                pending={signIn.isPending}
                onPress={() => void signIn.submitPassword({ password })}
              />
            </>
          ) : null}
          {offered.includes('email_code') && !emailed ? (
            // Nothing is emailed on arrival: the user asks.
            <Action
              quiet
              label='Email me a code instead'
              onPress={() => void signIn.prepareFirstFactor({ strategy: 'email_code' })}
            />
          ) : null}
          {emailed ? (
            <>
              <Note>If {email} can sign in, a 6-digit code is on its way.</Note>
              <Field kind='code' label='Code' value={code} onChangeText={setCode} />
              <Action
                label='Sign in'
                pending={signIn.isPending}
                onPress={() => void signIn.attemptFirstFactor({ strategy: 'email_code', code })}
              />
            </>
          ) : null}
          <Problem error={signIn.error} />
          <Action quiet label='Start again' onPress={signIn.reset} />
        </Screen>
      )
    }
    case 'needs_email_verification':
      return (
        <Screen title='Check your email'>
          <Field kind='code' label='Code' value={code} onChangeText={setCode} />
          <Problem error={signIn.error} />
          <Action
            label='Verify'
            pending={signIn.isPending}
            onPress={() => void signIn.verifyEmail({ code })}
          />
        </Screen>
      )
    case 'complete':
      return null
    default:
      // A second step, an expired password, or a step from a newer server: this small
      // example has no screen for them and says so.
      return <NotSupported onBack={signIn.reset} />
  }
}
```
<!-- /snippet -->

Reference: [`@tula/core`](../reference/core.md), [`@tula/react`](../reference/react.md),
[`@tula/expo`](../reference/expo.md).

## Troubleshooting

| Code | What it means and what to do |
| --- | --- |
| `auth.method_disabled` | The emailed code is off, or was switched off while the attempt was open. A change takes up to 5 seconds to reach every API instance. |
| `verification.invalid_code` | Wrong code; `params` says how many attempts are left. |
| `verification.too_many_attempts` | The code is spent. Ask for a new one. |
| `verification.expired` | The code is too old. Ask for a new one. |
| `rate_limited` | The address was emailed less than a minute ago, or too many guesses. Wait for `Retry-After`. |
| `flow.not_found` | The attempt expired (ten minutes) or the call came from another client. Start again. |
| `validation.failed` | Usually a sign-up without a password where `signUp.password` is `required`. |

No email arriving is not an error code: check the relay with `tula doctor`
([cli.md](../cli.md#tula-doctor)) and the local inbox (Mailpit) in development.
