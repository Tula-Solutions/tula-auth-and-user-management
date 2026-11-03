import { isStepUpRequired, type OrganizationSsoConnection, type TulaError } from '@tula-tech/core'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTulaContext } from '../context'
import { toTulaError } from '../errors'
import { useStepUp } from '../hooks/use-step-up'
import { formatText } from '../localization'
import { placeErrors } from './form-errors'
import type { OrganizationSectionProps } from './organization-general'
import {
  Confirmation,
  isAccessChanged,
  organizationFieldResolver,
  useActions,
  useGuard,
} from './organization-shared'
import { Button, Form, FormError, Heading, Status, TextField, useUi } from './ui'

const FIELDS = ['name', 'issuer', 'clientId', 'clientSecret'] as const

/** One connection: its state, what can be done to it, and "Delete", which asks first. */
function ConnectionRow(props: {
  connection: OrganizationSsoConnection
  busy: string | null
  removing: boolean
  onPatch(patch: { status?: 'active' | 'disabled'; enforced?: boolean }): void
  onAskRemove(): void
  onCancelRemove(): void
  onRemove(): void
}) {
  const { el, t } = useUi()
  const { connection: c } = props
  const status =
    c.status === 'active'
      ? t.organizationProfile.ssoStatusActive
      : c.status === 'draft'
        ? t.organizationProfile.ssoStatusDraft
        : c.status === 'disabled'
          ? t.organizationProfile.ssoStatusDisabled
          : t.organizationProfile.modeUnknown
  const name = { name: c.name }
  const idle = props.busy === null
  return (
    <li {...el('ssoItem')}>
      <div className='tula-session-text'>
        <p className='tula-session-device'>
          <span>{c.name}</span>{' '}
          <span {...el('badge', c.status === 'active' && 'tula-is-positive')}>{status}</span>
          {c.enforced ? (
            <>
              {' '}
              <span {...el('badge')}>{t.organizationProfile.ssoEnforcedBadge}</span>
            </>
          ) : null}
        </p>
        <p className='tula-session-meta'>
          {c.clientSecretSet
            ? t.organizationProfile.ssoSecretSet
            : t.organizationProfile.ssoNoSecret}
        </p>
      </div>
      <div className='tula-button-row tula-is-compact'>
        <Button
          kind='secondary'
          disabled={!idle}
          onClick={() => props.onPatch({ status: c.status === 'active' ? 'disabled' : 'active' })}
        >
          {formatText(
            c.status === 'active'
              ? t.organizationProfile.ssoTurnOff
              : t.organizationProfile.ssoTurnOn,
            name
          )}
        </Button>
        <Button
          kind='secondary'
          disabled={!idle}
          onClick={() => props.onPatch({ enforced: !c.enforced })}
        >
          {formatText(
            c.enforced ? t.organizationProfile.ssoUnenforce : t.organizationProfile.ssoEnforce,
            name
          )}
        </Button>
        <Button kind='danger' disabled={!idle || props.removing} onClick={props.onAskRemove}>
          {formatText(t.organizationProfile.ssoDelete, name)}
        </Button>
      </div>
      {props.removing ? (
        <Confirmation
          question={formatText(t.organizationProfile.ssoDeleteConfirm, name)}
          confirmLabel={t.organizationProfile.ssoDeleteConfirmButton}
          cancelLabel={t.organizations.cancel}
          pending={props.busy === `remove:${c.id}`}
          onConfirm={props.onRemove}
          onCancel={props.onCancelRemove}
        />
      ) : null}
    </li>
  )
}

/**
 * The "Single sign-on" tab of `<OrganizationProfile>`: the organization's enterprise sign-in
 * connections. A member whose role holds `org:sys:sso:manage` adds an OIDC connection (it starts
 * as a draft), turns it on or off, requires it, and deletes it. The client secret is typed into a
 * password field, sent once and dropped from state: no answer ever returns it, so the list says
 * only whether one is saved.
 *
 * Switching enforcement off is a weakening the server asks a recent sign-in for
 * (`auth.step_up_required`); the provider's step-up dialog is shown and the call repeated. SAML
 * connections and the group-to-role mapping are managed through `@tula-tech/core`'s
 * `organizations.sso` or the dashboard.
 *
 * @returns The section.
 */
