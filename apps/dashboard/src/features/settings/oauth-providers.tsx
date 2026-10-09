import { useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { fieldErrorMap, messageFor } from '~/api/errors'
import {
  type OAuthProviderSettings,
  type OAuthProviderUpdate,
  useDeleteOAuthProvider,
  useListOAuthProviders,
  useUpdateOAuthProvider,
} from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { ConfirmDialog } from '~/components/confirm-dialog'
import { CopyButton } from '~/components/copy-button'
import { Field, SelectField, SwitchRow, TextField } from '~/components/field'
import { Section } from '~/components/page'
import { QueryState } from '~/components/states'
import { notify } from '~/components/toaster'
import { NativeSelectOption } from '~/components/ui/native-select'
import { Textarea } from '~/components/ui/textarea'
import { useEnvironment, useEnvironmentRequest } from '~/features/shell/environment-context'
import { formatDateTime } from '~/lib/format'
import { own } from '~/lib/own'

/**
 * The providers this version has a card for. Typed by the contract's union, so that a provider
 * added there must be named here; read by the server's name through `own()`, so that a name
 * this version does not know (or one every object has, like `constructor`) is not a card.
 */
const PROVIDER_NAME: Record<OAuthProviderSettings['provider'], string> = {
  google: 'Google',
  github: 'GitHub',
  apple: 'Apple',
  microsoft: 'Microsoft',
  discord: 'Discord',
  linkedin: 'LinkedIn',
}

/**
 * Which Microsoft accounts may sign in, as the form asks it: one of Microsoft's three
 * aliases, one organization (whose tenant id is then typed), or nothing chosen yet. There is
 * no default: an environment that takes every Microsoft account says so.
 */
const MICROSOFT_AUDIENCES = [
  ['common', 'Any Microsoft account (work, school or personal)'],
  ['organizations', 'Work and school accounts of any organization'],
  ['consumers', 'Personal Microsoft accounts only'],
  ['tenant', 'One organization (by tenant ID)'],
] as const

type MicrosoftAudience = (typeof MICROSOFT_AUDIENCES)[number][0] | ''

function audienceOf(tenant: string | null | undefined): MicrosoftAudience {
  if (tenant === null || tenant === undefined || tenant === '') {
    return ''
  }
  return tenant === 'common' || tenant === 'organizations' || tenant === 'consumers'
    ? tenant
    : 'tenant'
}

/**
 * One provider's credentials.
 *
 * The secret (a client secret, or Apple's private key) is write-only: the API never returns
 * it, so the form never shows one. A configured provider keeps its secret unless "Replace
 * secret" is chosen; what is typed is dropped from state as soon as it is saved.
 */
function ProviderCard({ provider, name }: { provider: OAuthProviderSettings; name: string }) {
  const queryClient = useQueryClient()
  const apple = provider.provider === 'apple'
  const microsoft = provider.provider === 'microsoft'
  // `gcTime: 0` and the `reset()` after a save: a mutation's variables hold the secret.
  const request = useEnvironmentRequest()
  const update = useUpdateOAuthProvider({ mutation: { gcTime: 0 }, request })
  const remove = useDeleteOAuthProvider({ request })
  const [clientId, setClientId] = useState(provider.clientId ?? '')
  const [teamId, setTeamId] = useState(provider.teamId ?? '')
  const [keyId, setKeyId] = useState(provider.keyId ?? '')
  const [audience, setAudience] = useState<MicrosoftAudience>(audienceOf(provider.tenant))
  const [tenantId, setTenantId] = useState(
    audienceOf(provider.tenant) === 'tenant' ? (provider.tenant ?? '') : ''
  )
  const [enabled, setEnabled] = useState(provider.configured ? provider.enabled : true)
  const [secret, setSecret] = useState('')
  const [replacing, setReplacing] = useState(!provider.configured)
  const [removing, setRemoving] = useState(false)
  const errors = fieldErrorMap(update.error)
  const secretField = apple ? 'privateKey' : 'clientSecret'
  const secretLabel = apple ? 'Private key (.p8)' : 'Client secret'

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['/v1/admin/oauth-providers'] })
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const data: OAuthProviderUpdate = {
      clientId: clientId.trim(),
      enabled,
      ...(apple ? { teamId: teamId.trim(), keyId: keyId.trim() } : {}),
      // Nothing chosen sends no tenant, and the API says it is required: the form has no
      // default to send in its place.
      ...(microsoft && audience !== ''
        ? { tenant: audience === 'tenant' ? tenantId.trim() : audience }
        : {}),
      ...(replacing && secret !== '' ? { [secretField]: secret } : {}),
    }
    update.mutate(
      { provider: provider.provider, data },
      {
        onSuccess: async () => {
          // Saved: the secret has no further use here.
          setSecret('')
          setReplacing(false)
          update.reset()
          await refresh()
          notify(`${name} saved`)
        },
      }
    )
  }

  const known = ['clientId', 'teamId', 'keyId', 'tenant', secretField]
  const general = update.error && !known.some((field) => errors[field])
  return (
    <li className='flex flex-col gap-4 rounded-lg border p-4'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <h3 className='font-semibold'>{name}</h3>
        <span className='rounded-full border border-input px-2 py-0.5 text-xs font-medium'>
          {provider.configured
            ? provider.enabled
              ? 'Enabled'
              : 'Configured, switched off'
            : 'Not configured'}
        </span>
      </div>
      <div className='flex flex-col gap-1.5 text-sm'>
        <span className='font-medium'>Redirect URI to register with {name}</span>
        <code className='rounded-md border bg-muted px-2 py-1.5 text-xs break-all'>
          {provider.callbackUrl}
        </code>
        <CopyButton value={provider.callbackUrl} label='Copy redirect URI' />
      </div>
      <form onSubmit={submit} className='flex flex-col gap-4' noValidate>
        <TextField
          label={
            apple ? 'Services ID (client id)' : microsoft ? 'Application (client) ID' : 'Client ID'
          }
          autoComplete='off'
          spellCheck={false}
          value={clientId}
          onChange={(event) => setClientId(event.target.value)}
          error={errors.clientId}
        />
        {apple ? (
          <div className='grid gap-4 sm:grid-cols-2'>
            <TextField
              label='Team ID'
              autoComplete='off'
              value={teamId}
              onChange={(event) => setTeamId(event.target.value)}
              error={errors.teamId}
            />
            <TextField
              label='Key ID'
              autoComplete='off'
              value={keyId}
              onChange={(event) => setKeyId(event.target.value)}
              error={errors.keyId}
            />
          </div>
        ) : null}
        {microsoft ? (
          <div className='grid gap-4 sm:grid-cols-2'>
            <SelectField
              label='Who can sign in'
              value={audience}
              onChange={(event) => setAudience(event.target.value as MicrosoftAudience)}
              error={audience === 'tenant' ? undefined : errors.tenant}
              hint='Match the “Supported account types” of the app registration.'
            >
              <NativeSelectOption value=''>Choose…</NativeSelectOption>
              {MICROSOFT_AUDIENCES.map(([value, label]) => (
                <NativeSelectOption key={value} value={value}>
                  {label}
                </NativeSelectOption>
              ))}
            </SelectField>
            {audience === 'tenant' ? (
              <TextField
                label='Directory (tenant) ID'
                autoComplete='off'
                spellCheck={false}
                value={tenantId}
                onChange={(event) => setTenantId(event.target.value)}
                error={errors.tenant}
                hint='The tenant’s ID, not its domain name. Only its accounts can sign in.'
              />
            ) : null}
          </div>
        ) : null}
        {replacing ? (
          apple ? (
            <Field
              label={secretLabel}
              error={errors[secretField]}
              hint='Stored sealed. It is never shown again.'
            >
              {(control) => (
                <Textarea
                  {...control}
                  className='bg-field font-mono text-xs'
                  rows={4}
                  autoComplete='off'
                  spellCheck={false}
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                />
              )}
            </Field>
          ) : (
            <TextField
              label={secretLabel}
              type='password'
              autoComplete='off'
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              error={errors[secretField]}
              hint='Stored sealed. It is never shown again.'
            />
          )
        ) : (
          <div className='flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm'>
            <span>
              A {apple ? 'private key' : 'client secret'} is saved
              {provider.updatedAt ? ` (${formatDateTime(provider.updatedAt)})` : ''}. It cannot be
              shown.
            </span>
            <ActionButton variant='outline' size='sm' onClick={() => setReplacing(true)}>
              Replace secret
            </ActionButton>
          </div>
        )}
        <SwitchRow
          label={`Let users sign in with ${name}`}
          checked={enabled}
          onChange={setEnabled}
        />
        {errors.enabled ? (
          <p role='alert' className='text-sm text-destructive'>
            {name} was not switched off: {errors.enabled}. Enable another sign-in method first.
          </p>
        ) : null}
        {general && !errors.enabled ? (
          <p role='alert' className='text-sm text-destructive'>
            {messageFor(update.error)}
          </p>
        ) : null}
        <div className='flex flex-wrap gap-2'>
          <ActionButton type='submit' pending={update.isPending}>
            Save {name}
          </ActionButton>
          {provider.configured ? (
            <ActionButton variant='outline' onClick={() => setRemoving(true)}>
              Remove {name}
            </ActionButton>
          ) : null}
        </div>
      </form>
      <ConfirmDialog
        open={removing}
        title={`Remove ${name} sign-in?`}
        confirmLabel={`Remove ${name}`}
        destructive
        pending={remove.isPending}
        error={remove.error}
        onCancel={() => {
          remove.reset()
          setRemoving(false)
        }}
        onConfirm={() =>
          remove.mutate(
            { provider: provider.provider },
            {
              onSuccess: async () => {
                setRemoving(false)
                setClientId('')
                setTeamId('')
                setKeyId('')
                setAudience('')
                setTenantId('')
                setReplacing(true)
                await refresh()
                notify(`${name} removed`)
              },
            }
          )
        }
      >
        Its saved credentials are deleted and users can no longer sign in with {name}. Accounts
        already linked keep their other sign-in methods.
      </ConfirmDialog>
    </li>
  )
}

/**
 * The OAuth providers of an environment (ADR 0026). Their credentials are not part of the
 * settings document, so each provider is saved on its own.
 *
 * @returns The section.
 */
export function OAuthProviders() {
  const environment = useEnvironment()
  const providers = useListOAuthProviders({ request: useEnvironmentRequest() })
  return (
    <Section
      title='OAuth providers'
      description='Sign-in with Google, GitHub, Apple, Microsoft, Discord and LinkedIn. Each provider is saved separately from the settings above.'
    >
      <QueryState query={providers} label='Loading providers'>
        {(list) => (
          <ul className='grid gap-4 xl:grid-cols-2'>
            {list.data.map((provider) => {
              // A provider of a later server has fields this version cannot know: no card,
              // rather than a form that guesses them.
              const name = own(PROVIDER_NAME, provider.provider)
              return name === undefined ? null : (
                <ProviderCard
                  // The environment is part of the key: a card holds a typed secret, and
                  // two environments' unconfigured providers are otherwise the same key.
                  key={`${environment.id}:${provider.provider}:${provider.updatedAt ?? ''}`}
                  provider={provider}
                  name={name}
                />
              )
            })}
          </ul>
        )}
      </QueryState>
    </Section>
  )
}
