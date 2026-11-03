import { useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useEffect, useState } from 'react'
import { fieldErrorMap, messageFor } from '~/api/errors'
import {
  type ScimToken,
  useCreateScimToken,
  useListScimTokens,
  useRevokeScimToken,
} from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { ConfirmDialog } from '~/components/confirm-dialog'
import { CopyButton } from '~/components/copy-button'
import { DataTable } from '~/components/data-table'
import { TextField } from '~/components/field'
import { Modal } from '~/components/modal'
import { Section } from '~/components/page'
import { SecretRequestActions } from '~/components/secret-request-actions'
import { EmptyState, QueryState } from '~/components/states'
import { notify } from '~/components/toaster'
import { useEnvironment, useEnvironmentRequest } from '~/features/shell/environment-context'
import { formatDateTime } from '~/lib/format'
import { printable, printableName } from '~/lib/printable'

const QUERY_ROOT = '/v1/admin/scim-tokens'

/**
 * Create a token, then show it exactly once with the base URL to paste into the provider.
 * The token is component state only: closing the dialog drops it.
 */
function CreateTokenDialog({
  organizationId,
  open,
  onClose,
}: {
  organizationId: string
  open: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  // `gcTime: 0`: the query client does not keep the answer that holds the token. The list is
  // refreshed by the hook itself, started and not awaited (the token must not wait for it).
  const create = useCreateScimToken({
    mutation: {
      gcTime: 0,
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: [QUERY_ROOT] })
      },
    },
    request: useEnvironmentRequest(),
  })
  const [name, setName] = useState('')
  const [problem, setProblem] = useState<string>()
  const [created, setCreated] = useState<{ token: string; baseUrl: string } | null>(null)

  useEffect(() => {
    if (!open) {
      setCreated(null)
      setName('')
      setProblem(undefined)
    }
  }, [open])

  function close() {
    if (create.isPending) {
      return
    }
    setCreated(null)
    create.reset()
    onClose()
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const trimmed = name.trim()
    if (trimmed === '' || trimmed.length > 100) {
      setProblem(
        trimmed === ''
          ? 'Enter a name, such as “Okta provisioning”.'
          : 'Use 100 characters or fewer.'
      )
      return
    }
    setProblem(undefined)
    create.mutate(
      { data: { organizationId, name: trimmed } },
      {
        onSuccess: (result) => {
          setCreated({ token: result.token, baseUrl: result.scimBaseUrl })
          create.reset()
        },
      }
    )
  }

  if (created !== null) {
    return (
      <Modal
        open={open}
        onClose={close}
        title='Copy this token now'
        description='This is the only time the token is shown. It is not stored anywhere you can read it again: if it is lost, create a new one.'
        footer={<ActionButton onClick={close}>I have copied it</ActionButton>}
      >
        <div className='flex flex-col gap-3'>
          <code
            data-testid='created-scim-token'
            className='rounded-md border bg-muted px-3 py-2 font-mono text-sm break-all select-all'
          >
            {created.token}
          </code>
          <CopyButton value={created.token} label='Copy token' />
          <div className='flex flex-col gap-1'>
            <p className='text-sm font-medium'>SCIM base URL</p>
            <code
              data-testid='scim-base-url'
              className='rounded-md border bg-muted px-3 py-2 font-mono text-sm break-all select-all'
            >
              {created.baseUrl}
            </code>
            <CopyButton value={created.baseUrl} label='Copy base URL' />
          </div>
          <p className='text-sm text-muted-foreground'>
            Paste both into the identity provider, the token as a bearer token. It opens the SCIM
            endpoint of this organization and nothing else.
          </p>
        </div>
      </Modal>
    )
  }

  const fieldError = problem ?? fieldErrorMap(create.error).name
  return (
    <Modal open={open} onClose={close} title='Create SCIM token' busy={create.isPending}>
      <form onSubmit={submit} className='flex flex-col gap-4' noValidate>
        <TextField
          label='Name'
          autoComplete='off'
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={fieldError}
          hint='The identity provider it is given to. Shown in this list only.'
        />
        {create.error && !fieldError ? (
          <p role='alert' className='text-sm text-destructive'>
            {messageFor(create.error)}
          </p>
        ) : null}
        <SecretRequestActions
          pending={create.isPending}
          onCancel={close}
          submitLabel='Create token'
          pendingLabel='Creating…'
        />
      </form>
    </Modal>
  )
}

