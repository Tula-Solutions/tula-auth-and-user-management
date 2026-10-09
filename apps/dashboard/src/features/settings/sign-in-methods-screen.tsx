import { SelectField, SwitchRow, TextField } from '~/components/field'
import { Section } from '~/components/page'
import { NativeSelectOption } from '~/components/ui/native-select'
import { textOrNull } from './inputs'
import type { SettingsDocument } from './model'
import { OAuthProviders } from './oauth-providers'
import { type SettingsEditor, SettingsFrame } from './settings-editor'

type Methods = NonNullable<NonNullable<SettingsDocument['signIn']>['methods']>
type MethodName = keyof Methods

const METHODS: readonly { name: MethodName; label: string; description: string }[] = [
  {
    name: 'password',
    label: 'Email and password',
    description: 'Checked against the password policy.',
  },
  {
    name: 'emailCode',
    label: 'Emailed code',
    description: 'A six-digit code sent to the user’s address.',
  },
  {
    name: 'emailLink',
    label: 'Emailed link',
    description: 'A link that signs in the browser that asked for it.',
  },
  { name: 'passkey', label: 'Passkeys', description: 'Needs the relying-party domain below.' },
  {
    name: 'smsCode',
    label: 'Texted code',
    description:
      'A six-digit code texted to a phone number, for the one account that has proven it. Whoever receives a number’s messages can enter that account. It cannot be the only way to sign in (nobody can sign up with one): keep another method or an OAuth provider on. Needs three things: text messages switched on, at least one country they may go to (both under Settings), and an SMS sender in the deployment (SMS_PROVIDER; the diagnostics say whether there is one).',
  },
]

/**
 * What this environment's draft has of what a texted sign-in code needs, in words.
 *
 * Only what the settings document says: whether the deployment has a sender is not in it,
 * and the screen does not ask.
 *
 * @param sms - The draft's `sms` settings.
 * @returns One sentence.
 */
function textMessagesInWords(sms: SettingsDocument['sms']): string {
  if (!sms?.enabled) {
    return 'Text messages are off in this environment: nobody can sign in this way until they are on.'
  }
  const countries = sms.allowedCountries?.length ?? 0
  if (countries === 0) {
    return 'No country is listed for text messages in this environment: nobody can sign in this way until one is.'
  }
  return `Text messages are on, to ${countries} ${countries === 1 ? 'country' : 'countries'}.`
}

function MethodFields({ draft, update, errors }: SettingsEditor) {
  const methods = draft.signIn?.methods ?? {}
  function setMethod(name: MethodName, enabled: boolean) {
    update((current) => ({
      ...current,
      signIn: { ...current.signIn, methods: { ...current.signIn?.methods, [name]: { enabled } } },
    }))
  }
  const refusal = errors['signIn.methods'] ?? errors.signIn
  return (
    <>
      <Section title='Sign-in methods' description='How people may sign in to this environment.'>
        <div>
          {METHODS.map((method) => (
            <SwitchRow
              key={method.name}
              label={method.label}
              description={
                method.name === 'smsCode'
                  ? `${method.description} ${textMessagesInWords(draft.sms)}`
                  : method.description
              }
              checked={methods[method.name]?.enabled ?? false}
              onChange={(checked) => setMethod(method.name, checked)}
            />
          ))}
        </div>
        {refusal ? (
          <p role='alert' className='text-sm font-medium text-destructive'>
            Not saved: {refusal}. Keep one method or one OAuth provider enabled, or nobody could
            sign in. A texted code does not count: nobody can sign up with one.
          </p>
        ) : null}
        <TextField
          label='Passkey relying-party domain (rpId)'
          autoComplete='off'
          spellCheck={false}
          placeholder='example.com'
          value={draft.passkeys?.rpId ?? ''}
          onChange={(event) =>
            update((current) => ({
              ...current,
              passkeys: { rpId: textOrNull(event.target.value) },
            }))
          }
          error={errors['passkeys.rpId'] ?? errors.passkeys}
          hint='The domain passkeys belong to: your app’s domain, without scheme or port. Passkeys made for one domain do not work on another.'
        />
      </Section>
      <Section title='Sign-up and two-step verification'>
        <div className='grid gap-4 sm:grid-cols-2'>
          <SelectField
            label='Password at sign-up'
            value={draft.signUp?.password ?? 'required'}
            onChange={(event) =>
              update((current) => ({
                ...current,
                signUp: { password: event.target.value as 'required' | 'optional' },
              }))
            }
            error={errors['signUp.password']}
            hint='“Optional” lets someone sign up with only an emailed code or link.'
          >
            <NativeSelectOption value='required'>Required</NativeSelectOption>
            <NativeSelectOption value='optional'>Optional</NativeSelectOption>
          </SelectField>
          <SelectField
            label='Two-step verification'
            value={draft.mfa?.policy ?? 'optional'}
            onChange={(event) =>
              update((current) => ({
                ...current,
                mfa: { policy: event.target.value as 'off' | 'optional' | 'required' },
              }))
            }
            error={errors['mfa.policy']}
            hint='“Required” makes every user set it up at their next sign-in. “Off” hides setup, but users who already have it are still asked.'
          >
            <NativeSelectOption value='off'>Off</NativeSelectOption>
            <NativeSelectOption value='optional'>Optional</NativeSelectOption>
            <NativeSelectOption value='required'>Required</NativeSelectOption>
          </SelectField>
        </div>
      </Section>
    </>
  )
}

/**
 * Sign-in methods and OAuth providers of an environment.
 *
 * @returns The screen.
 */
export function SignInMethodsScreen() {
  return (
    <SettingsFrame
      title='Sign-in methods'
      description='Which ways of signing in are on, and what a sign-up and a second step need.'
      after={<OAuthProviders />}
    >
      {(editor) => <MethodFields {...editor} />}
    </SettingsFrame>
  )
}
