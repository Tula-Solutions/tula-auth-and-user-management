import { Link } from '@tanstack/react-router'
import { useId } from 'react'
import type { WebhookEndpoint } from '~/api/generated/api.gen'
import type { EnvironmentScope } from '~/features/users/users-screen'
import { formatDateTime } from '~/lib/format'
import { cn } from '~/lib/utils'
import { endpointState } from './words'

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

/** Props of {@link EndpointCard}. */
export interface EndpointCardProps {
  /** The ids of the environment's address, for the links. */
  scope: EnvironmentScope
  endpoint: WebhookEndpoint
}

/**
 * One webhook endpoint: its address, how it is doing, what it subscribes to, and everything
 * an operator can do to it.
 *
 * @param props - See {@link EndpointCardProps}.
 * @returns The card.
 */
export function EndpointCard({ scope, endpoint }: EndpointCardProps) {
  const titleId = useId()
  return (
    <section
      aria-labelledby={titleId}
      className='flex flex-col gap-4 rounded-xl border bg-card p-5 text-card-foreground'
    >
      <div className='flex flex-col gap-2'>
        {/* The address is the endpoint's name. Server text: rendered as text, never a link. */}
        <h2 id={titleId} className='font-mono text-sm font-semibold break-all'>
          {endpoint.url}
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
      <div className='flex flex-wrap items-center gap-2'>
        <Link
          to='/w/$workspaceId/p/$projectId/e/$environmentId/webhooks/$endpointId'
          params={{ ...scope, endpointId: endpoint.id }}
          className='text-sm font-medium text-link underline underline-offset-4'
        >
          Deliveries
        </Link>
      </div>
    </section>
  )
}
