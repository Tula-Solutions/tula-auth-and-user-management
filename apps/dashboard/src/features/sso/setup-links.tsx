import { useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useEffect, useState } from 'react'
import { fieldErrorMap, messageFor } from '~/api/errors'
import {
  type SetupLink,
  useCreateSetupLink,
  useListSetupLinks,
  useRevokeSetupLink,
} from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { ConfirmDialog } from '~/components/confirm-dialog'
import { CopyButton } from '~/components/copy-button'
import { TextField } from '~/components/field'
import { Modal } from '~/components/modal'
import { SecretRequestActions } from '~/components/secret-request-actions'
import { QueryState } from '~/components/states'
import { notify } from '~/components/toaster'
import { Badge } from '~/components/ui/badge'
import { useEnvironmentRequest } from '~/features/shell/environment-context'
import { formatDateTime } from '~/lib/format'
import { printableName } from '~/lib/printable'

/** Ask again for the setup link lists on screen (the generated keys are paths). */
function refreshLinks(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (query) =>
      typeof query.queryKey[0] === 'string' &&
      query.queryKey[0].startsWith('/v1/admin/setup-links'),
  })
}

/**
 * Create a setup link, then show its address exactly once.
 *
 * The address holds the link's token. It exists only in this dialog's state: closing the dialog
 * drops it, it is not kept in the query cache, storage or a log, and the API cannot show it again.
 */
function CreateLinkDialog({
  organizationId,
  open,
  onClose,
}: {
  organizationId: string
  open: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  // `gcTime: 0` so the client drops the answer (it holds the token) once this lets go of it; the
  // list is refreshed by the hook itself, started and not awaited, so the address never waits.
  const create = useCreateSetupLink({
    mutation: {
      gcTime: 0,
      onSuccess: () => {
        void refreshLinks(queryClient)
      },
    },
    request: useEnvironmentRequest(),
  })
  const [name, setName] = useState('SSO setup')
  const [days, setDays] = useState('7')
  const [problem, setProblem] = useState<string>()
  const [created, setCreated] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setCreated(null)
      setName('SSO setup')
      setDays('7')
      setProblem(undefined)
    }
  }, [open])

  function close() {
    // The server has made the link by the time it answers; the answer is where the address is.
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
    const count = Number(days)
    if (trimmed === '' || trimmed.length > 100) {
      setProblem('Enter a name of 1 to 100 characters.')
      return
    }
    if (!Number.isInteger(count) || count < 1 || count > 30) {
      setProblem('Choose between 1 and 30 days.')
      return
    }
    setProblem(undefined)
    create.mutate(
      { data: { organizationId, name: trimmed, expiresInDays: count } },
      {
        onSuccess: (result) => {
          setCreated(result.url)
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
        title='Copy this setup link now'
        description='This is the only time the link is shown. Send it to the person who sets up single sign-on; anyone who holds it can change this organization’s connections until it expires or you revoke it.'
        footer={<ActionButton onClick={close}>I have copied it</ActionButton>}
      >
        <div className='flex flex-col gap-3'>
          <code
            data-testid='created-setup-link'
            className='rounded-md border bg-muted px-3 py-2 font-mono text-sm break-all select-all'
          >
            {created}
          </code>
          <CopyButton value={created} label='Copy link' />
        </div>
      </Modal>
    )
  }

  const fieldError = problem ?? fieldErrorMap(create.error).name
  return (
    <Modal open={open} onClose={close} title='Create a setup link' busy={create.isPending}>
      <form onSubmit={submit} className='flex flex-col gap-4' noValidate>
        <TextField
          label='Name'
          autoComplete='off'
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={fieldError}
          hint='Who it is for. Shown in this list only.'
        />
        <TextField
          label='Days it works'
          inputMode='numeric'
          value={days}
          onChange={(event) => setDays(event.target.value)}
          hint='1 to 30. The link can be revoked sooner.'
        />
        {create.error && !fieldError ? (
          <p role='alert' className='text-sm text-destructive'>
            {messageFor(create.error)}
          </p>
        ) : null}
        <SecretRequestActions
          pending={create.isPending}
          onCancel={close}
          submitLabel='Create link'
          pendingLabel='Creating…'
        />
      </form>
    </Modal>
  )
}

function standing(link: SetupLink, now: number): 'Revoked' | 'Expired' | 'Active' {
  if (link.revokedAt) {
    return 'Revoked'
  }
  return Date.parse(link.expiresAt) <= now ? 'Expired' : 'Active'
}

/**
 * An organization’s setup links (ADR 0067, "Setup links"): the list, "create" (the address is
 * shown once) and "revoke".
 *
 * @param props - `organizationId`: the organization the links belong to.
 * @returns The block.
 */
export function SetupLinks({ organizationId }: { organizationId: string }) {
  const queryClient = useQueryClient()
  const request = useEnvironmentRequest()
  const links = useListSetupLinks({ organizationId }, { request })
  const revoke = useRevokeSetupLink({ request })
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState<SetupLink | null>(null)

  function closeRevoke() {
    revoke.reset()
    setRevoking(null)
  }

  function runRevoke() {
    if (revoking === null) {
      return
    }
    revoke.mutate(
      { id: revoking.id, params: { organizationId } },
      {
        onSuccess: async () => {
          await refreshLinks(queryClient)
          notify('Setup link revoked')
          closeRevoke()
        },
      }
    )
  }

  return (
    <div className='flex flex-col gap-3 border-t pt-4'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div>
          <h3 className='text-base font-medium'>Setup links</h3>
          <p className='text-sm text-muted-foreground'>
            Let the organization’s IT administrator set up a connection without an account.
          </p>
        </div>
        <ActionButton variant='outline' onClick={() => setCreating(true)}>
          Create setup link
        </ActionButton>
      </div>
      <QueryState query={links} label='Loading setup links'>
        {(list) =>
          list.links.length === 0 ? (
            <p className='text-sm text-muted-foreground'>No setup links.</p>
          ) : (
            <ul className='flex flex-col gap-2'>
              {list.links.map((link) => {
                const state = standing(link, Date.now())
                const name = printableName(link.name)
                return (
                  <li
                    key={link.id}
                    aria-label={`Setup link ${name}`}
                    className='flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm'
                  >
                    <div className='flex flex-wrap items-center gap-2'>
                      <span className='font-medium'>{name}</span>
                      <code className='text-xs'>{link.prefix}…</code>
                      <Badge variant='outline'>{state}</Badge>
                      <span className='text-muted-foreground'>
                        Expires {formatDateTime(link.expiresAt)}
                        {link.lastUsedAt ? `, last used ${formatDateTime(link.lastUsedAt)}` : ''}
                      </span>
                    </div>
                    {state === 'Active' ? (
                      <ActionButton
                        variant='outline'
                        size='sm'
                        aria-label={`Revoke ${name}`}
                        onClick={() => setRevoking(link)}
                      >
                        Revoke
                      </ActionButton>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )
        }
      </QueryState>
      <CreateLinkDialog
        organizationId={organizationId}
        open={creating}
        onClose={() => setCreating(false)}
      />
      <ConfirmDialog
        open={revoking !== null}
        title={`Revoke ${revoking ? printableName(revoking.name) : ''}?`}
        confirmLabel='Revoke link'
        destructive
        pending={revoke.isPending}
        error={revoke.error}
        errorText={messageFor}
        onConfirm={runRevoke}
        onCancel={closeRevoke}
      >
        The link stops working at once. Connections already set up through it are kept.
      </ConfirmDialog>
    </div>
  )
}
