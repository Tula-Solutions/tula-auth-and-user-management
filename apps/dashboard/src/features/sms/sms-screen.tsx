import { DEFAULT_SMS_DAILY_MESSAGE_LIMIT, MAX_SMS_DAILY_MESSAGE_LIMIT } from '@tula/contract'
import { CircleCheck, TriangleAlert } from 'lucide-react'
import { useId, useState } from 'react'
import { useGetInstanceDiagnostics } from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { SwitchRow, TextField } from '~/components/field'
import { Section } from '~/components/page'
import { Label } from '~/components/ui/label'
import { NativeSelect, NativeSelectOption } from '~/components/ui/native-select'
import { numberOrNull } from '~/features/settings/inputs'
import { type SettingsEditor, SettingsFrame } from '~/features/settings/settings-editor'
import { EnvironmentLink } from '~/features/shell/environment-link'
import { ENVIRONMENT_PATH } from '~/features/shell/sections'
import { cn } from '~/lib/utils'
import {
  countryChoices,
  countryEntry,
  hourlySentence,
  SMS_SENDER_CHECK,
  withCountry,
} from './model'
import { SmsUsageSection } from './usage'

const STATUS_WORDS = { ok: 'OK', warn: 'Warning', fail: 'Failing', skipped: 'Skipped' } as const

/**
 * What the deployment says about its SMS sender: the `sms_sender` check of the diagnostics,
 * in the server's own words.
 *
 * Whether a deployment can send is not a setting, so the settings document does not say it;
 * the diagnostics do, and the screen repeats their answer instead of working one out. Any
 * status but `ok` is drawn as a warning with the server's fix.
 *
 * @returns The note.
 */
export function SenderNote() {
  // A minute old is recent enough for a note: a run reads every environment's settings.
  const diagnostics = useGetInstanceDiagnostics({ query: { staleTime: 60_000 } })
  const check = diagnostics.data?.checks.find((entry) => entry.id === SMS_SENDER_CHECK)
  const always =
    'A text message leaves only a deployment that has an SMS sender (SMS_PROVIDER), whatever is saved here. These settings can be edited either way.'
  if (check === undefined) {
    return (
      <div className='flex flex-col gap-1 rounded-lg border border-input bg-card p-4 text-sm'>
        <p className='font-semibold' role='status'>
          {diagnostics.isPending
            ? 'Asking the deployment whether it can send text messages…'
            : 'Whether this deployment can send text messages could not be read.'}
        </p>
        <p>
          {always}{' '}
          {diagnostics.isPending ? null : (
            <>
              The <code>{SMS_SENDER_CHECK}</code> check under Diagnostics says whether it has one.
            </>
          )}
        </p>
      </div>
    )
  }
  const ok = check.status === 'ok'
  const Icon = ok ? CircleCheck : TriangleAlert
  return (
    <div
      role='note'
      data-sender={check.status}
      className={cn(
        'flex flex-col gap-1.5 rounded-lg border p-4 text-sm',
        ok ? 'border-input bg-card' : 'border-destructive bg-destructive-surface'
      )}
    >
      <p className='flex items-center gap-2 font-semibold'>
        <Icon aria-hidden='true' className='size-4 shrink-0' />
        SMS sender of this deployment: {STATUS_WORDS[check.status]}
      </p>
      <p>{check.summary}</p>
      {check.fix ? (
        <p>
          <span className='font-semibold'>Fix: </span>
          {check.fix}
        </p>
      ) : null}
      <p>
        This is the <code>{SMS_SENDER_CHECK}</code> check of the deployment’s diagnostics, about the
        settings as saved, in every environment. {always}
      </p>
    </div>
  )
}

/**
 * The countries text messages may go to: a set, chosen from the contract's list. Nothing
 * typed becomes a country.
 */
