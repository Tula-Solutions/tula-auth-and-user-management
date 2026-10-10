import {
  BUILT_IN_SESSION_PROFILES,
  defaultDeviceBinding,
  isSessionProfileName,
  MAX_SESSIONS_PER_USER,
} from '@tula/contract'
import { useState } from 'react'
import type { SessionProfile } from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { SelectField, SwitchRow, TextField } from '~/components/field'
import { Section } from '~/components/page'
import { NativeSelectOption } from '~/components/ui/native-select'
import { numberOrNull, textOrNull } from './inputs'
import { JwtTemplatesSection } from './jwt-templates-section'
import { type SettingsEditor, SettingsFrame } from './settings-editor'

const DURATION_HINT = 'A number and a unit: 60s, 15m, 12h, 7d.'

function isBuiltIn(name: string): boolean {
  return (BUILT_IN_SESSION_PROFILES as readonly string[]).includes(name)
}

/** What a profile's device-binding option asks of a sign-in (ADR 0043). */
type DeviceBindingPolicy = NonNullable<SessionProfile['deviceBinding']>

const DEVICE_BINDING_EXISTING =
  'A change applies to new sign-ins only: a session that exists keeps the key it has, or goes on without one.'

/**
 * What the device-binding control says under itself: who the option reaches, and what a
 * change leaves alone. A browser is never bound, so the `web` profile and a stateful one
 * say that the value changes nothing for them.
 *
 * @param name - The profile's name.
 * @param profile - The profile as drafted.
 * @returns The hint.
 */
function deviceBindingHint(name: string, profile: SessionProfile): string {
  if (name === 'web') {
    return 'Only browsers use this profile, and a browser’s session is never bound to a device key: the value changes nothing here.'
  }
  if (profile.type === 'stateful') {
    return 'A stateful session is a browser’s, and is never bound to a device key: the value changes nothing while the type is stateful.'
  }
  return `For native apps: whether a session’s refreshes must be signed with a key held on the device. Browsers are not affected. ${DEVICE_BINDING_EXISTING}`
}

