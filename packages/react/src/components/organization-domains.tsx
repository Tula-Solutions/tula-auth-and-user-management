import type { OrganizationDomain, TulaError } from '@tula-tech/core'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTulaContext } from '../context'
import { toTulaError } from '../errors'
import { useRetryCountdown } from '../hooks/use-countdown'
import { formatText } from '../localization'
import { digitsOnly } from './flow-screens'
import { attemptsLeft, placeErrors, rateLimitedAlert } from './form-errors'
import type { OrganizationSectionProps } from './organization-general'
import {
  Confirmation,
  isAccessChanged,
  organizationFieldResolver,
  SelectField,
  useActions,
  useGuard,
} from './organization-shared'
import { Button, EmailField, Form, FormError, Heading, Status, TextField, useUi } from './ui'

const FIELDS = ['domain', 'email', 'mode'] as const

/** The modes this version knows, in the order the select offers them. */
const MODES = ['suggest', 'auto_join'] as const

/** The six digits of a domain's emailed code. */
const CODE_LENGTH = 6

/**
 * One domain: its name, whether it is verified and, if so, what it does; if not, the field for
 * the emailed code. "Remove" asks first.
 */
function DomainRow(props: {
  domain: OrganizationDomain
  busy: string | null
  error: TulaError | null
  failed: string | null
  removing: boolean
  focusCode: boolean
  onVerify(code: string): void
  onMode(mode: OrganizationDomain['mode']): void
  onResend(): void
  onAskRemove(): void
  onCancelRemove(): void
  onRemove(): void
}) {
  const { el, t } = useUi()
  const { domain } = props
  const [code, setCode] = useState('')
  const [missing, setMissing] = useState(false)
  const field = useRef<HTMLDivElement>(null)
  const verified = domain.verifiedAt !== null
  const verifying = props.failed === `verify:${domain.id}` ? props.error : null
  const placed = placeErrors(verifying, organizationFieldResolver(['code']))
  const left = attemptsLeft(verifying, t)
  useEffect(() => {
    if (props.focusCode) {
      field.current?.querySelector('input')?.focus()
    }
  }, [props.focusCode])
  const known = (MODES as readonly string[]).includes(domain.mode)
  const options = [
    { value: 'suggest', label: t.organizationProfile.modeSuggest },
    { value: 'auto_join', label: t.organizationProfile.modeAutoJoin },
  ]
  if (!known) {
    // A mode a newer server invented: shown as what it is, not guessed at.
    options.unshift({ value: domain.mode, label: t.organizationProfile.modeUnknown })
  }
  const submit = () => {
    if (code.length !== CODE_LENGTH) {
      setMissing(true)
      return
    }
    setMissing(false)
    props.onVerify(code)
  }
  return (
    <li {...el('domainItem')}>
      <div className='tula-session-text'>
        <p className='tula-session-device'>
          <span>{domain.domain}</span>{' '}
          <span {...el('badge', verified && 'tula-is-positive')}>
            {verified ? t.organizationProfile.domainVerified : t.organizationProfile.domainPending}
          </span>
        </p>
      </div>
      <Button
        kind='danger'
        disabled={props.busy !== null || props.removing}
        aria-label={formatText(t.organizationProfile.domainRemoveLabel, {
          domain: domain.domain,
        })}
        onClick={props.onAskRemove}
      >
        {t.organizationProfile.domainRemove}
      </Button>
      {verified ? (
        <SelectField
          label={t.organizationProfile.domainModeLabel}
          value={domain.mode}
          options={options}
          busy={props.busy !== null}
          onValue={(mode) => props.onMode(mode as OrganizationDomain['mode'])}
        />
      ) : (
        <div ref={field} className='tula-confirmation'>
          <Form onSubmit={submit} failure={missing || verifying} blocked={props.busy !== null}>
            <FormError message={placed.form} />
            <TextField
              part='codeInput'
              label={formatText(t.organizationProfile.domainCodeLabel, { domain: domain.domain })}
              name={`domain-code-${domain.id}`}
              inputMode='numeric'
              autoComplete='one-time-code'
              maxLength={CODE_LENGTH + 2}
              value={code}
              onValue={(value) => {
                setCode(digitsOnly(value))
                setMissing(false)
              }}
              errors={[
                ...(missing ? [t.organizationProfile.domainCodeRequired] : []),
                ...(placed.fields.code ?? []),
              ]}
              hint={left ?? undefined}
              required
            />
            <div className='tula-button-row tula-is-compact'>
              <Button type='submit' pending={props.busy === `verify:${domain.id}`}>
                {t.organizationProfile.domainVerify}
              </Button>
              <Button kind='secondary' disabled={props.busy !== null} onClick={props.onResend}>
                {t.organizationProfile.domainResend}
              </Button>
            </div>
          </Form>
        </div>
      )}
      {props.removing ? (
        <Confirmation
          question={formatText(t.organizationProfile.domainRemoveConfirm, {
            domain: domain.domain,
          })}
          confirmLabel={t.organizationProfile.domainRemoveConfirmButton}
          cancelLabel={t.organizations.cancel}
          pending={props.busy === `remove:${domain.id}`}
          onConfirm={props.onRemove}
          onCancel={props.onCancelRemove}
        />
      ) : null}
    </li>
  )
}

