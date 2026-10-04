import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  getListSigningKeysQueryKey,
  type SigningKeyStatus,
  useListSigningKeys,
  useRotateSigningKeys,
} from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { ConfirmDialog } from '~/components/confirm-dialog'
import { DataTable } from '~/components/data-table'
import { PageHeader, Section } from '~/components/page'
import { QueryState } from '~/components/states'
import { notify } from '~/components/toaster'
import { useEnvironmentRequest } from '~/features/shell/environment-context'
import { formatDateTime } from '~/lib/format'

const STATUS: Record<SigningKeyStatus, { label: string; meaning: string }> = {
  active: { label: 'Active', meaning: 'Signs new access tokens.' },
  next: { label: 'Next', meaning: 'Published already; becomes active at the next rotation.' },
  retired: { label: 'Retired', meaning: 'Signs nothing; still published so its tokens verify.' },
}

/**
 * The signing keys of an environment, and rotation.
 *
 * Only public facts are shown (id, status, dates): private keys never leave the server.
 *
 * @returns The screen.
 */
export function SigningKeysScreen() {
  const queryClient = useQueryClient()
  const request = useEnvironmentRequest()
  const keys = useListSigningKeys({ request })
  const rotate = useRotateSigningKeys({ request })
  const [confirming, setConfirming] = useState(false)

  return (
    <>
      <PageHeader
        title='Signing keys'
        description='The keys that sign this environment’s access tokens. Your apps verify tokens with the public halves, which are published at the environment’s JWKS address.'
        actions={<ActionButton onClick={() => setConfirming(true)}>Rotate keys</ActionButton>}
      />
      <Section
        title='What rotating does'
        description='Rotate on a schedule, or at once if a key may have leaked.'
      >
        <ol className='list-decimal pl-5 text-sm'>
          <li>The “next” key becomes the active one and signs every new token.</li>
          <li>
            The active key is retired. It stays published, so tokens it already signed keep
            verifying until they expire (about a minute).
          </li>
          <li>A new “next” key is created and published ahead of the following rotation.</li>
        </ol>
        <p className='text-sm text-muted-foreground'>
          Nobody is signed out. A key that was published only moments ago cannot be activated yet:
          the API refuses a rotation until every verifier has had time to fetch it.
        </p>
      </Section>
      <QueryState query={keys} label='Loading signing keys'>
        {(list) => (
          <div className='rounded-xl border bg-card p-2 sm:p-4'>
            <DataTable
              caption='Signing keys'
              rows={list.data}
              rowKey={(key) => key.id}
              columns={[
                {
                  header: 'Status',
                  cell: (key) => (
                    <span data-status={key.status}>
                      <span className='font-semibold'>{STATUS[key.status].label}</span>
                      <span className='block text-xs text-muted-foreground'>
                        {STATUS[key.status].meaning}
                      </span>
                    </span>
                  ),
                },
                { header: 'Key id', cell: (key) => <code className='text-xs'>{key.id}</code> },
                { header: 'Created', cell: (key) => formatDateTime(key.createdAt) },
                { header: 'Activated', cell: (key) => formatDateTime(key.activatedAt, 'Not yet') },
                { header: 'Retired', cell: (key) => formatDateTime(key.retiredAt, '—') },
              ]}
            />
          </div>
        )}
      </QueryState>
      <ConfirmDialog
        open={confirming}
        title='Rotate this environment’s signing keys?'
        confirmLabel='Rotate keys'
        pending={rotate.isPending}
        error={rotate.error}
        onCancel={() => {
          rotate.reset()
          setConfirming(false)
        }}
        onConfirm={() =>
          rotate.mutate(undefined, {
            onSuccess: (list) => {
              queryClient.setQueryData(getListSigningKeysQueryKey(), list)
              notify('Signing keys rotated')
              setConfirming(false)
            },
          })
        }
      >
        The next key starts signing, the current one is retired and a new next key is published.
        Sessions are not affected.
      </ConfirmDialog>
    </>
  )
}