function CountryList({
  values,
  onChange,
  error,
}: {
  values: readonly string[]
  onChange: (values: string[]) => void
  error: string | undefined
}) {
  const id = useId()
  const [choice, setChoice] = useState('')
  const [problem, setProblem] = useState<string>()
  const title = 'Countries text messages may go to'

  function add() {
    if (choice === '') {
      setProblem('Choose the country to add.')
      return
    }
    setProblem(undefined)
    onChange(withCountry(values, choice))
    setChoice('')
  }

  const shown = problem ?? error
  return (
    <div className='flex flex-col gap-2'>
      <p id={`${id}-title`} className='text-sm font-medium'>
        {title}
      </p>
      {values.length === 0 ? (
        <p className='text-sm font-medium' data-countries='none'>
          No country is listed: no text message is sent, whether or not the switch above is on. An
          empty list never means every country.
        </p>
      ) : (
        <ul className='flex flex-col gap-1.5' aria-labelledby={`${id}-title`}>
          {values.map((code) => {
            const country = countryEntry(code)
            return (
              <li
                key={code}
                className='flex items-center justify-between gap-3 rounded-md border px-3 py-1.5 text-sm'
              >
                <span className='flex min-w-0 flex-col'>
                  <span>
                    {country.name} <code>{country.code}</code>
                    <span className='text-muted-foreground'> · numbers starting </span>
                    <bdi dir='ltr'>
                      <code>{country.prefixes}</code>
                    </bdi>
                  </span>
                  {country.sharedWith.length > 0 ? (
                    <span className='text-xs text-muted-foreground'>
                      Also allows {country.sharedWith.join(', ')}: the same prefix, which cannot be
                      told apart.
                    </span>
                  ) : null}
                </span>
                <ActionButton
                  variant='ghost'
                  size='sm'
                  onClick={() => onChange(values.filter((entry) => entry !== code))}
                  aria-label={`Take out ${country.name} (${country.code})`}
                >
                  Take out
                </ActionButton>
              </li>
            )
          })}
        </ul>
      )}
      <Label htmlFor={id}>Add a country</Label>
      <div className='flex flex-wrap gap-2'>
        <div className='min-w-0 flex-1 [&>[data-slot=native-select-wrapper]]:w-full'>
          <NativeSelect
            id={id}
            className='w-full bg-field'
            value={choice}
            onChange={(event) => {
              setChoice(event.target.value)
              setProblem(undefined)
            }}
            aria-invalid={shown ? true : undefined}
            aria-describedby={`${id}-hint ${id}-error`}
          >
            <NativeSelectOption value=''>Choose a country…</NativeSelectOption>
            {countryChoices(values).map((country) => (
              <NativeSelectOption key={country.code} value={country.code}>
                {country.name} ({country.code}, {country.prefixes})
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <ActionButton variant='outline' onClick={add}>
          Add country
        </ActionButton>
      </div>
      <p id={`${id}-hint`} className='text-xs text-muted-foreground'>
        A country is its calling prefix: countries that share one count as one destination. Taking a
        country out stops messages to its numbers as soon as it is saved: a user there whose only
        second step is a texted code can no longer sign in until the country is back or their
        two-step verification is reset, a texted sign-in code is no longer sent to them, and they
        cannot add or prove a phone number.
      </p>
      <p id={`${id}-error`} role='alert' className='text-sm text-destructive'>
        {shown}
      </p>
    </div>
  )
}

/** What this draft has of what a texted code needs, in words. Only what the document says. */
function reach(sms: SettingsEditor['draft']['sms'], nobody: string): string {
  if (!sms?.enabled) {
    return `Text messages are off above: ${nobody} until they are on.`
  }
  const countries = sms.allowedCountries?.length ?? 0
  if (countries === 0) {
    return `No country is listed above: ${nobody} until one is.`
  }
  return `Text messages are on, to ${countries} ${countries === 1 ? 'country' : 'countries'}.`
}

function SmsFields({ draft, update, errors }: SettingsEditor) {
  const sms = draft.sms
  const limit = sms?.dailyMessageLimit
  const hourly = hourlySentence(limit, MAX_SMS_DAILY_MESSAGE_LIMIT)
  const signInRefusal = errors['signIn.methods'] ?? errors.signIn
  return (
    <>
      <SenderNote />
      <Section
        title='Sending'
        description='Whether this environment sends text messages (SMS), to which countries, and how many in a day at most. A user can then add a phone number to their account and prove it with a texted code.'
      >
        <div>
          <SwitchRow
            label='Send text messages'
            description='A message costs money. With this off, or with no country listed below, nothing is sent.'
            checked={sms?.enabled ?? false}
            onChange={(enabled) =>
              update((current) => ({ ...current, sms: { ...current.sms, enabled } }))
            }
          />
        </div>
        <CountryList
          values={sms?.allowedCountries ?? []}
          onChange={(allowedCountries) =>
            update((current) => ({ ...current, sms: { ...current.sms, allowedCountries } }))
          }
          error={errors['sms.allowedCountries'] ?? errors.sms}
        />
        <TextField
          label='Most text messages in a day'
          className='sm:max-w-md'
          type='number'
          inputMode='numeric'
          min={1}
          max={MAX_SMS_DAILY_MESSAGE_LIMIT}
          value={limit ?? ''}
          onChange={(event) =>
            update((current) => ({
              ...current,
              sms: {
                ...current.sms,
                // Empty is left out, and the server then stores the default.
                dailyMessageLimit: numberOrNull(event.target.value) ?? undefined,
              },
            }))
          }
          error={errors['sms.dailyMessageLimit']}
          hint={`1 to ${MAX_SMS_DAILY_MESSAGE_LIMIT.toLocaleString('en')}. Empty: ${DEFAULT_SMS_DAILY_MESSAGE_LIMIT}. Once that many were sent in a day (UTC) nothing more is sent until the next. It counts messages, not segments and not money: a long message is billed as several segments, and what one costs depends on the destination and on your provider. It is a ceiling on what a day can cost only together with your provider’s prices. There is no value that switches it off.`}
        />
        {hourly ? (
          <p className='text-sm text-muted-foreground' data-limits='hourly'>
            {hourly} These follow from the daily limit and are not settings of their own.
          </p>
        ) : null}
      </Section>
      <Section
        title='What a texted code may do'
        description='Proving a phone number on an account needs neither of these. Each of them lets whoever receives the messages of a user’s number (a swapped SIM, a recycled number) do what the user can.'
      >
        <div>
          <SwitchRow
            label='Sign in with a texted code'
            description={`A six-digit code texted to a phone number, for the one account that has proven it: no password and no inbox. It cannot be the only way to sign in (nobody can sign up with one): keep another method or an OAuth provider on. ${reach(sms, 'nobody can sign in this way')}`}
            checked={draft.signIn?.methods?.smsCode?.enabled ?? false}
            onChange={(enabled) =>
              update((current) => ({
                ...current,
                signIn: {
                  ...current.signIn,
                  methods: { ...current.signIn?.methods, smsCode: { enabled } },
                },
              }))
            }
          />
          <SwitchRow
            label='Texted code as the second step'
            description={`Lets a user with a proven phone number, and no authenticator app or passkey, be asked for a texted code after their password. It is the weakest second step, so a user who has an authenticator app or a passkey is never asked for a text instead. Update the Tula SDKs in your apps before switching it on: an older sign-in screen cannot draw this step. Switching it off later does not skip the step for users whose only second step it is: they cannot sign in until it is on again, or until their two-step verification is reset. ${reach(sms, 'nobody can use or set up this step')}`}
            checked={draft.mfa?.smsCode?.enabled ?? false}
            onChange={(enabled) =>
              update((current) => ({ ...current, mfa: { ...current.mfa, smsCode: { enabled } } }))
            }
          />
        </div>
        {signInRefusal ? (
          <p role='alert' className='text-sm font-medium text-destructive'>
            Not saved: {signInRefusal}. A texted code cannot be the only way to sign in: keep
            another method or an OAuth provider on under Sign-in methods.
          </p>
        ) : null}
        <p className='text-sm text-muted-foreground'>
          The other ways to sign in, and whether a second step is required, are under{' '}
          <EnvironmentLink to={`${ENVIRONMENT_PATH}/sign-in-methods`}>
            Sign-in methods
          </EnvironmentLink>
          . The words of a text message are under{' '}
          <EnvironmentLink to={`${ENVIRONMENT_PATH}/messages`}>Messages</EnvironmentLink>.
        </p>
      </Section>
    </>
  )
}

/**
 * Text messages of an environment: whether they are sent, where to and how many, what a
 * texted code may do, and the codes sent and never used by destination.
 *
 * A `SettingsFrame` over `sms`, `signIn.methods.smsCode` and `mfa.smsCode`: no save path of
 * its own, and what is asked about before a save is the contract's `settingsWeakenings`.
 *
 * @returns The screen.
 */
export function SmsScreen() {
  return (
    <SettingsFrame
      title='Text messages'
      description='Whether this environment sends text messages, to which countries, how many in a day, and what a texted code may be used for.'
      after={<SmsUsageSection />}
    >
      {(editor) => <SmsFields {...editor} />}
    </SettingsFrame>
  )
}
