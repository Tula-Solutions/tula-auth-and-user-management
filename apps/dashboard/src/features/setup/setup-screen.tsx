import {
  effectiveAttributeNames,
  SSO_IDP_PRESETS,
  type SsoAttributeMapping,
  type SsoIdpPreset,
} from '@tula-tech/contract'
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { messageFor, toApiError } from '~/api/errors'
import type {
  SetupPortal,
  SsoConnection,
  SsoGroupRoles,
  SsoTestResult,
  SsoTestStart,
} from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { CopyButton } from '~/components/copy-button'
import { SelectField, TextField } from '~/components/field'
import { PageHeader, Section } from '~/components/page'
import { LoadingState } from '~/components/states'
import { printableName } from '~/lib/printable'
import { boot, setupRequest } from './setup-api'

/** The channel a returning test window uses to tell the setup tab which test came back. */
export const SETUP_TEST_CHANNEL = 'tula-setup-test'

/** How often the setup tab asks for the result of a test it started, in milliseconds. */
const POLL_MS = 1500

const PRESET_LABELS: Record<SsoIdpPreset, string> = {
  okta: 'Okta',
  entra: 'Microsoft Entra ID',
  google_workspace: 'Google Workspace',
  jumpcloud: 'JumpCloud',
  onelogin: 'OneLogin',
  ping: 'PingIdentity',
  generic: 'Another provider',
}

const GUIDES: Record<SsoIdpPreset, string> = {
  okta: 'In Okta, add an app integration (OIDC web app, or SAML 2.0), paste the values below, assign the people who should sign in, then copy the issuer, client id and secret (or the metadata address) back here.',
  entra:
    'In Microsoft Entra ID, add an enterprise application, choose single sign-on, paste the values below, assign users and groups, then copy the details back here.',
  google_workspace:
    'In the Google Admin console, add a custom SAML app, paste the values below, turn it on for the people who should sign in, then copy the metadata back here.',
  jumpcloud:
    'In JumpCloud, create a custom SSO application, paste the values below, bind the user groups, then copy the details back here.',
  onelogin:
    'In OneLogin, add a connector for your protocol, paste the values below, assign the roles, then copy the details back here.',
  ping: 'In PingIdentity, add an application, paste the values below, then copy the details back here.',
  generic:
    'In your identity provider, create an application for single sign-on, paste the values below, then copy the provider’s details back here.',
}

/**
 * The public single sign-on setup page an organization's IT administrator opens from a setup
 * link (ADR 0067, "Setup links"). It has no account: every call carries the link's token, held
 * in memory, and reaches nothing but that organization's connections.
 *
 * @returns The page.
 */
export function SetupScreen() {
  const [state] = useState(() => boot())
  const [portal, setPortal] = useState<SetupPortal | null>(null)
  const [failure, setFailure] = useState<unknown>(null)

  const load = useCallback(async () => {
    try {
      setPortal(await setupRequest<SetupPortal>(''))
      setFailure(null)
    } catch (error) {
      setFailure(error)
    }
  }, [])

  useEffect(() => {
    if (state.token !== null) {
      void load()
    }
  }, [state.token, load])

  // The window the identity provider sent the person back to: tell the setup tab and step aside.
  useEffect(() => {
    if (state.token !== null || state.test === null) {
      return
    }
    const channel = new BroadcastChannel(SETUP_TEST_CHANNEL)
    channel.postMessage({ testId: state.test })
    channel.close()
    window.close()
  }, [state])

  if (state.token === null && state.test !== null) {
    return (
      <Shell>
        <PageHeader
          title='Test sign-in finished'
          description='Return to the setup tab: it shows the result. You can close this window.'
        />
      </Shell>
    )
  }
  if (
    state.token === null ||
    (failure !== null && toApiError(failure).code === 'auth.invalid_key')
  ) {
    return (
      <Shell>
        <PageHeader
          title='This setup link is not valid'
          description='It may have expired or been revoked, or the address is incomplete. Ask the person who sent it for a new link.'
        />
      </Shell>
    )
  }
  if (portal === null) {
    return (
      <Shell>
        {failure === null ? (
          <LoadingState label='Loading the setup page' />
        ) : (
          <p role='alert' className='text-sm text-destructive'>
            {messageFor(failure)}
          </p>
        )}
      </Shell>
    )
  }
  return (
    <Shell>
      <PageHeader
        title={`Set up single sign-on for ${printableName(portal.organization.name)}`}
        description='Connect your identity provider so that your people sign in with it. Nothing changes for them until you activate the connection, and password sign-in keeps working for the people who have a password.'
      />
      <Setup portal={portal} reload={load} />
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className='mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 px-4 py-10'>
      {children}
    </main>
  )
}