/**
 * The "Domains" tab of `<OrganizationProfile>`: the email domains the organization claims. A
 * claim is made by naming a domain and an address on it; the code emailed there is entered in
 * the domain's row, and a verified domain says what it does for people who sign up with a
 * verified address on it (suggest the organization, or add them). Drawn only for a role that
 * holds `org:sys:domains:manage`.
 *
 * The server refuses a public provider's domain, one another organization holds, an address
 * that is not on the domain and a sixth wrong guess; each is shown with the client's text for
 * its code. A mode this version does not know is labelled "not supported" and kept as it is.
 *
 * @returns The section.
 */
export function DomainsSection(props: OrganizationSectionProps) {
  const { el, t } = useUi()
  const { client } = useTulaContext()
  const organizationId = props.organization.id
  const guard = useGuard()
  const actions = useActions(props.onAccessChanged)
  const titleId = useId()
  const title = useRef<HTMLHeadingElement>(null)
  const [domains, setDomains] = useState<OrganizationDomain[] | null>(null)
  const [loadError, setLoadError] = useState<TulaError | null>(null)
  const [domain, setDomain] = useState('')
  const [email, setEmail] = useState('')
  const [mode, setMode] = useState<OrganizationDomain['mode']>('suggest')
  const [missing, setMissing] = useState({ domain: false, email: false })
  const [removing, setRemoving] = useState<string | null>(null)
  const [codeFor, setCodeFor] = useState<string | null>(null)
  const domainField = useRef<HTMLDivElement>(null)
  const changed = useRef(props.onAccessChanged)
  changed.current = props.onAccessChanged
  const claimError = actions.failed === 'start' ? actions.error : null
  const wait = useRetryCountdown(claimError)
  const placed = placeErrors(claimError, organizationFieldResolver(FIELDS))

  const load = useCallback(async () => {
    const current = guard()
    try {
      const list = await client.organizations.domains.list(organizationId)
      if (current()) {
        setDomains(list.data)
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

  const start = () => {
    const next = { domain: domain.trim(), email: email.trim() }
    const absent = { domain: next.domain === '', email: next.email === '' }
    setMissing(absent)
    if (absent.domain || absent.email) {
      return
    }
    void actions.run('start', async (current) => {
      // Cleared first, so that a claim sent again for the same domain moves the focus again.
      setCodeFor(null)
      const claim = await client.organizations.domains.start(organizationId, { ...next, mode })
      await load()
      if (current()) {
        setEmail('')
        // The code is typed in the claim's row; the focus goes there.
        setCodeFor(claim.id)
      }
      return formatText(t.organizationProfile.domainCodeSent, { email: next.email })
    })
  }
  const verify = (entry: OrganizationDomain, code: string) =>
    actions.run(`verify:${entry.id}`, async () => {
      await client.organizations.domains.verify(organizationId, entry.id, code)
      await load()
      return formatText(t.organizationProfile.domainVerifiedMessage, { domain: entry.domain })
    })
  const changeMode = (entry: OrganizationDomain, next: OrganizationDomain['mode']) =>
    actions.run(`mode:${entry.id}`, async () => {
      await client.organizations.domains.update(organizationId, entry.id, next)
      await load()
      return formatText(t.organizationProfile.domainModeChanged, { domain: entry.domain })
    })
  const remove = (entry: OrganizationDomain) =>
    actions.run(`remove:${entry.id}`, async (current) => {
      await client.organizations.domains.remove(organizationId, entry.id)
      await load()
      if (current()) {
        setRemoving(null)
        title.current?.focus()
      }
      return formatText(t.organizationProfile.domainRemoved, { domain: entry.domain })
    })
  // Sending a new code needs the address again (the list never shows it): the claim form takes
  // the domain and waits for the address.
  const resend = (entry: OrganizationDomain) => {
    setDomain(entry.domain)
    setMode(entry.mode)
    setEmail('')
    domainField.current?.querySelectorAll('input')[1]?.focus()
  }
  const rowError = actions.failed?.startsWith('verify:') ? null : actions.error

  return (
    <section {...el('section')} aria-labelledby={titleId}>
      <Heading offset={1} {...el('sectionTitle')} id={titleId} headingRef={title}>
        {t.organizationProfile.domainsTitle}
      </Heading>
      <p className='tula-text'>{t.organizationProfile.domainsIntro}</p>
      <FormError
        message={
          loadError?.message ?? (actions.failed !== 'start' && rowError ? rowError.message : null)
        }
      />
      {domains === null ? (
        <p className='tula-text'>{loadError ? null : t.organizationProfile.domainsLoading}</p>
      ) : domains.length === 0 ? (
        <p className='tula-text'>{t.organizationProfile.domainsEmpty}</p>
      ) : (
        <ul {...el('domainList')}>
          {domains.map((entry) => (
            <DomainRow
              key={entry.id}
              domain={entry}
              busy={actions.busy}
              error={actions.error}
              failed={actions.failed}
              removing={removing === entry.id}
              focusCode={codeFor === entry.id}
              onVerify={(code) => void verify(entry, code)}
              onMode={(next) => void changeMode(entry, next)}
              onResend={() => resend(entry)}
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
      {loadError && domains === null ? (
        <Button kind='secondary' onClick={() => void load()}>
          {t.organizations.retry}
        </Button>
      ) : null}
      <div ref={domainField}>
        <Form
          onSubmit={start}
          failure={missing.domain || missing.email ? missing : claimError}
          blocked={actions.busy !== null}
        >
          <FormError {...rateLimitedAlert(placed.form, wait, t)} />
          <TextField
            label={t.organizationProfile.domainLabel}
            name='domain'
            autoComplete='off'
            autoCapitalize='none'
            autoCorrect='off'
            spellCheck={false}
            value={domain}
            onValue={(value) => {
              setDomain(value)
              setMissing((current) => ({ ...current, domain: false }))
            }}
            errors={[
              ...(missing.domain ? [t.organizationProfile.domainRequired] : []),
              ...(placed.fields.domain ?? []),
            ]}
            required
          />
          <EmailField
            label={t.organizationProfile.domainEmailLabel}
            name='domain-email'
            autoComplete='off'
            value={email}
            onValue={(value) => {
              setEmail(value)
              setMissing((current) => ({ ...current, email: false }))
            }}
            errors={[
              ...(missing.email ? [t.organizationProfile.domainEmailRequired] : []),
              ...(placed.fields.email ?? []),
            ]}
            required
          />
          <SelectField
            label={t.organizationProfile.domainModeLabel}
            value={mode}
            options={[
              { value: 'suggest', label: t.organizationProfile.modeSuggest },
              { value: 'auto_join', label: t.organizationProfile.modeAutoJoin },
            ]}
            onValue={(value) => setMode(value as OrganizationDomain['mode'])}
            errors={placed.fields.mode}
          />
          <div className='tula-button-row tula-is-compact'>
            <Button type='submit' pending={actions.busy === 'start'}>
              {t.organizationProfile.domainStart}
            </Button>
          </div>
        </Form>
      </div>
      <Status message={actions.message} />
    </section>
  )
}
