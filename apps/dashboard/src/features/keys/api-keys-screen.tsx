import { useQueryClient } from '@tanstack/react-query'
import { PUBLISHABLE_KEY_PREFIX, SECRET_KEY_PREFIX } from '@tula/contract'
import { type FormEvent, useEffect, useState } from 'react'
import { fieldErrorMap, messageFor } from '~/api/errors'
import {
  type ApiKey,
  type ApiKeyKind,
  useCreateApiKey,
  useListApiKeys,
  useRevokeApiKey,
} from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { ConfirmDialog } from '~/components/confirm-dialog'
import { CopyButton } from '~/components/copy-button'
import { DataTable } from '~/components/data-table'
import { SelectField, TextField } from '~/components/field'
import { Modal } from '~/components/modal'
import { PageHeader } from '~/components/page'
import { SecretRequestActions } from '~/components/secret-request-actions'
import { EmptyState, QueryState } from '~/components/states'
import { notify } from '~/components/toaster'
import { NativeSelectOption } from '~/components/ui/native-select'
import { useEnvironment, useEnvironmentRequest } from '~/features/shell/environment-context'
import { formatDateTime } from '~/lib/format'

/**
 * How a key is shown once it can no longer be read: its prefix and last four characters.
 *
 * @param key - The key's kind and last four characters.
 * @returns For example `tula_sk_…a1b2`.
 */
export function maskedKey(key: Pick<ApiKey, 'kind' | 'lastFour'>): string {
  return `${key.kind === 'secret' ? SECRET_KEY_PREFIX : PUBLISHABLE_KEY_PREFIX}…${key.lastFour}`
}

/**
 * Create a key, then show it exactly once.
 *
 * The key exists only in this dialog's state. Closing the dialog drops it: it is not kept in
 * the query cache, storage, the address or a log, and the API cannot show it again.
 */
function CreateKeyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  // `gcTime: 0`: the mutation's result (which holds the key) is not kept by the query client
  // after this component lets go of it.
  // The list is refreshed by the mutation itself, so it is right even when this dialog has
  // gone before the answer came. Started, never awaited: the query client waits for what
  // this returns before it hands over the answer, and the key must not wait for a list.
  const create = useCreateApiKey({
    mutation: {
      gcTime: 0,
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: ['/v1/admin/api-keys'] })
      },
    },
    request: useEnvironmentRequest(),
  })
  const [name, setName] = useState('')
  const [kind, setKind] = useState<ApiKeyKind>('publishable')
  const [problem, setProblem] = useState<string>()
  const [created, setCreated] = useState<{ key: string; kind: ApiKeyKind } | null>(null)

  useEffect(() => {
    if (!open) {
      setCreated(null)
      setName('')
      setKind('publishable')
      setProblem(undefined)
    }
  }, [open])

  function close() {
    // The server has made the key by the time it answers; the answer is where the key is.
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
        trimmed === '' ? 'Enter a name, such as “Web app”.' : 'Use 100 characters or fewer.'
      )
      return
    }
    setProblem(undefined)
    create.mutate(
      { data: { kind, name: trimmed } },
      {
        onSuccess: (result) => {
          setCreated({ key: result.key, kind: result.kind })
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
        title='Copy this key now'
        description='This is the only time the key is shown. It is not stored anywhere you can read it again: if it is lost, create a new one.'
        footer={<ActionButton onClick={close}>I have copied it</ActionButton>}
      >
        <div className='flex flex-col gap-3'>
          <code
            data-testid='created-key'
            className='rounded-md border bg-muted px-3 py-2 font-mono text-sm break-all select-all'
          >
            {created.key}
          </code>
          <CopyButton value={created.key} label='Copy key' />
          {created.kind === 'secret' ? (
            <p className='text-sm font-medium text-destructive'>
              A secret key gives full access to this environment. Keep it on a server, never in a
              browser or an app.
            </p>
          ) : null}
        </div>
      </Modal>
    )
  }

  const fieldError = problem ?? fieldErrorMap(create.error).name
  return (
    <Modal open={open} onClose={close} title='Create API key' busy={create.isPending}>
      <form onSubmit={submit} className='flex flex-col gap-4' noValidate>
        <TextField
          label='Name'
          autoComplete='off'
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={fieldError}
          hint='What uses the key. Shown in this list only.'
        />
        <SelectField
          label='Kind'
          value={kind}
          onChange={(event) => setKind(event.target.value as ApiKeyKind)}
          hint='Publishable: for browsers and apps. Secret: for your servers, full access.'
        >
          <NativeSelectOption value='publishable'>Publishable</NativeSelectOption>
          <NativeSelectOption value='secret'>Secret</NativeSelectOption>
        </SelectField>
        {create.error && !fieldError ? (
          <p role='alert' className='text-sm text-destructive'>
            {messageFor(create.error)}
          </p>
        ) : null}
        <SecretRequestActions
          pending={create.isPending}
          onCancel={close}
          submitLabel='Create key'
          pendingLabel='Creating…'
        />
      </form>
    </Modal>
  )
}