function Setup({ portal, reload }: { portal: SetupPortal; reload: () => Promise<void> }) {
  const connection = portal.connections[0] ?? null
  return (
    <>
      <p className='text-sm text-muted-foreground'>
        This link works until{' '}
        <time dateTime={portal.expiresAt}>{new Date(portal.expiresAt).toUTCString()}</time>.
      </p>
      <ConnectionForm
        key={connection?.id ?? 'new'}
        portal={portal}
        connection={connection}
        reload={reload}
      />
      {connection ? (
        <>
          <ServiceProviderValues connection={connection} />
          <GroupRoles connection={connection} />
          <TestAndActivate connection={connection} reload={reload} />
        </>
      ) : null}
    </>
  )
}

function ConnectionForm({
  portal,
  connection,
  reload,
}: {
  portal: SetupPortal
  connection: SsoConnection | null
  reload: () => Promise<void>
}) {
  const [protocol, setProtocol] = useState<'oidc' | 'saml'>(connection?.protocol ?? 'oidc')
  const [name, setName] = useState(connection?.name ?? '')
  const [preset, setPreset] = useState<SsoIdpPreset>(connection?.attributeMapping?.idp ?? 'generic')
  const [issuer, setIssuer] = useState(connection?.issuer ?? '')
  const [clientId, setClientId] = useState(connection?.clientId ?? '')
  const [clientSecret, setClientSecret] = useState('')
  const [samlSource, setSamlSource] = useState<'url' | 'xml' | 'manual'>('url')
  const [metadataUrl, setMetadataUrl] = useState(connection?.saml?.metadataUrl ?? '')
  const [metadataXml, setMetadataXml] = useState('')
  const [entityId, setEntityId] = useState('')
  const [ssoUrl, setSsoUrl] = useState('')
  const [certificate, setCertificate] = useState('')
  const [domains, setDomains] = useState<string[]>(connection?.domains ?? [])
  const [mapping, setMapping] = useState<SsoAttributeMapping>(connection?.attributeMapping ?? {})
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const names = effectiveAttributeNames(protocol, { ...mapping, idp: preset })

  function samlInput() {
    if (samlSource === 'url') {
      return metadataUrl ? { metadataUrl } : undefined
    }
    if (samlSource === 'xml') {
      return metadataXml ? { metadataXml } : undefined
    }
    return entityId || ssoUrl || certificate
      ? { idpEntityId: entityId, ssoUrl, certificates: certificate ? [certificate] : [] }
      : undefined
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setPending(true)
    setError(null)
    setSaved(false)
    const attributeMapping = { ...mapping, idp: preset }
    const saml = protocol === 'saml' ? samlInput() : undefined
    try {
      if (connection) {
        await setupRequest(`/connections/${connection.id}`, {
          method: 'PATCH',
          body: {
            name,
            domains,
            attributeMapping,
            ...(protocol === 'oidc'
              ? { issuer, clientId, ...(clientSecret ? { clientSecret } : {}) }
              : saml
                ? { saml }
                : {}),
          },
        })
      } else {
        await setupRequest('/connections', {
          method: 'POST',
          body: {
            protocol,
            name,
            domains,
            attributeMapping,
            ...(protocol === 'oidc'
              ? { issuer, clientId, ...(clientSecret ? { clientSecret } : {}) }
              : saml
                ? { saml }
                : {}),
          },
        })
      }
      setClientSecret('')
      setMetadataXml('')
      setSaved(true)
      await reload()
    } catch (failure) {
      setError(messageFor(failure))
    } finally {
      setPending(false)
    }
  }

  async function readFile(file: File | undefined) {
    if (file) {
      setMetadataXml(await file.text())
      setSamlSource('xml')
    }
  }

  function toggleDomain(domain: string, on: boolean) {
    setDomains((current) => (on ? [...current, domain] : current.filter((d) => d !== domain)))
  }

  return (
    <Section
      title={connection ? 'Your identity provider' : '1. Choose your identity provider'}
      description={GUIDES[preset]}
    >
      <form onSubmit={submit} className='flex flex-col gap-4' noValidate>
        <SelectField
          label='Identity provider'
          value={preset}
          onChange={(event) => setPreset(event.target.value as SsoIdpPreset)}
        >
          {SSO_IDP_PRESETS.map((value) => (
            <option key={value} value={value}>
              {PRESET_LABELS[value]}
            </option>
          ))}
        </SelectField>
        <SelectField
          label='Protocol'
          value={protocol}
          disabled={connection !== null}
          onChange={(event) => setProtocol(event.target.value as 'oidc' | 'saml')}
        >
          <option value='oidc'>OpenID Connect (OIDC)</option>
          <option value='saml'>SAML 2.0</option>
        </SelectField>
        <TextField label='Connection name' value={name} onChange={(e) => setName(e.target.value)} />
        {protocol === 'oidc' ? (
          <>
            <TextField
              label='Issuer address'
              hint='The https address of your identity provider’s OpenID Connect issuer.'
              value={issuer}
              onChange={(e) => setIssuer(e.target.value)}
            />
            <TextField
              label='Client ID'
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            />
            <TextField
              label='Client secret'
              type='password'
              autoComplete='off'
              hint={
                connection?.clientSecretSet
                  ? 'A secret is saved. Leave this empty to keep it.'
                  : 'Kept by the server and never shown again.'
              }
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
            />
          </>
        ) : (
          <>
            <SelectField
              label='How do you give the provider’s details?'
              value={samlSource}
              onChange={(event) => setSamlSource(event.target.value as 'url' | 'xml' | 'manual')}
            >
              <option value='url'>Metadata address</option>
              <option value='xml'>Paste or upload metadata</option>
              <option value='manual'>Enter the values by hand</option>
            </SelectField>
            {samlSource === 'url' ? (
              <TextField
                label='Metadata address'
                value={metadataUrl}
                onChange={(e) => setMetadataUrl(e.target.value)}
              />
            ) : null}
            {samlSource === 'xml' ? (
              <>
                <TextField
                  label='Metadata file'
                  type='file'
                  accept='.xml,text/xml,application/xml'
                  onChange={(e) => void readFile(e.target.files?.[0])}
                />
                <label className='flex flex-col gap-1.5 text-sm font-medium'>
                  Metadata XML
                  <textarea
                    className='min-h-32 rounded-md border bg-field p-2 font-mono text-xs'
                    value={metadataXml}
                    onChange={(e) => setMetadataXml(e.target.value)}
                  />
                </label>
              </>
            ) : null}
            {samlSource === 'manual' ? (
              <>
                <TextField
                  label='Provider entity ID'
                  value={entityId}
                  onChange={(e) => setEntityId(e.target.value)}
                />
                <TextField
                  label='Sign-in URL'
                  value={ssoUrl}
                  onChange={(e) => setSsoUrl(e.target.value)}
                />
                <label className='flex flex-col gap-1.5 text-sm font-medium'>
                  Signing certificate (PEM)
                  <textarea
                    className='min-h-24 rounded-md border bg-field p-2 font-mono text-xs'
                    value={certificate}
                    onChange={(e) => setCertificate(e.target.value)}
                  />
                </label>
              </>
            ) : null}
          </>
        )}
        <fieldset className='flex flex-col gap-2'>
          <legend className='text-sm font-medium'>Domains that sign in with this connection</legend>
          {portal.domains.length === 0 ? (
            <p className='text-sm text-muted-foreground'>
              This organization has no verified domain yet. Ask the person who sent the link to
              verify one first; you can still set the connection up.
            </p>
          ) : (
            portal.domains.map((domain) => (
              <label key={domain} className='flex items-center gap-2 text-sm'>
                <input
                  type='checkbox'
                  checked={domains.includes(domain)}
                  onChange={(e) => toggleDomain(domain, e.target.checked)}
                />
                {printableName(domain)}
              </label>
            ))
          )}
        </fieldset>
        <fieldset className='flex flex-col gap-3'>
          <legend className='text-sm font-medium'>Attribute names</legend>
          <p className='text-sm text-muted-foreground'>
            Leave a field empty to use {PRESET_LABELS[preset]}’s usual name (shown inside it).
          </p>
          {(['email', 'firstName', 'lastName', 'groups'] as const).map((key) => (
            <TextField
              key={key}
              label={
                {
                  email: 'Email',
                  firstName: 'First name',
                  lastName: 'Last name',
                  groups: 'Groups',
                }[key]
              }
              placeholder={names[key].join(', ')}
              value={mapping[key] ?? ''}
              onChange={(e) => {
                const value = e.target.value
                setMapping((current) => ({ ...current, [key]: value || undefined }))
              }}
            />
          ))}
        </fieldset>
        {error ? (
          <p role='alert' className='text-sm text-destructive'>
            {error}
          </p>
        ) : null}
        {saved ? (
          <p role='status' className='text-sm'>
            Saved.
          </p>
        ) : null}
        <div>
          <ActionButton type='submit' pending={pending}>
            {connection ? 'Save changes' : 'Create connection'}
          </ActionButton>
        </div>
      </form>
    </Section>
  )
}

