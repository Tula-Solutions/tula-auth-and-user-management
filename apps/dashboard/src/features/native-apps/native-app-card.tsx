import { useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { type NativeApp, useDeleteNativeApp } from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { ConfirmDialog } from '~/components/confirm-dialog'
import { notify } from '~/components/toaster'
import { useEnvironment, useEnvironmentRequest } from '~/features/shell/environment-context'
import { formatDateTime } from '~/lib/format'
import { printable } from '~/lib/printable'
import { EditNativeAppDialog } from './native-app-dialogs'
import { refreshNativeApps } from './queries'
import { identifierOf, nativeAppMessageFor, platformLabel } from './words'

/** Props of {@link NativeAppCard}. */
export interface NativeAppCardProps {
  /** The app as the API lists it. */
  app: NativeApp
  /** Called once the app was removed, before the list is read again. */
  onRemoved?: () => void
}

/**
 * One registered native app: its platform and name, what the served file says of it (the
 * team, or the certificate fingerprints) and what an operator can do to it.
 *
 * @param props - See {@link NativeAppCardProps}.
 * @returns The card.
 */
export function NativeAppCard({ app, onRemoved }: NativeAppCardProps) {
  const titleId = useId()
  const queryClient = useQueryClient()
  const environment = useEnvironment()
  const remove = useDeleteNativeApp({ request: useEnvironmentRequest() })
  const [editing, setEditing] = useState(false)
  const [removing, setRemoving] = useState(false)
  // From the click until the confirmation closes, which is after the list was read again:
  // the request has succeeded well before that, and a button that came back to life in
  // between would send it a second time.
  const [running, setRunning] = useState(false)
  const identifier = identifierOf(app)
  const platform = platformLabel(app.platform)
  // A platform a later server knows: shown, removable, and not editable by this version.
  const known = app.platform === 'ios' || app.platform === 'android'

  function closeConfirmation() {
    remove.reset()
    setRunning(false)
    setRemoving(false)
  }

  function run() {
    setRunning(true)
    remove.mutate(
      { id: app.id },
      {
        onError: () => setRunning(false),
        onSuccess: async () => {
          onRemoved?.()
          await refreshNativeApps(queryClient)
          notify('Native app removed')
          closeConfirmation()
        },
      }
    )
  }

  return (
    <section
      aria-labelledby={titleId}
      data-testid='native-app'
      data-platform={app.platform}
      className='flex flex-col gap-4 rounded-xl border bg-card p-5 text-card-foreground'
    >
      <div className='flex flex-col gap-1'>
        <h2 id={titleId} className='text-sm font-semibold'>
          <span className='rounded-full border border-input px-2 py-0.5 text-xs font-semibold'>
            {platform}
          </span>{' '}
          {/* Server text: written out and rendered as text. */}
          <bdi dir='ltr' className='font-mono break-all'>
            {identifier}
          </bdi>
        </h2>
      </div>
      <dl className='grid gap-3 text-sm sm:grid-cols-2'>
        {app.platform === 'ios' ? (
          <>
            <div className='flex flex-col gap-0.5'>
              <dt className='text-xs font-medium text-muted-foreground'>Team ID</dt>
              <dd className='font-mono'>{printable(app.teamId)}</dd>
            </div>
            <div className='flex flex-col gap-0.5'>
              <dt className='text-xs font-medium text-muted-foreground'>
                Named in Apple’s file as
              </dt>
              <dd className='font-mono break-all'>
                <bdi dir='ltr'>{printable(`${app.teamId}.${app.bundleId}`)}</bdi>
              </dd>
            </div>
          </>
        ) : null}
        {app.platform === 'android' ? (
          <div className='flex flex-col gap-0.5 sm:col-span-2'>
            <dt className='text-xs font-medium text-muted-foreground'>
              Certificate fingerprints (SHA-256)
            </dt>
            <dd>
              <ul className='flex flex-col gap-1'>
                {app.sha256CertFingerprints.map((fingerprint) => (
                  <li key={fingerprint} className='font-mono text-xs break-all'>
                    {printable(fingerprint)}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        ) : null}
        {known ? null : (
          <div className='flex flex-col gap-0.5 sm:col-span-2'>
            <dd>A platform this version of the dashboard does not know.</dd>
          </div>
        )}
        <div className='flex flex-col gap-0.5'>
          <dt className='text-xs font-medium text-muted-foreground'>Registered</dt>
          <dd>{formatDateTime(app.createdAt)}</dd>
        </div>
      </dl>
      <div className='flex flex-wrap items-center gap-2'>
        {known ? (
          <ActionButton
            variant='outline'
            size='sm'
            aria-label={`Edit ${identifier}`}
            onClick={() => setEditing(true)}
          >
            Edit
          </ActionButton>
        ) : null}
        <ActionButton
          variant='destructive'
          size='sm'
          aria-label={`Remove ${identifier}`}
          onClick={() => setRemoving(true)}
        >
          Remove
        </ActionButton>
      </div>
      {known ? (
        <EditNativeAppDialog app={app} open={editing} onClose={() => setEditing(false)} />
      ) : null}
      <ConfirmDialog
        open={removing}
        title={
          <>
            Remove the {platform} app <bdi className='font-mono break-all'>{identifier}</bdi>?
          </>
        }
        confirmLabel='Remove app'
        destructive
        // In production the name is typed: it is what the file stops naming.
        requireText={environment.kind === 'production' ? identifier : undefined}
        pending={running}
        error={remove.error}
        errorText={nativeAppMessageFor}
        onConfirm={run}
        onCancel={closeConfirmation}
      >
        The served file stops naming it within five minutes. Devices and the platforms’ own caches
        keep what they fetched for longer, so the app is not cut off at once. Whatever in the app
        relies on the file (saved passwords, passkeys) stops working once they fetch it again.
      </ConfirmDialog>
    </section>
  )
}
