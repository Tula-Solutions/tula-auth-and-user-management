import { useQueryClient } from '@tanstack/react-query'
import {
  givesNoAddress,
  isGoogleClientId,
  MAX_ADDITIONAL_CLIENT_IDS,
  oauthProviderWeakenings,
  ownClientIdAmong,
} from '@tula/contract'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { fieldErrorMap, messageFor } from '~/api/errors'
import {
  type OAuthProviderDependents,
  type OAuthProviderSettings,
  type OAuthProviderUpdate,
  useDeleteOAuthProvider,
  useGetOAuthProviderDependents,
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
  x: 'X',
  facebook: 'Facebook',
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

/** A text area's lines as a set of client ids: trimmed, blank lines dropped, each once. */
function clientIdsIn(text: string): string[] {
  return [
    ...new Set(
      text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
    ),
  ]
}

/**
 * Why a list of native client ids would be refused, by the contract's own rules
 * (`isGoogleClientId`, `MAX_ADDITIONAL_CLIENT_IDS`, `ownClientIdAmong`), or `undefined`.
 * The line is named by its place among the ids, never repeated.
 */
function clientIdsProblem(clientId: string, ids: readonly string[]): string | undefined {
  if (ids.length > MAX_ADDITIONAL_CLIENT_IDS) {
    return `At most ${MAX_ADDITIONAL_CLIENT_IDS} client IDs.`
  }
  const bad = ids.findIndex((id) => !isGoogleClientId(id))
  if (bad !== -1) {
    return `Line ${bad + 1} is not a Google OAuth client ID (it ends in .apps.googleusercontent.com).`
  }
  const own = ownClientIdAmong(clientId, ids)
  return own === -1
    ? undefined
    : `Line ${own + 1} is the client ID above. Its tokens are accepted already: list only the other clients.`
}

/**
 * The accounts that depend on a provider, as the server counted them just now
 * (`GET /v1/admin/oauth-providers/{provider}/dependents`, ADR 0059), or `'uncounted'` when
 * the count could not be read (a failed request, a server from before the route). Never
 * read as "none": an unread count is asked about in its own words.
 */
type Counted = Pick<OAuthProviderDependents, 'accounts' | 'more'> | 'uncounted'

/** The providers that give no address, by the contract's list, as "X or Facebook". */
const NO_ADDRESS_PROVIDERS = (Object.keys(PROVIDER_NAME) as OAuthProviderSettings['provider'][])
  .filter((provider) => givesNoAddress(provider))
  .map((provider) => PROVIDER_NAME[provider])
  .join(' or ')

/**
 * What a confirmation says about the accounts that depend on a provider: the count in words
 * and what happens to them. A count and nothing else: the server says nothing about who.
 *
 * `more` means the server did not look at every account, so the number is a floor.
 *
 * @param name - The provider's label.
 * @param counted - The server's count, or that there is none.
 * @param span - For how long they are locked out ("while X is off").
 */
function dependentsText(name: string, counted: Counted, span: string): string {
  const noAddress = `An account with no email address (one made by signing in with ${NO_ADDRESS_PROVIDERS}) cannot recover by itself: it stays locked out until ${name} is back or an administrator gives it an address.`
  if (counted === 'uncounted') {
    return `The number of accounts that can sign in only with ${name} could not be counted. Any that can will not be able to sign in ${span}. ${noAddress} If an account depends on ${name}, the change is recorded in the audit log as one that weakens security.`
  }
  const recorded = 'The change is recorded in the audit log as one that weakens security.'
  if (counted.accounts === 0) {
    // `more` with none found among the accounts looked at: a floor of nothing is no number.
    return `${name} has more accounts than the server looks at, so the number that can sign in only with ${name} is not known. Any that can will not be able to sign in ${span}. ${noAddress} ${recorded}`
  }
  const number = counted.accounts.toLocaleString('en-US')
  const accounts = `${counted.more ? 'At least ' : ''}${number} ${counted.accounts === 1 ? 'account' : 'accounts'}`
  const they = counted.accounts === 1 && !counted.more ? 'It' : 'They'
  return `${accounts} can sign in only with ${name}. ${they} will not be able to sign in ${span}. ${noAddress} ${recorded}`
}

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
  const environment = useEnvironment()
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
  // Google's native app client ids (ADR 0045): a set, one to a line. A server from before
  // the field lists none.
  const google = provider.provider === 'google'
  const storedClientIds = provider.additionalClientIds ?? []
  const [clientIdLines, setClientIdLines] = useState(storedClientIds.join('\n'))
  const [clientIdsError, setClientIdsError] = useState<string>()
  const [widening, setWidening] = useState<OAuthProviderUpdate>()
  const [confirmed, setConfirmed] = useState(false)
  // The accounts that depend on the provider (ADR 0059) are counted when a provider that is
  // on is about to be switched off or removed, and at no other time: never on mount, never
  // kept (`gcTime: 0`, `staleTime: 0`), so the question is asked about the count of now.
  const dependents = useGetOAuthProviderDependents(provider.provider, {
    query: { enabled: false, retry: false, staleTime: 0, gcTime: 0 },
    request,
  })
  const [counting, setCounting] = useState<'save' | 'remove'>()
  const [switchingOff, setSwitchingOff] = useState<{
    data: OAuthProviderUpdate
    counted: Counted
  }>()
  // What was counted for the removal that is being asked about; none for a provider that
  // is off, which nobody signs in with.
  const [removalCount, setRemovalCount] = useState<Counted>()
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const errors = fieldErrorMap(update.error)
  const secretField = apple ? 'privateKey' : 'clientSecret'
  const secretLabel = apple ? 'Private key (.p8)' : 'Client secret'
  const refusedClientIds = Object.entries(errors).find(
    ([field]) => field === 'additionalClientIds' || field.startsWith('additionalClientIds.')
  )?.[1]

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['/v1/admin/oauth-providers'] })
  }

  function send(data: OAuthProviderUpdate) {
    update.mutate(
      { provider: provider.provider, data },
      {
        onSuccess: async () => {
          // Saved: the secret has no further use here.
          setSecret('')
          setReplacing(false)
          setWidening(undefined)
          setSwitchingOff(undefined)
          update.reset()
          await refresh()
          notify(`${name} saved`)
        },
        // A refused save is shown in the form, and its question can be asked again.
        onError: () => {
          setWidening(undefined)
          setSwitchingOff(undefined)
          setConfirmed(false)
        },
      }
    )
  }

  /**
   * Ask the server, now, how many accounts depend on the provider. `undefined` when there
   * is nobody to tell: a count is already being read, or the card is gone (a switch of
   * environment), and then nothing may follow from the answer.
   */
  async function count(reason: 'save' | 'remove'): Promise<Counted | undefined> {
    if (counting !== undefined) {
      return undefined
    }
    setCounting(reason)
    const answer = await dependents.refetch()
    if (!mounted.current) {
      return undefined
    }
    setCounting(undefined)
    const data = answer.data
    return answer.status === 'success' &&
      data !== undefined &&
      typeof data.accounts === 'number' &&
      typeof data.more === 'boolean'
      ? { accounts: data.accounts, more: data.more }
      : 'uncounted'
  }

  /**
   * A save that switches off a provider that is on: counted first, and judged by the
   * contract's rule with the count. An unread count is asked about too, in its own words.
   */
  async function switchOff(data: OAuthProviderUpdate, gains: boolean) {
    const counted = await count('save')
    if (counted === undefined) {
      return
    }
    const weakens =
      counted === 'uncounted' ||
      oauthProviderWeakenings({ enabled: true, dependents: counted }, { enabled: false }).includes(
        'enabled'
      )
    setConfirmed(false)
    if (weakens) {
      setSwitchingOff({ data, counted })
    } else if (gains) {
      setWidening(data)
    } else {
      send(data)
    }
  }

  /** The removal's question, with the count of now for a provider that is on. */
  async function askRemoval() {
    if (!provider.enabled) {
      setRemovalCount(undefined)
      setRemoving(true)
      return
    }
    const counted = await count('remove')
    if (counted !== undefined) {
      setRemovalCount(counted)
      setRemoving(true)
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const additionalClientIds = clientIdsIn(clientIdLines)
    const problem = google ? clientIdsProblem(clientId.trim(), additionalClientIds) : undefined
    setClientIdsError(problem)
    if (problem !== undefined) {
      return
    }
    const data: OAuthProviderUpdate = {
      clientId: clientId.trim(),
      enabled,
      // Always sent for Google: the request replaces the record, so leaving the ids out
      // would remove them.
      ...(google ? { additionalClientIds } : {}),
      ...(apple ? { teamId: teamId.trim(), keyId: keyId.trim() } : {}),
      // Nothing chosen sends no tenant, and the API says it is required: the form has no
      // default to send in its place.
      ...(microsoft && audience !== ''
        ? { tenant: audience === 'tenant' ? tenantId.trim() : audience }
        : {}),
      ...(replacing && secret !== '' ? { [secretField]: secret } : {}),
    }
    // What is asked about first is the contract's rule, the one the server records
    // `weakened` with: a client id gained.
    const gains =
      google &&
      oauthProviderWeakenings({ additionalClientIds: storedClientIds }, { additionalClientIds })
        .length > 0
    // A provider that is on, saved as off: the accounts that depend on it are counted
    // before anything is sent (ADR 0059).
    if (provider.enabled && !enabled) {
      void switchOff(data, gains)
      return
    }
    if (gains) {
      setConfirmed(false)
      setWidening(data)
      return
    }
    send(data)
  }

  const gained = clientIdsIn(clientIdLines).filter((id) => !storedClientIds.includes(id)).length
  // Whether the removal being asked about is one the contract calls a weakening, or one
  // whose count could not be read: then it says so and, in production, the name is typed.
  const removalAsksMore =
    removalCount !== undefined &&
    (removalCount === 'uncounted' ||
      oauthProviderWeakenings({ enabled: true, dependents: removalCount }, null).includes(
        'enabled'
      ))
  const known = ['clientId', 'teamId', 'keyId', 'tenant', secretField]
  const general =
    update.error && !known.some((field) => errors[field]) && refusedClientIds === undefined
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
      {givesNoAddress(provider.provider) ? (
        <p className='text-sm text-muted-foreground'>
          {name} is asked for no email address. An account made by signing in with {name} has none:
          it is never joined to an account that has one, gets no security emails and cannot sign in
          by email or reset a password.
        </p>
      ) : null}
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
        {google ? (
          <Field
            label='OAuth clients of your Android and iOS apps'
            error={clientIdsError ?? refusedClientIds}
            hint={`Optional. Their client IDs, one to a line, at most ${MAX_ADDITIONAL_CLIENT_IDS}. A native app that signs in with Google hands the server an ID token; the server accepts one made for the client ID above or for one listed here. Each is another app whose tokens can sign users in, so list only your own.`}
          >
            {(control) => (
              <Textarea
                {...control}
                className='bg-field font-mono text-xs'
                rows={3}
                autoComplete='off'
                spellCheck={false}
                value={clientIdLines}
                onChange={(event) => setClientIdLines(event.target.value)}
              />
            )}
          </Field>
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
          <ActionButton type='submit' pending={update.isPending || counting === 'save'}>
            Save {name}
          </ActionButton>
          {provider.configured ? (
            <ActionButton
              variant='outline'
              pending={counting === 'remove'}
              onClick={() => void askRemoval()}
            >
              Remove {name}
            </ActionButton>
          ) : null}
        </div>
      </form>
      <ConfirmDialog
        open={switchingOff !== undefined}
        title={`Switch ${name} off?`}
        confirmLabel={`Switch ${name} off`}
        destructive
        // In production the provider's name is typed, as for its other weakening.
        requireText={environment.kind === 'production' ? name : undefined}
        // Unavailable from the click until the dialog closes: a confirmed change is sent once.
        pending={confirmed}
        onCancel={() => setSwitchingOff(undefined)}
        onConfirm={() => {
          if (switchingOff !== undefined && !confirmed) {
            setConfirmed(true)
            send(switchingOff.data)
          }
        }}
      >
        {switchingOff === undefined
          ? null
          : dependentsText(name, switchingOff.counted, `while ${name} is off`)}
        {gained > 0
          ? ` The save also adds ${gained === 1 ? 'a client ID' : `${gained} client IDs`}: an ID token that ${name} made for one can sign users in once ${name} is on again.`
          : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={widening !== undefined}
        title={`Accept ${name} ID tokens from ${gained} more ${gained === 1 ? 'app' : 'apps'}?`}
        confirmLabel='Accept their tokens'
        // In production the provider's name is typed, as a hook's point is for a weakening.
        requireText={environment.kind === 'production' ? name : undefined}
        // Unavailable from the click until the dialog closes: a confirmed change is sent once.
        pending={confirmed}
        onCancel={() => setWidening(undefined)}
        onConfirm={() => {
          if (widening !== undefined && !confirmed) {
            setConfirmed(true)
            send(widening)
          }
        }}
      >
        An ID token that {name} made for{' '}
        {gained === 1 ? 'the client ID you added' : 'a client ID you added'} can sign users in to
        this environment, as one made for the client ID above already can. Add only the client IDs
        of your own apps. The change is recorded in the audit log as one that weakens security.
      </ConfirmDialog>
      <ConfirmDialog
        open={removing}
        title={`Remove ${name} sign-in?`}
        confirmLabel={`Remove ${name}`}
        destructive
        requireText={removalAsksMore && environment.kind === 'production' ? name : undefined}
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
                setClientIdLines('')
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
        {removalAsksMore && removalCount !== undefined
          ? ` ${dependentsText(name, removalCount, `until ${name} is configured again`)}`
          : null}
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
      description='Sign-in with Google, GitHub, Apple, Microsoft, Discord, LinkedIn, X and Facebook. Each provider is saved separately from the settings above.'
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