function ProfileCard({
  name,
  profile,
  templates,
  errors,
  onChange,
  onRemove,
}: {
  name: string
  profile: SessionProfile
  /** The names of the environment's JWT templates, as drafted. */
  templates: string[]
  errors: Record<string, string>
  onChange: (profile: SessionProfile) => void
  onRemove?: () => void
}) {
  const path = `sessions.profiles.${name}`
  return (
    <li className='flex flex-col gap-4 rounded-lg border p-4'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <h3 className='font-semibold'>
          <code>{name}</code>
          <span className='ml-2 text-xs font-normal text-muted-foreground'>
            {isBuiltIn(name) ? 'Built in' : 'Custom'}
          </span>
        </h3>
        {onRemove ? (
          <ActionButton
            variant='outline'
            size='sm'
            onClick={onRemove}
            aria-label={`Take out the ${name} profile`}
          >
            Take out
          </ActionButton>
        ) : null}
      </div>
      {errors[path] ? (
        <p role='alert' className='text-sm text-destructive'>
          {errors[path]}
        </p>
      ) : null}
      <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-3'>
        <SelectField
          label='Type'
          value={profile.type ?? 'hybrid'}
          onChange={(event) =>
            onChange({ ...profile, type: event.target.value as 'hybrid' | 'stateful' })
          }
          error={errors[`${path}.type`]}
          hint='Hybrid: short access token plus refresh. Stateful: a cookie checked on every request (web only).'
        >
          <NativeSelectOption value='hybrid'>Hybrid</NativeSelectOption>
          <NativeSelectOption value='stateful'>Stateful</NativeSelectOption>
        </SelectField>
        <TextField
          label='Access token lifetime'
          value={profile.accessTokenTtl ?? ''}
          onChange={(event) => onChange({ ...profile, accessTokenTtl: event.target.value.trim() })}
          error={errors[`${path}.accessTokenTtl`]}
          hint={DURATION_HINT}
        />
        <TextField
          label='Idle timeout'
          value={profile.idleTimeout ?? ''}
          onChange={(event) => onChange({ ...profile, idleTimeout: event.target.value.trim() })}
          error={errors[`${path}.idleTimeout`]}
          hint='The session ends after this long without use.'
        />
        <TextField
          label='Absolute timeout'
          value={profile.absoluteTimeout ?? ''}
          onChange={(event) =>
            onChange({ ...profile, absoluteTimeout: textOrNull(event.target.value) })
          }
          error={errors[`${path}.absoluteTimeout`]}
          hint='The session ends this long after sign-in. Empty: no limit.'
        />
        <TextField
          label='Step-up after'
          value={profile.stepUpAfter ?? ''}
          onChange={(event) =>
            onChange({ ...profile, stepUpAfter: textOrNull(event.target.value) })
          }
          error={errors[`${path}.stepUpAfter`]}
          hint='How recent a sign-in must be for sensitive changes. Empty: the default.'
        />
        <TextField
          label='Refresh reuse grace period'
          value={profile.refresh?.reuseGracePeriod ?? ''}
          onChange={(event) =>
            onChange({ ...profile, refresh: { reuseGracePeriod: textOrNull(event.target.value) } })
          }
          error={errors[`${path}.refresh.reuseGracePeriod`]}
          hint='10s to 60s. Empty: a refresh token works exactly once.'
        />
        <SelectField
          label='JWT template'
          value={profile.jwtTemplate ?? ''}
          onChange={(event) =>
            onChange({ ...profile, jwtTemplate: textOrNull(event.target.value) })
          }
          error={errors[`${path}.jwtTemplate`]}
          hint='The custom claims this profile’s sessions carry. Applies from each session’s next token.'
        >
          <NativeSelectOption value=''>None</NativeSelectOption>
          {/* A name the document holds but no template has: shown, so it is not changed unseen. */}
          {profile.jwtTemplate && !templates.includes(profile.jwtTemplate) ? (
            <NativeSelectOption value={profile.jwtTemplate}>
              {profile.jwtTemplate} (missing)
            </NativeSelectOption>
          ) : null}
          {templates.map((template) => (
            <NativeSelectOption key={template} value={template}>
              {template}
            </NativeSelectOption>
          ))}
        </SelectField>
        <SelectField
          label='Device binding'
          value={profile.deviceBinding ?? defaultDeviceBinding(name)}
          onChange={(event) =>
            onChange({ ...profile, deviceBinding: event.target.value as DeviceBindingPolicy })
          }
          error={errors[`${path}.deviceBinding`]}
          hint={deviceBindingHint(name, profile)}
        >
          <NativeSelectOption value='none'>None: a device key is refused</NativeSelectOption>
          <NativeSelectOption value='optional'>
            Optional: bound when the app sends a key
          </NativeSelectOption>
          <NativeSelectOption value='required'>
            Required: no sign-in without a key
          </NativeSelectOption>
        </SelectField>
      </div>
      <SwitchRow
        label='Clients may ask for this profile'
        description='Off: only the client’s kind decides the profile.'
        checked={profile.clientSelectable ?? false}
        onChange={(checked) => onChange({ ...profile, clientSelectable: checked })}
      />
    </li>
  )
}

