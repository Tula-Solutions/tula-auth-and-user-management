'use client'

import { cn } from '@/lib/utils'

export interface StatusProps {
  /**
   * What to say; `null` keeps the live region in the page, empty, so that a message added later
   * is announced. A live region that appears together with its text is often not read.
   */
  message: string | null
  /**
   * `success` (the default) confirms something that was done. `neutral` is for what is neither
   * done nor wrong (a passkey dialog the user dismissed): nothing succeeded, so it must not look
   * as if something had.
   */
  tone?: 'success' | 'neutral'
  className?: string
}

/**
 * A quiet line, announced politely (an `<output>`, never an alert). The state is in the words,
 * not only in the colour.
 */
export function Status(props: StatusProps) {
  const { message, tone = 'success' } = props
  return (
    <output
      className={cn(
        // Empty, it stays in the page (a live region that arrives with its text is often not
        // read) but takes no room.
        'flex items-start gap-2 text-sm empty:sr-only',
        tone === 'success' ? 'text-foreground' : 'text-muted-foreground',
        props.className
      )}
    >
      {message !== null && tone === 'success' ? (
        <svg
          aria-hidden='true'
          viewBox='0 0 16 16'
          className='mt-0.5 size-4 shrink-0'
          fill='none'
          stroke='currentColor'
          strokeWidth='1.75'
          strokeLinecap='round'
          strokeLinejoin='round'
        >
          <circle cx='8' cy='8' r='6.25' />
          <path d='m5.5 8.2 1.7 1.7 3.3-3.6' />
        </svg>
      ) : null}
      {message}
    </output>
  )
}

export interface FormAlertProps {
  /** The failure's message, or `null` for none. */
  message: string | null
  /** A second line that changes by itself (a countdown): read once, not re-announced. */
  detail?: string | null
  className?: string
}

/**
 * The message above a form for a failure that is not about one field. Announced at once
 * (`role="alert"`), in the app's destructive colour with an icon, so that it is not colour alone.
 */
export function FormAlert(props: FormAlertProps) {
  if (!props.message) {
    return null
  }
  return (
    <div
      role='alert'
      className={cn(
        'flex gap-2.5 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2.5 text-sm text-destructive',
        props.className
      )}
    >
      <svg
        aria-hidden='true'
        viewBox='0 0 16 16'
        className='mt-0.5 size-4 shrink-0'
        fill='none'
        stroke='currentColor'
        strokeWidth='1.75'
        strokeLinecap='round'
        strokeLinejoin='round'
      >
        <circle cx='8' cy='8' r='6.25' />
        <path d='M8 4.75v3.9M8 11.2v.05' />
      </svg>
      <div className='grid gap-0.5'>
        <p>{props.message}</p>
        {/* A countdown changes every second; it is read with the alert once. */}
        {props.detail ? <p aria-live='off'>{props.detail}</p> : null}
      </div>
    </div>
  )
}
