import {
  MAX_PASSWORD_HISTORY,
  MIN_PASSWORD_MIN_LENGTH,
  PASSWORD_POLICY_PRESETS,
} from '@tula/contract'
import type { PasswordPolicy } from '~/api/generated/api.gen'
import { SelectField, SwitchRow, TextField } from '~/components/field'
import { Section } from '~/components/page'
import { NativeSelectOption } from '~/components/ui/native-select'
import { numberOrNull, wholeNumber } from './inputs'
import { type SettingsEditor, SettingsFrame } from './settings-editor'

const PRESETS = ['recommended', 'strict', 'legacy', 'custom'] as const
const RULES = [
  ['requireLowercase', 'Require a lowercase letter'],
  ['requireUppercase', 'Require an uppercase letter'],
  ['requireNumber', 'Require a number'],
  ['requireSpecial', 'Require a special character'],
  ['disallowUserInfo', 'Refuse passwords that contain the user’s name or email'],
  ['disallowCommon', 'Refuse common passwords'],
  ['blockSequences', 'Refuse sequences such as “abcd” or “1234”'],
] as const

function PolicyFields({ draft, update, errors }: SettingsEditor) {
  const policy = draft.password
  if (!policy) {
    return null
  }
  // Any hand edit makes the policy a custom one: the preset's name must not claim values it
  // no longer has.
  function set(change: Partial<PasswordPolicy>) {
    update((current) => ({
      ...current,
      password: { ...(current.password as PasswordPolicy), preset: 'custom', ...change },
    }))
  }
  return (
    <>
      <Section
        title='Preset'
        description='Start from a preset, or adjust the rules below (which makes the policy “custom”).'
      >
        <SelectField
          label='Policy preset'
          value={policy.preset}
          error={errors['password.preset']}
          onChange={(event) => {
            const preset = event.target.value as PasswordPolicy['preset']
            if (preset === 'custom') {
              set({})
            } else {
              update((current) => ({
                ...current,
                password: { ...PASSWORD_POLICY_PRESETS[preset] },
              }))
            }
          }}
        >
          {PRESETS.map((preset) => (
            <NativeSelectOption key={preset} value={preset}>
              {preset.charAt(0).toUpperCase() + preset.slice(1)}
            </NativeSelectOption>
          ))}
        </SelectField>
      </Section>
      <Section title='Length'>
        <div className='grid gap-4 sm:grid-cols-2'>
          <TextField
            label='Minimum length'
            type='number'
            inputMode='numeric'
            min={MIN_PASSWORD_MIN_LENGTH}
            value={policy.minLength}
            onChange={(event) => set({ minLength: wholeNumber(event.target.value) })}
            error={errors['password.minLength']}
            hint={`At least ${MIN_PASSWORD_MIN_LENGTH}.`}
          />
          <TextField
            label='Maximum length'
            type='number'
            inputMode='numeric'
            value={policy.maxLength}
            onChange={(event) => set({ maxLength: wholeNumber(event.target.value) })}
            error={errors['password.maxLength']}
          />
        </div>
      </Section>
      <Section title='Rules'>
        <div>
          {RULES.map(([key, label]) => (
            <SwitchRow
              key={key}
              label={label}
              checked={policy[key]}
              onChange={(checked) => set({ [key]: checked })}
            />
          ))}
        </div>
        <div className='grid gap-4 sm:grid-cols-2'>
          <TextField
            label='Kinds of character required'
            type='number'
            inputMode='numeric'
            min={0}
            max={4}
            value={policy.minCharacterClasses}
            onChange={(event) => set({ minCharacterClasses: wholeNumber(event.target.value) })}
            error={errors['password.minCharacterClasses']}
            hint='Out of lowercase, uppercase, numbers and special characters (0 to 4).'
          />
          <TextField
            label='Longest run of one character'
            type='number'
            inputMode='numeric'
            min={1}
            value={policy.maxRepeatedChars ?? ''}
            onChange={(event) => set({ maxRepeatedChars: numberOrNull(event.target.value) })}
            error={errors['password.maxRepeatedChars']}
            hint='Leave empty for no limit.'
          />
          <SelectField
            label='Breached-password check'
            value={policy.breachCheck}
            onChange={(event) =>
              set({ breachCheck: event.target.value as PasswordPolicy['breachCheck'] })
            }
            error={errors['password.breachCheck']}
            hint='“Block” refuses a password found in a known breach; “warn” accepts it and says so.'
          >
            <NativeSelectOption value='off'>Off</NativeSelectOption>
            <NativeSelectOption value='warn'>Warn</NativeSelectOption>
            <NativeSelectOption value='block'>Block</NativeSelectOption>
          </SelectField>
        </div>
      </Section>
      <Section title='History and expiry'>
        <div className='grid gap-4 sm:grid-cols-2'>
          <TextField
            label='Passwords remembered'
            type='number'
            inputMode='numeric'
            min={0}
            max={MAX_PASSWORD_HISTORY}
            value={policy.history}
            onChange={(event) => set({ history: wholeNumber(event.target.value) })}
            error={errors['password.history']}
            hint={`A user cannot set one of their last this many passwords again, the current one included (0 to ${MAX_PASSWORD_HISTORY}; 0 remembers none). Lowering it deletes the older ones for good; raising it cannot bring them back.`}
          />
          <TextField
            label='Password expires after (days)'
            type='number'
            inputMode='numeric'
            min={1}
            value={policy.expiryDays ?? ''}
            onChange={(event) => set({ expiryDays: numberOrNull(event.target.value) })}
            error={errors['password.expiryDays']}
            hint='A user who signs in with a password older than this sets a new one before they are signed in, counted from when the password was last set. Leave empty for passwords that do not expire.'
          />
        </div>
      </Section>
    </>
  )
}

/**
 * The password policy of an environment.
 *
 * @returns The screen.
 */
export function PasswordPolicyScreen() {
  return (
    <SettingsFrame
      title='Password policy'
      description='What a password must look like when a user sets one. Existing passwords are not rechecked.'
    >
      {(editor) => <PolicyFields {...editor} />}
    </SettingsFrame>
  )
}