function SessionFields({ draft, update, errors }: SettingsEditor) {
  const sessions = draft.sessions ?? {}
  // The generated type gives custom profile names an untyped value; every profile of the
  // document has the one shape.
  const profiles = (sessions.profiles ?? {}) as Record<string, SessionProfile>
  const [newName, setNewName] = useState('')
  const [nameProblem, setNameProblem] = useState<string>()

  function setProfiles(next: Record<string, SessionProfile>) {
    update((current) => ({ ...current, sessions: { ...current.sessions, profiles: next } }))
  }

  function addProfile() {
    const name = newName.trim()
    if (!isSessionProfileName(name)) {
      setNameProblem(
        'Use lowercase letters, digits and single “-”, starting with a letter (up to 32).'
      )
      return
    }
    if (Object.hasOwn(profiles, name)) {
      setNameProblem('A profile with that name exists.')
      return
    }
    setNameProblem(undefined)
    setNewName('')
    // A new profile starts as a copy of the web profile, so that adding one weakens nothing.
    // All but its device binding: the web profile's is `none` (a browser has no key), and a
    // profile an app can ask for must not ask less of a native sign-in than `mobile` does.
    setProfiles({
      ...profiles,
      [name]: {
        ...structuredClone(profiles.web ?? {}),
        deviceBinding: profiles.mobile?.deviceBinding ?? defaultDeviceBinding(name),
      },
    })
  }

  return (
    <>
      <Section
        title='Profiles'
        description='A profile decides how long a session lives. “web” and “mobile” are chosen by the kind of client; a custom profile is asked for by name.'
      >
        <ul className='flex flex-col gap-4'>
          {Object.entries(profiles).map(([name, profile]) => (
            <ProfileCard
              key={name}
              name={name}
              profile={profile}
              templates={Object.keys(sessions.jwtTemplates ?? {})}
              errors={errors}
              onChange={(next) => setProfiles({ ...profiles, [name]: next })}
              onRemove={
                isBuiltIn(name)
                  ? undefined
                  : () =>
                      setProfiles(
                        Object.fromEntries(
                          Object.entries(profiles).filter(([entry]) => entry !== name)
                        )
                      )
              }
            />
          ))}
        </ul>
        {errors['sessions.profiles'] ? (
          <p role='alert' className='text-sm text-destructive'>
            {errors['sessions.profiles']}
          </p>
        ) : null}
        <div className='flex flex-wrap items-end gap-2'>
          <TextField
            label='New profile name'
            className='min-w-0 flex-1 sm:max-w-xs'
            autoComplete='off'
            spellCheck={false}
            placeholder='admin'
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                addProfile()
              }
            }}
            error={nameProblem}
          />
          <ActionButton variant='outline' onClick={addProfile}>
            Add profile
          </ActionButton>
        </div>
      </Section>
      <JwtTemplatesSection draft={draft} update={update} errors={errors} />
      <Section title='Limits' description='How many sessions one user may have at the same time.'>
        <div className='grid gap-4 sm:grid-cols-2'>
          <TextField
            label='Sessions per user'
            type='number'
            inputMode='numeric'
            min={1}
            max={MAX_SESSIONS_PER_USER}
            value={sessions.maxPerUser ?? ''}
            onChange={(event) =>
              update((current) => ({
                ...current,
                sessions: { ...current.sessions, maxPerUser: numberOrNull(event.target.value) },
              }))
            }
            error={errors['sessions.maxPerUser']}
            hint={`1 to ${MAX_SESSIONS_PER_USER}. Empty: no limit.`}
          />
          <SelectField
            label='When the limit is reached'
            value={sessions.onLimit ?? 'end_oldest'}
            onChange={(event) =>
              update((current) => ({
                ...current,
                sessions: {
                  ...current.sessions,
                  onLimit: event.target.value as 'end_oldest' | 'refuse_newest',
                },
              }))
            }
            error={errors['sessions.onLimit']}
          >
            <NativeSelectOption value='end_oldest'>End the oldest session</NativeSelectOption>
            <NativeSelectOption value='refuse_newest'>Refuse the new sign-in</NativeSelectOption>
          </SelectField>
        </div>
      </Section>
    </>
  )
}

/**
 * Session profiles, JWT templates (ADR 0036) and the concurrent-session rule of an
 * environment (ADR 0028).
 *
 * @returns The screen.
 */
export function SessionProfilesScreen() {
  return (
    <SettingsFrame
      title='Session profiles'
      description='How long sessions last, which custom claims they carry, whether a native app’s session is bound to a device key, and how many a user may have. Changes apply to sessions that already exist, except device binding, which is decided when a session is made.'
    >
      {(editor) => <SessionFields {...editor} />}
    </SettingsFrame>
  )
}