export function SsoSection(props: OrganizationSectionProps) {
  const { el, t } = useUi()
  const { client } = useTulaContext()
  const withStepUp = useStepUp()
  const organizationId = props.organization.id
  const guard = useGuard()
  const actions = useActions(props.onAccessChanged)
  const titleId = useId()
  const [connections, setConnections] = useState<OrganizationSsoConnection[] | null>(null)
  const [loadError, setLoadError] = useState<TulaError | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', issuer: '', clientId: '', clientSecret: '' })
  const [missing, setMissing] = useState<Record<string, boolean>>({})
  const changed = useRef(props.onAccessChanged)
  changed.current = props.onAccessChanged
  const createError = actions.failed === 'create' ? actions.error : null
  const placed = placeErrors(createError, organizationFieldResolver(FIELDS))

  const load = useCallback(async () => {
    const current = guard()
    try {
      const list = await client.organizations.sso.list(organizationId)
      if (current()) {
        setConnections(list.connections)
        setLoadError(null)
      }
    } catch (caught) {
      if (current()) {
        const failure = toTulaError(caught)
        setLoadError(failure)
        if (isAccessChanged(failure)) {
          changed.current()
        }
      }
    }
  }, [client, organizationId, guard])
  useEffect(() => {
    void load()
  }, [load])

  const set = (key: keyof typeof form) => (value: string) => {
    setForm((current) => ({ ...current, [key]: value }))
    setMissing((current) => ({ ...current, [key]: false }))
  }
  const create = () => {
    const input = {
      name: form.name.trim(),
      issuer: form.issuer.trim(),
      clientId: form.clientId.trim(),
      clientSecret: form.clientSecret,
    }
    const absent = {
      name: input.name === '',
      issuer: input.issuer === '',
      clientId: input.clientId === '',
      clientSecret: input.clientSecret === '',
    }
    setMissing(absent)
    if (Object.values(absent).some(Boolean)) {
      return
    }
    void actions.run('create', async (current) => {
      try {
        await client.organizations.sso.create(organizationId, { protocol: 'oidc', ...input })
      } finally {
        // The secret never outlives the call, whatever its outcome.
        setForm((value) => ({ ...value, clientSecret: '' }))
      }
      await load()
      if (current()) {
        setForm({ name: '', issuer: '', clientId: '', clientSecret: '' })
      }
      return formatText(t.organizationProfile.ssoAdded, { name: input.name })
    })
  }
  const patch = (
    entry: OrganizationSsoConnection,
    body: { status?: 'active' | 'disabled'; enforced?: boolean }
  ) =>
    actions.run(`patch:${entry.id}`, async () => {
      try {
        await withStepUp(() => client.organizations.sso.update(organizationId, entry.id, body))
      } catch (caught) {
        if (isStepUpRequired(caught)) {
          // The user closed the step-up dialog: they chose, so nothing is said.
          return
        }
        throw caught
      }
      await load()
      return formatText(t.organizationProfile.ssoUpdated, { name: entry.name })
    })
  const remove = (entry: OrganizationSsoConnection) =>
    actions.run(`remove:${entry.id}`, async (current) => {
      await client.organizations.sso.remove(organizationId, entry.id)
      await load()
      if (current()) {
        setRemoving(null)
      }
      return formatText(t.organizationProfile.ssoDeleted, { name: entry.name })
    })
  const rowError = actions.failed === 'create' ? null : actions.error

  return (
    <section {...el('section')} aria-labelledby={titleId}>
      <Heading offset={1} {...el('sectionTitle')} id={titleId}>
        {t.organizationProfile.ssoTitle}
      </Heading>
      <p className='tula-text'>{t.organizationProfile.ssoIntro}</p>
      <FormError message={loadError?.message ?? rowError?.message ?? null} />
      {connections === null ? (
        <p className='tula-text'>{loadError ? null : t.organizationProfile.ssoLoading}</p>
      ) : connections.length === 0 ? (
        <p className='tula-text'>{t.organizationProfile.ssoEmpty}</p>
      ) : (
        <ul {...el('ssoList')}>
          {connections.map((entry) => (
            <ConnectionRow
              key={entry.id}
              connection={entry}
              busy={actions.busy}
              removing={removing === entry.id}
              onPatch={(body) => void patch(entry, body)}
              onAskRemove={() => {
                actions.setError(null)
                setRemoving(entry.id)
              }}
              onCancelRemove={() => {
                setRemoving(null)
                actions.setError(null)
              }}
              onRemove={() => void remove(entry)}
            />
          ))}
        </ul>
      )}
      {loadError && connections === null ? (
        <Button kind='secondary' onClick={() => void load()}>
          {t.organizations.retry}
        </Button>
      ) : null}
      <Form
        onSubmit={create}
        failure={Object.values(missing).some(Boolean) ? missing : createError}
        blocked={actions.busy !== null}
      >
        <FormError message={placed.form} />
        {(
          [
            ['name', t.organizationProfile.ssoNameLabel, 'off'],
            ['issuer', t.organizationProfile.ssoIssuerLabel, 'off'],
            ['clientId', t.organizationProfile.ssoClientIdLabel, 'off'],
            ['clientSecret', t.organizationProfile.ssoClientSecretLabel, 'off'],
          ] as const
        ).map(([key, label, autoComplete]) => (
          <TextField
            key={key}
            label={label}
            name={`sso-${key}`}
            type={key === 'clientSecret' ? 'password' : 'text'}
            autoComplete={autoComplete}
            autoCapitalize='none'
            autoCorrect='off'
            spellCheck={false}
            value={form[key]}
            onValue={set(key)}
            errors={[
              ...(missing[key] ? [t.organizationProfile.ssoFieldRequired] : []),
              ...(placed.fields[key] ?? []),
            ]}
            required
          />
        ))}
        <div className='tula-button-row tula-is-compact'>
          <Button type='submit' pending={actions.busy === 'create'}>
            {t.organizationProfile.ssoAdd}
          </Button>
        </div>
      </Form>
      <Status message={actions.message} />
    </section>
  )
}
