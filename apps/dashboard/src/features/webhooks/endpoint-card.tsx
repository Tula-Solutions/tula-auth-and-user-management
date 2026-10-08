import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { type ReactNode, useId, useState } from 'react'
import {
  useDeleteWebhookEndpoint,
  useRevokePreviousWebhookSecret,
  useUpdateWebhookEndpoint,
  type WebhookEndpoint,
} from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { ConfirmDialog } from '~/components/confirm-dialog'
import { notify } from '~/components/toaster'
import { useEnvironment, useEnvironmentRequest } from '~/features/shell/environment-context'
import type { EnvironmentScope } from '~/features/users/users-screen'
import { formatDateTime } from '~/lib/format'
import { cn } from '~/lib/utils'
import { EditEndpointDialog } from './edit-endpoint-dialog'
import { forgetEndpoint, refreshWebhooks } from './queries'
import { Moment, RotateSecretDialog } from './rotate-secret-dialog'
import { TestEventDialog } from './test-event-dialog'
import { endpointState, webhookMessageFor } from './words'

/**
 * An endpoint's state as a badge and a sentence: in words, never colour alone.
 *
 * @param props - `endpoint`: the endpoint as the API lists it.
 * @returns The badge and what it means.
 */
export function EndpointState({
  endpoint,
}: {
  endpoint: Pick<WebhookEndpoint, 'enabled' | 'disabledReason' | 'failingSince'>
}) {
  const state = endpointState(endpoint)
  const alarming = state.kind === 'failing' || state.kind === 'off-by-server'
  return (
    <p
      data-testid='endpoint-state'
      data-state={state.kind}
      className='flex flex-col items-start gap-1 text-sm'
    >
      <span
        className={cn(
          'rounded-full border px-2 py-0.5 text-xs font-semibold',
          alarming ? 'border-destructive bg-destructive-surface text-destructive' : 'border-input'
        )}
      >
        {state.label}
      </span>
      {/* Server text (a reason a later server knows) is rendered as text, like all of it. */}
      <span className='text-muted-foreground'>{state.detail}</span>
    </p>
  )
}

/** Which confirmation the card is asking. */
type Confirmation = 'off' | 'on' | 'end-overlap' | 'delete'

/** Props of {@link EndpointCard}. */
export interface EndpointCardProps {
  /** The ids of the environment's address, for the links. */
  scope: EnvironmentScope
  endpoint: WebhookEndpoint
  /** Leave the "Deliveries" link out: the card is drawn on that screen. */
  hideDeliveriesLink?: boolean
  /** Called once the endpoint has been deleted. */
  onDeleted?: () => void
}

/**
 * One webhook endpoint: its address, how it is doing, what it subscribes to, and everything
 * an operator can do to it.
 *
 * @param props - See {@link EndpointCardProps}.
 * @returns The card.
 */
