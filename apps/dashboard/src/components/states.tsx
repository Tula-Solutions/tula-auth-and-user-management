import { CircleAlert, Inbox, ShieldAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { isForbidden, messageFor } from '~/api/errors'
import { ActionButton } from './action-button'
import { Skeleton } from './ui/skeleton'

/**
 * A placeholder while a screen's data loads.
 *
 * @param props - `label`: what is loading, for assistive technology.
 * @returns The placeholder.
 */
export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div role='status' aria-live='polite' className='flex flex-col gap-3 py-2'>
      <span className='sr-only'>{label}…</span>
      <Skeleton className='h-9 w-full' />
      <Skeleton className='h-9 w-full' />
      <Skeleton className='h-9 w-2/3' />
    </div>
  )
}

/**
 * What a list shows when it has nothing in it.
 *
 * @param props - `title`, an optional explanation and an optional action.
 * @returns The empty state.
 */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className='flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center'>
      <Inbox aria-hidden='true' className='size-6 text-muted-foreground' />
      <p className='font-medium'>{title}</p>
      {children ? <p className='max-w-prose text-sm text-muted-foreground'>{children}</p> : null}
      {action}
    </div>
  )
}

/**
 * A failed load: the message, and a way to try again. A 403 is shown as "not allowed" with
 * no retry, since asking again would be refused again.
 *
 * @param props - `error`: what the query threw; `onRetry`: refetch.
 * @returns The error state.
 */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const forbidden = isForbidden(error)
  const Icon = forbidden ? ShieldAlert : CircleAlert
  return (
    <div
      role='alert'
      className='flex flex-col items-start gap-2 rounded-lg border border-destructive bg-destructive-surface px-4 py-3 text-sm'
    >
      <p className='flex items-center gap-2 font-medium text-destructive'>
        <Icon aria-hidden='true' className='size-4' />
        {forbidden ? 'You are not allowed to see this' : 'This could not be loaded'}
      </p>
      <p>{messageFor(error)}</p>
      {onRetry && !forbidden ? (
        <ActionButton variant='outline' size='sm' onClick={onRetry}>
          Try again
        </ActionButton>
      ) : null}
    </div>
  )
}

/** The part of a query result {@link QueryState} reads. */
export interface QueryLike<T> {
  data: T | undefined
  error: unknown
  isPending: boolean
  refetch: () => unknown
}

/**
 * Draw a query: loading, error (or forbidden), or its data.
 *
 * @param props - `query`: the query; `label`: what is loading; `children`: renders the data.
 * @returns One of the three states.
 */
export function QueryState<T>({
  query,
  label,
  children,
}: {
  query: QueryLike<T>
  label?: string
  children: (data: T) => ReactNode
}) {
  if (query.data !== undefined) {
    return <>{children(query.data)}</>
  }
  if (query.isPending) {
    return <LoadingState label={label} />
  }
  return <ErrorState error={query.error} onRetry={() => query.refetch()} />
}