function ServiceProviderValues({ connection }: { connection: SsoConnection }) {
  const rows: [string, string][] =
    connection.protocol === 'saml'
      ? [
          ['Entity ID (audience)', connection.saml?.spEntityId ?? ''],
          ['ACS URL (reply URL)', connection.saml?.acsUrl ?? ''],
        ]
      : [['Redirect URI', `${window.location.origin}/v1/sso/callback/${connection.id}`]]
  return (
    <Section
      title='2. Give these values to your identity provider'
      description='Paste them into the application you created there.'
    >
      <dl className='flex flex-col gap-3'>
        {rows
          .filter(([, value]) => value !== '')
          .map(([label, value]) => (
            <div key={label} className='flex flex-col gap-1'>
              <dt className='text-sm font-medium'>{label}</dt>
              <dd className='flex flex-wrap items-center gap-2'>
                <code className='break-all rounded bg-muted px-2 py-1 text-xs'>{value}</code>
                <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
              </dd>
            </div>
          ))}
      </dl>
      {connection.saml?.spMetadataUrl ? (
        <a
          className='text-sm underline'
          href={connection.saml.spMetadataUrl}
          download='tula-sp-metadata.xml'
          rel='noreferrer'
        >
          Download the service provider metadata
        </a>
      ) : null}
    </Section>
  )
}