/**
 * The API keys of an environment: the list, "create" (shown once) and "revoke".
 *
 * @returns The screen.
 */
export function ApiKeysScreen() {
  const queryClient = useQueryClient()
  const environment = useEnvironment()
  const request = useEnvironmentRequest()
  const keys = useListApiKeys({ request })
  const revoke = useRevokeApiKey({ request })
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState<ApiKey | null>(null)

  return (
    <>
      <PageHeader
        title='API keys'
        description='Publishable keys identify this environment from browsers and apps. Secret keys let your servers manage it.'
        actions={<ActionButton onClick={() => setCreating(true)}>Create key</ActionButton>}
      />
      <QueryState query={keys} label='Loading API keys'>
        {(list) =>
          list.data.length === 0 ? (
            <EmptyState title='No API keys yet'>
              Create a publishable key for your app, and a secret key for your server.
            </EmptyState>
          ) : (
            <div className='rounded-xl border bg-card p-2 sm:p-4'>
              <DataTable
                caption='API keys'
                rows={list.data}
                rowKey={(key) => key.id}
                columns={[
                  {
                    header: 'Name',
                    cell: (key) => <span className='font-medium'>{key.name}</span>,
                  },
                  {
                    header: 'Key',
                    cell: (key) => <code className='text-xs'>{maskedKey(key)}</code>,
                  },
                  {
                    header: 'Kind',
                    cell: (key) => (key.kind === 'secret' ? 'Secret' : 'Publishable'),
                  },
                  { header: 'Created', cell: (key) => formatDateTime(key.createdAt) },
                  { header: 'Last used', cell: (key) => formatDateTime(key.lastUsedAt) },
                  {
                    header: 'Status',
                    cell: (key) =>
                      key.revokedAt ? `Revoked ${formatDateTime(key.revokedAt)}` : 'Active',
                  },
                  {
                    header: 'Actions',
                    cell: (key) =>
                      key.revokedAt ? (
                        <span className='text-muted-foreground'>—</span>
                      ) : (
                        <ActionButton
                          variant='outline'
                          size='sm'
                          onClick={() => setRevoking(key)}
                          aria-label={`Revoke ${key.name}`}
                        >
                          Revoke
                        </ActionButton>
                      ),
                  },
                ]}
              />
            </div>
          )
        }
      </QueryState>
      <CreateKeyDialog open={creating} onClose={() => setCreating(false)} />
      <ConfirmDialog
        open={revoking !== null}
        title={`Revoke “${revoking?.name ?? ''}”?`}
        confirmLabel='Revoke key'
        destructive
        requireText={environment.kind === 'production' ? revoking?.name : undefined}
        pending={revoke.isPending}
        error={revoke.error}
        onCancel={() => {
          revoke.reset()
          setRevoking(null)
        }}
        onConfirm={() => {
          if (revoking === null) {
            return
          }
          revoke.mutate(
            { id: revoking.id },
            {
              onSuccess: async () => {
                await queryClient.invalidateQueries({ queryKey: ['/v1/admin/api-keys'] })
                notify('Key revoked')
                setRevoking(null)
              },
            }
          )
        }}
      >
        Everything that uses {revoking ? maskedKey(revoking) : 'this key'} stops working at once. A
        revoked key cannot be restored.
      </ConfirmDialog>
    </>
  )
}
