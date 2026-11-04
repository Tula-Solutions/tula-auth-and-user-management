import { useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useEffect, useState } from 'react'
import { fieldErrorMap } from '~/api/errors'
import {
  type CreateSsoConnectionRequest,
  type SsoConnection,
  type UpdateSsoConnectionRequest,
  useCreateSsoConnection,
  useUpdateSsoConnection,
} from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { Field, SelectField, SwitchRow, TextField } from '~/components/field'
import { Modal } from '~/components/modal'
import { notify } from '~/components/toaster'
import { Textarea } from '~/components/ui/textarea'
import { WeakeningQuestion } from '~/features/hooks/hook-form'
import { useRoles } from '~/features/organizations/use-roles'
import { useEnvironment, useEnvironmentRequest } from '~/features/shell/environment-context'
import { printableName } from '~/lib/printable'
import { refreshSso } from './queries'
import { ssoMessageFor, weakeningSentences } from './words'

type Protocol = 'oidc' | 'saml'
type SamlSource = 'url' | 'xml' | 'manual'

/** The connection's domains from the text field: split on spaces, commas and new lines. */
function domainsOf(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '')
}

/** Props of {@link ConnectionDialog}. */
export interface ConnectionDialogProps {
  organizationId: string
  /** The connection to change, or `null` to make a new one. */
  connection: SsoConnection | null
  open: boolean
  onClose: () => void
}

/**
 * The form that makes a connection (OIDC or SAML) or changes one.
 *
 * The client secret is a write-only field: it is never filled in from the connection (the API
 * does not return it), an empty one on an edit keeps the stored secret, and it is component
 * state only while the dialog is open (the mutation is `gcTime: 0` and `reset()` on close).
 * A change sends only the fields that differ.
 *
 * @param props - See {@link ConnectionDialogProps}.
 * @returns The dialog.
 */