function GroupRoles({ connection }: { connection: SsoConnection }) {
  const [rows, setRows] = useState<{ group: string; role: string }[] | null>(null)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setupRequest<SsoGroupRoles>(`/connections/${connection.id}/group-roles`)
      .then((result) => live && setRows(result.mappings))
      .catch((failure) => live && setError(messageFor(failure)))
    return () => {
      live = false
    }
  }, [connection.id])

  async function save() {
    setPending(true)
    setError(null)
    setMessage(null)
    try {
      await setupRequest(`/connections/${connection.id}/group-roles`, {
        method: 'PUT',
        body: { mappings: (rows ?? []).filter((r) => r.group !== '' && r.role !== '') },
      })
      setMessage('Group roles saved.')
    } catch (failure) {
      setError(messageFor(failure))
    } finally {
      setPending(false)
    }
  }

  return (
    <Section
      title='3. Map groups to roles (optional)'
      description='A person in a listed group gets that role in the organization. The first match wins, so list the most powerful role first.'
    >
      {(rows ?? []).map((row, index) => (
        // The rows have no identity of their own; an index is their order, which is the precedence.
        // biome-ignore lint/suspicious/noArrayIndexKey: ordered, editable list without ids
        <div key={index} className='flex flex-wrap items-end gap-2'>
          <TextField
            label={`Group ${index + 1}`}
            value={row.group}
            onChange={(e) =>
              setRows((current) =>
                (current ?? []).map((r, i) => (i === index ? { ...r, group: e.target.value } : r))
              )
            }
          />
          <TextField
            label={`Role for group ${index + 1}`}
            value={row.role}
            onChange={(e) =>
              setRows((current) =>
                (current ?? []).map((r, i) => (i === index ? { ...r, role: e.target.value } : r))
              )
            }
          />
          <ActionButton
            variant='outline'
            size='sm'
            onClick={() => setRows((current) => (current ?? []).filter((_, i) => i !== index))}
          >
            Remove
          </ActionButton>
        </div>
      ))}
      <div className='flex flex-wrap gap-2'>
        <ActionButton
          variant='outline'
          onClick={() => setRows((current) => [...(current ?? []), { group: '', role: '' }])}
        >
          Add a group
        </ActionButton>
        <ActionButton onClick={save} pending={pending}>
          Save group roles
        </ActionButton>
      </div>
      {message ? (
        <p role='status' className='text-sm'>
          {message}
        </p>
      ) : null}
      {error ? (
        <p role='alert' className='text-sm text-destructive'>
          {error}
        </p>
      ) : null}
    </Section>
  )
}

