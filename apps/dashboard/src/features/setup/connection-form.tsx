import {
  effectiveAttributeNames,
  SSO_IDP_PRESETS,
  type SsoAttributeMapping,
  type SsoIdpPreset,
} from '@tula-tech/contract'
import { type FormEvent, useState } from 'react'
import { messageFor } from '~/api/errors'
import type { SetupPortal, SsoConnection } from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { CopyButton } from '~/components/copy-button'
import { SelectField, TextField } from '~/components/field'
import { Section } from '~/components/page'
import { printableName } from '~/lib/printable'
import { setupRequest } from './setup-api'

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

export function ConnectionForm({
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

export function ServiceProviderValues({ connection }: { connection: SsoConnection }) {
  const rows: [string, string][] =
    connection.protocol === 'saml'
      ? [
          ['Entity ID (audience)', connection.saml?.spEntityId ?? ''],
          ['ACS URL (reply URL)', connection.saml?.acsUrl ?? ''],
        ]
      : [['Redirect URI', connection.redirectUri ?? '']]
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