export function ConnectionDialog({
  organizationId,
  connection,
  open,
  onClose,
}: ConnectionDialogProps) {
  const queryClient = useQueryClient()
  const request = useEnvironmentRequest()
  const environment = useEnvironment()
  const create = useCreateSsoConnection({ request, mutation: { gcTime: 0 } })
  const update = useUpdateSsoConnection({ request, mutation: { gcTime: 0 } })
  const roles = useRoles()
  const [protocol, setProtocol] = useState<Protocol>('oidc')
  const [name, setName] = useState('')
  const [issuer, setIssuer] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [source, setSource] = useState<SamlSource>('url')
  const [metadataUrl, setMetadataUrl] = useState('')
  const [metadataXml, setMetadataXml] = useState('')
  const [idpEntityId, setIdpEntityId] = useState('')
  const [ssoUrl, setSsoUrl] = useState('')
  const [certificate, setCertificate] = useState('')
  const [nextCertificate, setNextCertificate] = useState('')
  const [defaultRole, setDefaultRole] = useState('member')
  const [domains, setDomains] = useState('')
  const [enforced, setEnforced] = useState(false)
  const [trustIdpMfa, setTrustIdpMfa] = useState(false)
  const [breakGlassRole, setBreakGlassRole] = useState('')
  // The change waiting for an answer to the weakening question, or null.
  const [asking, setAsking] = useState<UpdateSsoConnectionRequest | null>(null)
  const [problems, setProblems] = useState<Record<string, string>>({})
  // Held from the submit until the list was read again: a second click would send it twice.
  const [saving, setSaving] = useState(false)
  const createReset = create.reset
  const updateReset = update.reset
  const editing = connection !== null

  useEffect(() => {
    if (open) {
      setProtocol(connection?.protocol ?? 'oidc')
      setName(connection?.name ?? '')
      setIssuer(connection?.issuer ?? '')
      setClientId(connection?.clientId ?? '')
      setDefaultRole(connection?.defaultRole ?? 'member')
      setDomains((connection?.domains ?? []).join('\n'))
      setEnforced(connection?.enforced ?? false)
      setTrustIdpMfa(connection?.trustIdpMfa ?? false)
      setBreakGlassRole(connection?.breakGlassRole ?? '')
      setSource(connection?.saml ? 'manual' : 'url')
      setIdpEntityId(connection?.saml?.idpEntityId ?? '')
      setSsoUrl(connection?.saml?.ssoUrl ?? '')
      setMetadataUrl(connection?.saml?.metadataUrl ?? '')
    } else {
      // The secret and the pasted values leave with the form.
      setClientSecret('')
      setMetadataXml('')
      setCertificate('')
      setNextCertificate('')
      setProblems({})
      setAsking(null)
      setSaving(false)
      createReset()
      updateReset()
    }
  }, [open, connection, createReset, updateReset])

  function samlInput() {
    if (source === 'url') {
      return { metadataUrl: metadataUrl.trim() }
    }
    if (source === 'xml') {
      return { metadataXml }
    }
    const certificates = [certificate, nextCertificate]
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
    return {
      idpEntityId: idpEntityId.trim(),
      ssoUrl: ssoUrl.trim(),
      ...(certificates.length > 0 ? { certificates } : {}),
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (saving) {
      return
    }
    const found: Record<string, string> = {}
    if (name.trim() === '') {
      found.name = 'Enter a name for the connection, such as “Okta”.'
    }
    if (!editing && protocol === 'oidc') {
      if (issuer.trim() === '') {
        found.issuer = 'Enter the provider’s issuer address.'
      }
      if (clientId.trim() === '') {
        found.clientId = 'Enter the client id.'
      }
      if (clientSecret === '') {
        found.clientSecret = 'Enter the client secret.'
      }
    }
    setProblems(found)
    if (Object.keys(found).length > 0) {
      return
    }
    setSaving(true)
    const done = {
      onError: () => setSaving(false),
      onSuccess: async () => {
        await refreshSso(queryClient)
        notify(editing ? 'Connection saved' : 'Connection created')
        onClose()
      },
    }
    if (connection === null) {
      const data: CreateSsoConnectionRequest = {
        organizationId,
        protocol,
        name: name.trim(),
        defaultRole,
        domains: domainsOf(domains),
        ...(protocol === 'oidc'
          ? { issuer: issuer.trim(), clientId: clientId.trim(), clientSecret }
          : { saml: samlInput() }),
      }
      create.mutate({ data }, done)
      return
    }
    const data: UpdateSsoConnectionRequest = {
      ...(name.trim() !== connection.name ? { name: name.trim() } : {}),
      ...(defaultRole !== connection.defaultRole ? { defaultRole } : {}),
      ...(domainsOf(domains).join() !== connection.domains.join()
        ? { domains: domainsOf(domains) }
        : {}),
      ...(protocol === 'oidc' && issuer.trim() !== connection.issuer
        ? { issuer: issuer.trim() }
        : {}),
      ...(protocol === 'oidc' && clientId.trim() !== connection.clientId
        ? { clientId: clientId.trim() }
        : {}),
      ...(protocol === 'oidc' && clientSecret !== '' ? { clientSecret } : {}),
      // A SAML change is sent only when something was typed: the stored values are not shown
      // back (a certificate is replaced as a whole).
      ...(protocol === 'saml' ? samlChange() : {}),
      ...(enforced !== connection.enforced ? { enforced } : {}),
      ...(trustIdpMfa !== connection.trustIdpMfa ? { trustIdpMfa } : {}),
      ...(breakGlassRole !== (connection.breakGlassRole ?? '')
        ? { breakGlassRole: breakGlassRole === '' ? null : breakGlassRole }
        : {}),
    }
    if (Object.keys(data).length === 0) {
      setSaving(false)
      onClose()
      return
    }
    if (asking === null && weakeningSentences(connection, data).length > 0) {
      setSaving(false)
      update.reset()
      setAsking(data)
      return
    }
    update.mutate({ id: connection.id, data }, done)
  }

  function samlChange(): Pick<UpdateSsoConnectionRequest, 'saml'> {
    const changed =
      (source === 'url' && metadataUrl.trim() !== (connection?.saml?.metadataUrl ?? '')) ||
      (source === 'xml' && metadataXml !== '') ||
      (source === 'manual' &&
        (certificate.trim() !== '' ||
          idpEntityId.trim() !== connection?.saml?.idpEntityId ||
          ssoUrl.trim() !== connection?.saml?.ssoUrl))
    return changed ? { saml: samlInput() } : {}
  }

  const error = create.error ?? update.error
  const errors = { ...fieldErrorMap(error), ...problems }
  const general = error && Object.keys(fieldErrorMap(error)).length === 0
  const roleList = roles.data?.data ?? []

  if (asking !== null && connection !== null) {
    return (
      <Modal
        open={open}
        onClose={onClose}
        title='Let more people through?'
        description={<>You are changing {printableName(connection.name)}.</>}
      >
        <WeakeningQuestion
          sentences={weakeningSentences(connection, asking)}
          requireText={
            environment.kind === 'production' ? printableName(connection.name) : undefined
          }
          pending={saving}
          confirmLabel='Save changes'
          onConfirm={() => {
            setSaving(true)
            update.mutate(
              { id: connection.id, data: asking },
              {
                onError: () => setSaving(false),
                onSuccess: async () => {
                  await refreshSso(queryClient)
                  notify('Connection saved')
                  onClose()
                },
              }
            )
          }}
          onCancel={() => setAsking(null)}
        />
        {update.error ? (
          <p role='alert' className='mt-2 text-sm text-destructive'>
            {ssoMessageFor(update.error)}
          </p>
        ) : null}
      </Modal>
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? 'Edit connection' : 'New connection'}
      description='A connection signs in people whose email address is on one of its verified domains. It starts as a draft and signs nobody in until you activate it.'
    >
      <form onSubmit={submit} className='flex flex-col gap-4' noValidate>
        <TextField
          label='Name'
          autoComplete='off'
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={errors.name}
        />
        <SelectField
          label='Protocol'
          value={protocol}
          disabled={editing}
          onChange={(event) => setProtocol(event.target.value as Protocol)}
          hint={editing ? 'The protocol of a connection cannot be changed.' : undefined}
        >
          <option value='oidc'>OpenID Connect (OIDC)</option>
          <option value='saml'>SAML 2.0</option>
        </SelectField>
        {protocol === 'oidc' ? (
          <>
            <TextField
              label='Issuer'
              autoComplete='off'
              spellCheck={false}
              placeholder='https://login.example.com'
              value={issuer}
              onChange={(event) => setIssuer(event.target.value)}
              error={errors.issuer}
            />
            <TextField
              label='Client id'
              autoComplete='off'
              spellCheck={false}
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              error={errors.clientId}
            />
            <TextField
              label='Client secret'
              type='password'
              autoComplete='new-password'
              value={clientSecret}
              onChange={(event) => setClientSecret(event.target.value)}
              error={errors.clientSecret}
              hint={
                editing
                  ? connection?.clientSecretSet
                    ? 'A secret is saved and is never shown again. Leave this empty to keep it, or type a new one to replace it.'
                    : 'No secret is saved yet.'
                  : 'Saved once and never shown again.'
              }
            />
          </>
        ) : (
          <>
            <SelectField
              label='Identity provider values'
              value={source}
              onChange={(event) => setSource(event.target.value as SamlSource)}
              hint={
                editing
                  ? 'The saved values are not shown back. Fill in new ones only to replace them.'
                  : 'Give the provider’s metadata, or its values by hand.'
              }
            >
              <option value='url'>Metadata address</option>
              <option value='xml'>Pasted metadata XML</option>
              <option value='manual'>By hand</option>
            </SelectField>
            {source === 'url' ? (
              <TextField
                label='Metadata address'
                autoComplete='off'
                spellCheck={false}
                placeholder='https://idp.example.com/metadata'
                value={metadataUrl}
                onChange={(event) => setMetadataUrl(event.target.value)}
                error={errors['saml.metadataUrl']}
              />
            ) : null}
            {source === 'xml' ? (
              <Field label='Metadata XML' error={errors['saml.metadataXml']}>
                {(control) => (
                  <Textarea
                    className='bg-field font-mono text-xs'
                    rows={6}
                    spellCheck={false}
                    value={metadataXml}
                    onChange={(event) => setMetadataXml(event.target.value)}
                    {...control}
                  />
                )}
              </Field>
            ) : null}
            {source === 'manual' ? (
              <>
                <TextField
                  label='Identity provider entity id'
                  autoComplete='off'
                  spellCheck={false}
                  value={idpEntityId}
                  onChange={(event) => setIdpEntityId(event.target.value)}
                  error={errors['saml.idpEntityId']}
                />
                <TextField
                  label='Sign-in URL'
                  autoComplete='off'
                  spellCheck={false}
                  value={ssoUrl}
                  onChange={(event) => setSsoUrl(event.target.value)}
                  error={errors['saml.ssoUrl']}
                />
                <Field label='Signing certificate' error={errors['saml.certificates']}>
                  {(control) => (
                    <Textarea
                      className='bg-field font-mono text-xs'
                      rows={4}
                      spellCheck={false}
                      value={certificate}
                      onChange={(event) => setCertificate(event.target.value)}
                      {...control}
                    />
                  )}
                </Field>
                <Field label='Next signing certificate (optional)'>
                  {(control) => (
                    <Textarea
                      className='bg-field font-mono text-xs'
                      rows={4}
                      spellCheck={false}
                      value={nextCertificate}
                      onChange={(event) => setNextCertificate(event.target.value)}
                      {...control}
                    />
                  )}
                </Field>
              </>
            ) : null}
          </>
        )}
        <SelectField
          label='Role of people who sign in'
          value={defaultRole}
          onChange={(event) => setDefaultRole(event.target.value)}
          error={errors.defaultRole}
        >
          {roleList.map((role) => (
            <option key={role.key} value={role.key}>
              {role.name}
            </option>
          ))}
          {roleList.some((role) => role.key === defaultRole) ? null : (
            <option value={defaultRole}>{defaultRole}</option>
          )}
        </SelectField>
        <Field
          label='Domains'
          error={errors.domains}
          hint='One per line. Each must be verified for this organization first.'
        >
          {(control) => (
            <Textarea
              className='bg-field'
              rows={3}
              spellCheck={false}
              value={domains}
              onChange={(event) => setDomains(event.target.value)}
              {...control}
            />
          )}
        </Field>
        {editing ? (
          <div className='flex flex-col'>
            <SwitchRow
              label='Require this connection'
              description='People on the bound domains can only sign in through it, not with a password.'
              checked={enforced}
              onChange={setEnforced}
            />
            <SwitchRow
              label='Trust the identity provider for two-step verification'
              description='People who sign in through it are not asked for a second step by Tula.'
              checked={trustIdpMfa}
              onChange={setTrustIdpMfa}
            />
            <SelectField
              label='Break-glass role'
              value={breakGlassRole}
              onChange={(event) => setBreakGlassRole(event.target.value)}
              hint='Anyone with this role keeps password sign-in even when the connection is required.'
            >
              <option value=''>None</option>
              {roleList.map((role) => (
                <option key={role.key} value={role.key}>
                  {role.name}
                </option>
              ))}
            </SelectField>
          </div>
        ) : null}
        {general ? (
          <p role='alert' className='text-sm text-destructive'>
            {ssoMessageFor(error)}
          </p>
        ) : null}
        <div className='flex flex-wrap justify-end gap-2'>
          <ActionButton variant='outline' onClick={onClose}>
            Cancel
          </ActionButton>
          <ActionButton type='submit' pending={saving}>
            {editing ? 'Save changes' : 'Create connection'}
          </ActionButton>
        </div>
      </form>
    </Modal>
  )
}