function TestAndActivate({
  connection,
  reload,
}: {
  connection: SsoConnection
  reload: () => Promise<void>
}) {
  const [result, setResult] = useState<SsoTestResult | null>(null)
  const [fallback, setFallback] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [activating, setActivating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const testId = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const poll = useCallback(async () => {
    const id = testId.current
    if (id === null) {
      return
    }
    try {
      const next = await setupRequest<SsoTestResult>(`/connections/${connection.id}/tests/${id}`)
      setResult(next)
      if (next.status === 'pending') {
        timer.current = setTimeout(() => void poll(), POLL_MS)
      } else {
        await reload()
      }
    } catch (failure) {
      setError(messageFor(failure))
    }
  }, [connection.id, reload])

  useEffect(() => {
    const channel = new BroadcastChannel(SETUP_TEST_CHANNEL)
    channel.onmessage = (event: MessageEvent<{ testId?: string }>) => {
      if (event.data?.testId === testId.current) {
        void poll()
      }
    }
    return () => {
      channel.close()
      if (timer.current) {
        clearTimeout(timer.current)
      }
    }
  }, [poll])

  async function start() {
    setError(null)
    setResult(null)
    setFallback(null)
    // Opened on the click, before the request: a window opened after an await is blocked.
    const popup = window.open('about:blank', '_blank')
    setPending(true)
    try {
      const started = await setupRequest<SsoTestStart>(`/connections/${connection.id}/tests`, {
        method: 'POST',
      })
      testId.current = started.testId
      if (popup) {
        popup.location.href = started.authorizationUrl
      } else {
        setFallback(started.authorizationUrl)
      }
      timer.current = setTimeout(() => void poll(), POLL_MS)
    } catch (failure) {
      popup?.close()
      setError(messageFor(failure))
    } finally {
      setPending(false)
    }
  }

  async function activate() {
    setActivating(true)
    setError(null)
    try {
      await setupRequest(`/connections/${connection.id}`, {
        method: 'PATCH',
        body: { status: 'active' },
      })
      await reload()
    } catch (failure) {
      setError(messageFor(failure))
    } finally {
      setActivating(false)
    }
  }

  return (
    <Section
      title='4. Test, then activate'
      description='The test signs you in through your identity provider in a new window and creates nothing. Activate the connection once it passes.'
    >
      <div className='flex flex-wrap gap-2'>
        <ActionButton onClick={start} pending={pending}>
          Run a test sign-in
        </ActionButton>
        {connection.status === 'active' ? null : (
          <ActionButton
            variant='outline'
            onClick={activate}
            pending={activating}
            disabled={!connection.tested}
          >
            Activate the connection
          </ActionButton>
        )}
      </div>
      {fallback ? (
        <p className='text-sm'>
          Your browser blocked the window.{' '}
          <a className='underline' href={fallback} target='_blank' rel='noreferrer'>
            Open the test sign-in
          </a>
        </p>
      ) : null}
      {result?.status === 'pending' ? (
        <p role='status' className='text-sm'>
          Waiting for the test sign-in to finish…
        </p>
      ) : null}
      {result?.status === 'passed' ? (
        <p role='status' className='text-sm'>
          The test passed.
          {result.groups.length > 0 ? ` Groups received: ${result.groups.join(', ')}.` : ''}
        </p>
      ) : null}
      {result?.status === 'failed' ? (
        <p role='alert' className='text-sm text-destructive'>
          The test failed{result.message ? `: ${result.message}` : ` (${result.reason})`}.
        </p>
      ) : null}
      {connection.status === 'active' ? (
        <p role='status' className='text-sm'>
          This connection is active. People with a verified domain can now sign in with it, and
          password sign-in stays available to those who have a password. Enforcement is the
          organization’s administrators’ to switch on.
        </p>
      ) : null}
      {error ? (
        <p role='alert' className='text-sm text-destructive'>
          {error}
        </p>
      ) : null}
    </Section>
  )
}