export function EndpointCard({
  scope,
  endpoint,
  hideDeliveriesLink,
  onDeleted,
}: EndpointCardProps) {
  const titleId = useId()
  const queryClient = useQueryClient()
  const environment = useEnvironment()
  const request = useEnvironmentRequest()
  const update = useUpdateWebhookEndpoint({ request })
  const remove = useDeleteWebhookEndpoint({ request })
  const revoke = useRevokePreviousWebhookSecret({ request })
  const [editing, setEditing] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [testing, setTesting] = useState(false)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const url = endpoint.url

  function closeConfirmation() {
    update.reset()
    remove.reset()
    revoke.reset()
    setConfirmation(null)
  }

  async function done(message: string) {
    await refreshWebhooks(queryClient)
    notify(message)
    closeConfirmation()
  }

  function switchTo(enabled: boolean) {
    update.mutate(
      { id: endpoint.id, data: { enabled } },
      { onSuccess: () => done(enabled ? 'Endpoint switched on' : 'Endpoint switched off') }
    )
  }

  const dialogs: Record<
    Confirmation,
    {
      title: string
      label: string
      body: ReactNode
      destructive?: boolean
      /** Ask for the endpoint's address to be typed first. */
      typed?: boolean
      pending: boolean
      error: unknown
      run: () => void
    }
  > = {
    off: {
      title: `Switch off ${url}?`,
      label: 'Switch off',
      body: 'Nothing is sent to it while it is off, and events that happen while it is off are not sent later. Deliveries that are pending wait, and are given up once they are three days old.',
      pending: update.isPending,
      error: update.error,
      run: () => switchTo(false),
    },
    on: {
      title: `Switch on ${url}?`,
      label: 'Switch on',
      body: 'Events of its types are delivered to it again from now on. Deliveries that were pending are tried again unless they are more than three days old. The server forgets why it was off and since when it was failing.',
      pending: update.isPending,
      error: update.error,
      run: () => switchTo(true),
    },
    'end-overlap': {
      title: 'End the overlap now?',
      label: 'End the overlap',
      body: 'The previous secret stops signing at once and is deleted. Do this once your receiver verifies with the new secret, or when the previous one has leaked. A receiver that still verifies with the previous secret alone refuses every delivery from then on, until it is given the new one.',
      destructive: true,
      pending: revoke.isPending,
      error: revoke.error,
      run: () =>
        revoke.mutate(
          { id: endpoint.id },
          { onSuccess: () => done('Overlap ended: one secret signs') }
        ),
    },
    delete: {
      title: `Delete ${url}?`,
      label: 'Delete endpoint',
      body: 'Nothing more is delivered to it. Its signing secret, its pending deliveries and the log of everything delivered to it are deleted with it, and cannot be brought back.',
      destructive: true,
      // In production the address is typed: it names the endpoint, and it is what is lost.
      typed: environment.kind === 'production',
      pending: remove.isPending,
      error: remove.error,
      run: () =>
        remove.mutate(
          { id: endpoint.id },
          {
            onSuccess: async () => {
              // First, so that a screen about this endpoint stops asking for it before the
              // lists are read again.
              forgetEndpoint(queryClient, endpoint.id)
              onDeleted?.()
              await done('Endpoint deleted')
            },
          }
        ),
    },
  }
  const active = confirmation ? dialogs[confirmation] : null

  return (
    <section
      aria-labelledby={titleId}
      className='flex flex-col gap-4 rounded-xl border bg-card p-5 text-card-foreground'
    >
      <div className='flex flex-col gap-2'>
        {/* The address is the endpoint's name. Server text: rendered as text, never a link. */}
        <h2 id={titleId} className='font-mono text-sm font-semibold break-all'>
          {url}
        </h2>
        <EndpointState endpoint={endpoint} />
      </div>
      <dl className='grid gap-3 text-sm sm:grid-cols-2'>
        <div className='flex flex-col gap-0.5 sm:col-span-2'>
          <dt className='text-xs font-medium text-muted-foreground'>Event types</dt>
          <dd className='break-words'>{endpoint.eventTypes.join(', ')}</dd>
        </div>
        <div className='flex flex-col gap-0.5'>
          <dt className='text-xs font-medium text-muted-foreground'>Added</dt>
          <dd>{formatDateTime(endpoint.createdAt)}</dd>
        </div>
      </dl>
      {endpoint.rotationOverlapEndsAt ? (
        <div
          data-testid='rotation-overlap'
          className='flex flex-col items-start gap-2 rounded-md border px-3 py-2 text-sm'
        >
          <p>
            Two secrets are signing: every delivery carries a signature for the new secret and one
            for the previous secret, until <Moment iso={endpoint.rotationOverlapEndsAt} />. After
            that only the new one signs.
          </p>
          <ActionButton
            variant='outline'
            size='sm'
            aria-label={`End the secret overlap of ${url} now`}
            onClick={() => setConfirmation('end-overlap')}
          >
            End the overlap now
          </ActionButton>
        </div>
      ) : null}
      <div className='flex flex-wrap items-center gap-2'>
        {hideDeliveriesLink ? null : (
          <Link
            to='/w/$workspaceId/p/$projectId/e/$environmentId/webhooks/$endpointId'
            params={{ ...scope, endpointId: endpoint.id }}
            className='mr-2 text-sm font-medium text-link underline underline-offset-4'
          >
            Deliveries
          </Link>
        )}
        <ActionButton
          variant='outline'
          size='sm'
          aria-label={`Edit ${url}`}
          onClick={() => setEditing(true)}
        >
          Edit
        </ActionButton>
        <ActionButton
          variant='outline'
          size='sm'
          aria-label={`${endpoint.enabled ? 'Switch off' : 'Switch on'} ${url}`}
          onClick={() => setConfirmation(endpoint.enabled ? 'off' : 'on')}
        >
          {endpoint.enabled ? 'Switch off' : 'Switch on'}
        </ActionButton>
        <ActionButton
          variant='outline'
          size='sm'
          aria-label={`Send a test event to ${url}`}
          onClick={() => setTesting(true)}
        >
          Send a test event
        </ActionButton>
        <ActionButton
          variant='outline'
          size='sm'
          aria-label={`Rotate the secret of ${url}`}
          onClick={() => setRotating(true)}
        >
          Rotate the secret
        </ActionButton>
        <ActionButton
          variant='destructive'
          size='sm'
          aria-label={`Delete ${url}`}
          onClick={() => setConfirmation('delete')}
        >
          Delete
        </ActionButton>
      </div>
      <EditEndpointDialog endpoint={endpoint} open={editing} onClose={() => setEditing(false)} />
      <RotateSecretDialog endpoint={endpoint} open={rotating} onClose={() => setRotating(false)} />
      <TestEventDialog
        scope={scope}
        endpoint={endpoint}
        open={testing}
        onClose={() => setTesting(false)}
      />
      <ConfirmDialog
        open={active !== null}
        title={active?.title ?? ''}
        confirmLabel={active?.label ?? ''}
        destructive={active?.destructive}
        requireText={active?.typed ? url : undefined}
        pending={active?.pending}
        error={active?.error}
        errorText={webhookMessageFor}
        onConfirm={() => active?.run()}
        onCancel={closeConfirmation}
      >
        {active?.body}
      </ConfirmDialog>
    </section>
  )
}