/** Props of {@link ScimSection}. */
export interface ScimSectionProps {
  organizationId: string
  organizationName: string
}

/**
 * An organization's SCIM tokens (ADR 0067): the list with last use and revocation, create
 * (the token is shown once, with the base URL) and revoke (asked first).
 *
 * @param props - See {@link ScimSectionProps}.
 * @returns The section.
 */
export function ScimSection({ organizationId, organizationName: typed }: ScimSectionProps) {
  const organizationName = printableName(typed)
  const queryClient = useQueryClient()
  const environment = useEnvironment()
  const request = useEnvironmentRequest()
  const tokens = useListScimTokens({ organizationId }, { request })
  const revoke = useRevokeScimToken({ request })
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState<ScimToken | null>(null)

  function closeRevoke() {
    revoke.reset()
    setRevoking(null)
  }

  return (
    <Section
      title='SCIM provisioning'
      description={`Let ${organizationName}’s identity provider create, update and remove its people. A token opens the SCIM endpoint of this organization only.`}
      actions={<ActionButton onClick={() => setCreating(true)}>Create token</ActionButton>}
    >
      <QueryState query={tokens} label='Loading SCIM tokens'>
        {(list) =>
          list.tokens.length === 0 ? (
            <EmptyState title='No SCIM tokens'>
              Create one and paste it, with the base URL, into the identity provider.
            </EmptyState>
          ) : (
            <DataTable
              caption='SCIM tokens'
              rows={list.tokens}
              rowKey={(token) => `${environment.id}:${token.id}`}
              columns={[
                {
                  header: 'Name',
                  cell: (token) => <span className='font-medium'>{printableName(token.name)}</span>,
                },
                {
                  header: 'Token',
                  cell: (token) => <code className='text-xs'>{printable(token.prefix)}…</code>,
                },
                { header: 'Created', cell: (token) => formatDateTime(token.createdAt) },
                {
                  header: 'Last used',
                  cell: (token) => (token.lastUsedAt ? formatDateTime(token.lastUsedAt) : 'Never'),
                },
                {
                  header: 'Status',
                  cell: (token) =>
                    token.revokedAt ? `Revoked ${formatDateTime(token.revokedAt)}` : 'Active',
                },
                {
                  header: 'Actions',
                  cell: (token) =>
                    token.revokedAt ? (
                      <span className='text-muted-foreground'>—</span>
                    ) : (
                      <ActionButton
                        variant='outline'
                        size='sm'
                        aria-label={`Revoke ${printableName(token.name)}`}
                        onClick={() => setRevoking(token)}
                      >
                        Revoke
                      </ActionButton>
                    ),
                },
              ]}
            />
          )
        }
      </QueryState>
      <CreateTokenDialog
        organizationId={organizationId}
        open={creating}
        onClose={() => setCreating(false)}
      />
      <ConfirmDialog
        open={revoking !== null}
        title={`Revoke ${revoking ? printableName(revoking.name) : ''}?`}
        confirmLabel='Revoke token'
        destructive
        requireText={
          environment.kind === 'production' && revoking ? printableName(revoking.name) : undefined
        }
        pending={revoke.isPending}
        error={revoke.error}
        onCancel={closeRevoke}
        onConfirm={() => {
          if (revoking === null) {
            return
          }
          revoke.mutate(
            { id: revoking.id, params: { organizationId } },
            {
              onSuccess: async () => {
                await queryClient.invalidateQueries({ queryKey: [QUERY_ROOT] })
                notify('Token revoked')
                closeRevoke()
              },
            }
          )
        }}
      >
        The identity provider that holds it is refused from its next request. People it provisioned
        keep their accounts. A revoked token cannot be restored.
      </ConfirmDialog>
    </Section>
  )
}
