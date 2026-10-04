import {
  MAX_APP_NAME_LENGTH,
  MAX_AUDIT_RETENTION_DAYS,
  RedirectUrlSchema,
  WebOriginSchema,
} from '@tula/contract'
import type { ZodType } from 'zod'
import { SwitchRow, TextField } from '~/components/field'
import { Section } from '~/components/page'
import { ListEditor, numberOrNull, textOrNull } from './inputs'
import type { SettingsDocument } from './model'
import { type SettingsEditor, SettingsFrame } from './settings-editor'

type Notices = NonNullable<SettingsDocument['notifications']>

const NOTICES: readonly { name: keyof Notices; label: string }[] = [
  { name: 'passwordChanged', label: 'Their password was changed' },
  { name: 'newSignIn', label: 'A sign-in from a new device' },
  { name: 'mfaChanged', label: 'Two-step verification was changed' },
  { name: 'identityChanged', label: 'A sign-in method was linked or unlinked' },
]

/**
 * Check a list entry with one of the contract's schemas.
 *
 * @param schema - The contract's schema for one entry.
 * @returns A validator for {@link ListEditor}: the first problem, or `undefined`.
 */
export function entryValidator(schema: ZodType): (value: string) => string | undefined {
  return (value) => {
    const result = schema.safeParse(value)
    return result.success ? undefined : `This ${result.error.issues[0]?.message ?? 'is not valid'}.`
  }
}

function GeneralFields({ draft, update, errors }: SettingsEditor) {
  const notifications = draft.notifications ?? {}
  return (
    <>
      <Section
        title='Application'
        description='Shown to users in emails and on the sign-in screens.'
      >
        <div className='grid gap-4 sm:grid-cols-2'>
          <TextField
            label='App name'
            autoComplete='off'
            maxLength={MAX_APP_NAME_LENGTH}
            value={draft.app?.name ?? ''}
            onChange={(event) =>
              update((current) => ({
                ...current,
                app: { ...current.app, name: event.target.value },
              }))
            }
            error={errors['app.name']}
          />
          <TextField
            label='Support email (optional)'
            type='email'
            autoComplete='off'
            value={draft.app?.supportEmail ?? ''}
            onChange={(event) =>
              update((current) => ({
                ...current,
                app: { ...current.app, supportEmail: textOrNull(event.target.value) },
              }))
            }
            error={errors['app.supportEmail']}
            hint='Where a user is told to write when an email was not meant for them.'
          />
        </div>
      </Section>
      <Section
        title='Origins and redirect URLs'
        description='Which web pages may call the API with a browser session, and where a flow may send a user back to.'
      >
        <ListEditor
          label='Allowed origins'
          itemName='origin'
          placeholder='https://app.example.com'
          hint='Scheme and host only: no path. http is accepted for localhost.'
          values={draft.urls.allowedOrigins}
          onChange={(values) =>
            update((current) => ({ ...current, urls: { ...current.urls, allowedOrigins: values } }))
          }
          validate={entryValidator(WebOriginSchema)}
          error={errors['urls.allowedOrigins']}
        />
        <ListEditor
          label='Allowed redirect URLs'
          itemName='URL'
          placeholder='https://app.example.com/auth/callback'
          hint='Matched exactly: no wildcard and no prefix.'
          values={draft.urls.allowedRedirectUrls}
          onChange={(values) =>
            update((current) => ({
              ...current,
              urls: { ...current.urls, allowedRedirectUrls: values },
            }))
          }
          validate={entryValidator(RedirectUrlSchema)}
          error={errors['urls.allowedRedirectUrls']}
        />
      </Section>
      <Section
        title='Security notices'
        description='Emails that tell a user about a change to their account.'
      >
        <div>
          {NOTICES.map((notice) => (
            <SwitchRow
              key={notice.name}
              label={notice.label}
              checked={notifications[notice.name] ?? true}
              onChange={(checked) =>
                update((current) => ({
                  ...current,
                  notifications: { ...current.notifications, [notice.name]: checked },
                }))
              }
            />
          ))}
        </div>
      </Section>
      <Section title='Audit log'>
        <TextField
          label='Keep audit entries for (days)'
          className='sm:max-w-xs'
          type='number'
          inputMode='numeric'
          min={1}
          max={MAX_AUDIT_RETENTION_DAYS}
          value={draft.audit?.retentionDays ?? ''}
          onChange={(event) =>
            update((current) => ({
              ...current,
              audit: { retentionDays: numberOrNull(event.target.value) },
            }))
          }
          error={errors['audit.retentionDays']}
          hint={`1 to ${MAX_AUDIT_RETENTION_DAYS}. Empty: keep them for good.`}
        />
      </Section>
    </>
  )
}

/**
 * General settings of an environment: its name, URLs, notices and audit retention.
 *
 * @returns The screen.
 */
export function GeneralSettingsScreen() {
  return (
    <SettingsFrame
      title='Settings'
      description='The application’s name, the web addresses it trusts, and what it tells its users.'
    >
      {(editor) => <GeneralFields {...editor} />}
    </SettingsFrame>
  )
}
