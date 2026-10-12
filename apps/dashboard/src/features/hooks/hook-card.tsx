import { useQueryClient } from '@tanstack/react-query'
import { HOOK_POINTS, type HookPoint } from '@tula/contract'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { type Hook, useDeleteHook, useUpdateHook } from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { ConfirmDialog } from '~/components/confirm-dialog'
import { notify } from '~/components/toaster'
import { useEnvironment, useEnvironmentRequest } from '~/features/shell/environment-context'
import { Address } from '~/features/webhooks/address'
import { formatDateTime } from '~/lib/format'
import { printable } from '~/lib/printable'
import { cn } from '~/lib/utils'
import { CreateHookDialog } from './create-hook-dialog'
import { EditHookDialog } from './edit-hook-dialog'
import { refreshHooks } from './queries'
import {
  failureModeText,
  failureOutcome,
  failureReasonText,
  hookHealth,
  hookMessageFor,
  hookState,
  lastOutcomeText,
  OUTCOME_WINDOW_TEXT,
  outcomeCounts,
  pointWords,
  strengthOf,
  weakeningSentences,
} from './words'

function isKnownPoint(point: string): point is HookPoint {
  return (HOOK_POINTS as readonly string[]).includes(point)
}

/**
 * A hook's state as a badge and a sentence: in words, never colour alone.
 *
 * @param props - `hook`: the hook as the API lists it.
 * @returns The badge and what it means.
 */
export function HookStateBadge({ hook }: { hook: Hook }) {
  const state = hookState(hook)
  return (
    <p
      data-testid='hook-state'
      data-state={state.kind}
      className='flex flex-col items-start gap-1 text-sm'
    >
      <span
        className={cn(
          'rounded-full border px-2 py-0.5 text-xs font-semibold',
          state.kind === 'on'
            ? 'border-input'
            : 'border-destructive bg-destructive-surface text-destructive'
        )}
      >
        {state.label}
      </span>
      <span className='text-muted-foreground'>{state.detail}</span>
    </p>
  )
}

/**
 * What a hook's calls of the last day came to: the server's four counts, its most recent
 * call, and whether that means the hook is failing. The numbers are the answer's own, in a
 * fixed order: no rate, share, trend or sum is drawn from them. "Failing" is the contract's
 * `hookIsFailing` over the most recent call, and is said in words, never colour alone.
 *
 * @param props - `hook`: the hook as the API lists it.
 * @returns The counts, the most recent call and the health, as text.
 */
export function RecentOutcomes({ hook }: { hook: Hook }) {
  const recent = hook.recentOutcomes
  const health = hookHealth(hook)
  const failing = health.kind === 'failing' || health.kind === 'failed-when-last-asked'
  return (
    <div data-testid='hook-recent-outcomes' className='flex flex-col gap-2'>
      <p
        data-testid='hook-health'
        data-health={health.kind}
        className='flex flex-col items-start gap-1'
      >
        <span
          className={cn(
            'rounded-full border px-2 py-0.5 text-xs font-semibold',
            failing ? 'border-destructive bg-destructive-surface text-destructive' : 'border-input'
          )}
        >
          {health.label}
        </span>
        <span className='text-muted-foreground'>{health.detail}</span>
      </p>
      <p>
        Calls in {OUTCOME_WINDOW_TEXT}, counted by the hour since {formatDateTime(recent.since)}:
      </p>
      <dl className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
        {outcomeCounts(recent).map((entry) => (
          <div key={entry.key} className='flex flex-col gap-0.5'>
            <dt className='text-xs font-medium text-muted-foreground'>{entry.label}</dt>
            <dd data-testid={`hook-count-${entry.key}`}>{entry.count}</dd>
          </div>
        ))}
      </dl>
      {recent.lastCallAt !== null && recent.lastOutcome !== null ? (
        <p data-testid='hook-last-call'>
          {/* Server text (an outcome a later server knows) is rendered as text. */}
          The most recent call, on {formatDateTime(recent.lastCallAt)},{' '}
          {lastOutcomeText(recent.lastOutcome)}.
        </p>
      ) : null}
      <p className='text-muted-foreground'>
        These are counts and nothing more: the server keeps no call by itself, nothing of what was
        asked, and nothing of an answer but which of the four it was. A call the server did not make
        (the hook was off, or the calls were over their limit) is not counted.
      </p>
    </div>
  )
}

/**
 * The last call of a hook that failed, with its reason: the one failure whose reason the
 * server keeps. It is never cleared, so it is said as "the last one that failed" and never
 * as how the hook is doing now; that is {@link RecentOutcomes}.
 *
 * @param props - `hook`: the hook as the API lists it.
 * @returns The last failed call in words.
 */
export function LastFailure({ hook }: { hook: Hook }) {
  const outcome = failureOutcome(hook)
  return (
    <div data-testid='hook-last-failure' data-outcome={outcome} className='flex flex-col gap-0.5'>
      {outcome === 'none' ? (
        <span>No failed call is recorded.</span>
      ) : (
        <>
          <span>
            <span className='font-semibold'>
              {outcome === 'timed-out' ? 'Timed out' : 'Failed'}
            </span>{' '}
            on {formatDateTime(hook.lastFailedAt)}
          </span>
          {/* Server text (a reason a later server knows) is rendered as text, like all of it. */}
          <span>{failureReasonText(hook.lastFailureReason ?? '')}</span>
          <span className='text-muted-foreground'>
            This stays until another call fails: calls since then may have been answered.
          </span>
        </>
      )}
      <span className='text-muted-foreground'>
        A reason is kept for the last call that failed only, however long ago that was.
      </span>
    </div>
  )
}

/** Which confirmation the card is asking. */
type Confirmation = 'off' | 'on' | 'remove'

/** Props of {@link HookCard}. */
export interface HookCardProps {
  /** The point: one of the contract's, or one only a later server knows. */
  point: string
  /** The point's hook; `null` when it has none. */
  hook: Hook | null
}

/**
 * One point at which a hook is asked: what the point is, the hook registered for it (its
 * address, how it is set, what its recent calls came to, its last failed call) and
 * everything an operator can do to it; or
 * that it has none, and a way to add one.
 *
 * @param props - See {@link HookCardProps}.
 * @returns The card.
 */
export function HookCard({ point, hook }: HookCardProps) {
  const titleId = useId()
  const queryClient = useQueryClient()
  const environment = useEnvironment()
  const request = useEnvironmentRequest()
  const update = useUpdateHook({ request })
  const remove = useDeleteHook({ request })
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState(false)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  // From the click until the confirmation closes, which is after the list was read again:
  // the request has succeeded well before that, and a button that came back to life in
  // between would send it a second time.
  const [running, setRunning] = useState(false)
  const title = useRef<HTMLHeadingElement>(null)
  // What the card will look like once a hook was added or removed: until then the button
  // that was used may still be there, and afterwards it is not.
  const moved = useRef<boolean | null>(null)
  const present = hook !== null
  const dialogOpen = adding || confirmation !== null
  const words = pointWords(point)
  // How the point is said in a control's name and typed to confirm: what is shown.
  const name = printable(point)
  const known = isKnownPoint(point)

  // "Add a hook" goes when a hook was added, and "Remove" when it was removed, and with the
  // button the focus a closing dialog would have given back to it: it goes to the point's
  // name. In an effect, after the dialog's own (a child's effects run first): until the
  // dialog has closed, nothing outside it can take the focus.
  useEffect(() => {
    if (moved.current === present && !dialogOpen) {
      moved.current = null
      title.current?.focus()
    }
  }, [present, dialogOpen])

  function closeConfirmation() {
    update.reset()
    remove.reset()
    setRunning(false)
    setConfirmation(null)
  }

  /** What a refused request does: the confirmation stays, and can be tried again. */
  const refused = { onError: () => setRunning(false) }

  async function done(message: string) {
    await refreshHooks(queryClient)
    notify(message)
    closeConfirmation()
  }

  function switchTo(id: string, enabled: boolean) {
    setRunning(true)
    update.mutate(
      { id, data: { enabled } },
      { ...refused, onSuccess: () => done(enabled ? 'Hook switched on' : 'Hook switched off') }
    )
  }

  function dialogs(held: Hook): Record<
    Confirmation,
    {
      title: ReactNode
      label: string
      body: ReactNode
      destructive?: boolean
      /** Ask for the point's name to be typed first. */
      typed?: boolean
      error: unknown
      run: () => void
    }
  > {
    const strength = strengthOf(held)
    const production = environment.kind === 'production'
    const off = weakeningSentences(point, strength, { ...strength, enabled: false })
    const gone = weakeningSentences(point, strength, null)
    const code = <code className='font-mono'>{name}</code>
    return {
      off: {
        title: <>Switch off the hook for {code}?</>,
        label: 'Switch off',
        body: `${off.join(' ')} This is recorded in the audit log as a weakening.`,
        // The check is gone from the moment it is off: in production the point is named
        // by typing it, as for a removal.
        typed: production,
        error: update.error,
        run: () => switchTo(held.id, false),
      },
      on: {
        title: <>Switch on the hook for {code}?</>,
        label: 'Switch on',
        body:
          held.failureMode === 'allow'
            ? 'It is asked again from now on. A call that fails lets through what was asked about.'
            : 'It is asked again from now on. A call that fails refuses what was asked about, so check that the endpoint answers first.',
        error: update.error,
        run: () => switchTo(held.id, true),
      },
      remove: {
        title: <>Remove the hook for {code}?</>,
        label: 'Remove hook',
        body:
          gone.length > 0
            ? `${gone.join(' ')} Its signing secret is deleted with it and cannot be brought back. This is recorded in the audit log as a weakening.`
            : 'It is switched off, so nothing changes for the people signing in. Its signing secret is deleted with it and cannot be brought back.',
        destructive: true,
        typed: production,
        error: remove.error,
        run: () => {
          setRunning(true)
          remove.mutate(
            { id: held.id },
            {
              ...refused,
              onSuccess: async () => {
                moved.current = false
                await done('Hook removed')
              },
            }
          )
        },
      },
    }
  }
  const active = hook && confirmation ? dialogs(hook)[confirmation] : null

  return (
    <section
      aria-labelledby={titleId}
      data-testid='hook-point'
      data-point={point}
      className='flex flex-col gap-4 rounded-xl border bg-card p-5 text-card-foreground'
    >
      <div className='flex flex-col gap-1'>
        <h2
          ref={title}
          id={titleId}
          tabIndex={-1}
          className='text-sm font-semibold outline-none focus-visible:underline'
        >
          {known ? words.label : <bdi className='font-mono break-all'>{name}</bdi>}
        </h2>
        <p className='text-sm text-muted-foreground'>
          {known ? (
            <>
              <code className='font-mono'>{point}</code>. {words.asked}
            </>
          ) : (
            words.asked
          )}
        </p>
      </div>
      {hook === null ? (
        <div className='flex flex-col items-start gap-3'>
          <p data-testid='hook-none' className='text-sm'>
            No hook: nothing is asked at this point.
          </p>
          {known ? (
            <ActionButton
              variant='outline'
              size='sm'
              aria-label={`Add a hook for ${name}`}
              onClick={() => setAdding(true)}
            >
              Add a hook
            </ActionButton>
          ) : null}
        </div>
      ) : (
        <>
          <HookStateBadge hook={hook} />
          <dl className='grid gap-3 text-sm sm:grid-cols-2'>
            <div className='flex flex-col gap-0.5 sm:col-span-2'>
              <dt className='text-xs font-medium text-muted-foreground'>Address</dt>
              {/* Server text: rendered as text, never a link. */}
              <dd>
                <Address url={hook.url} />
              </dd>
            </div>
            <div className='flex flex-col gap-0.5'>
              <dt className='text-xs font-medium text-muted-foreground'>Deadline</dt>
              <dd>{hook.deadlineMs} ms</dd>
            </div>
            <div className='flex flex-col gap-0.5'>
              <dt className='text-xs font-medium text-muted-foreground'>When a call fails</dt>
              <dd>{failureModeText(hook.failureMode)}</dd>
            </div>
            <div className='flex flex-col gap-0.5 sm:col-span-2'>
              <dt className='text-xs font-medium text-muted-foreground'>Recent outcomes</dt>
              <dd>
                <RecentOutcomes hook={hook} />
              </dd>
            </div>
            <div className='flex flex-col gap-0.5 sm:col-span-2'>
              <dt className='text-xs font-medium text-muted-foreground'>Last failed call</dt>
              <dd>
                <LastFailure hook={hook} />
              </dd>
            </div>
            <div className='flex flex-col gap-0.5'>
              <dt className='text-xs font-medium text-muted-foreground'>Added</dt>
              <dd>{formatDateTime(hook.createdAt)}</dd>
            </div>
          </dl>
          <div className='flex flex-wrap items-center gap-2'>
            {known ? (
              <ActionButton
                variant='outline'
                size='sm'
                aria-label={`Edit the hook for ${name}`}
                onClick={() => setEditing(true)}
              >
                Edit
              </ActionButton>
            ) : null}
            <ActionButton
              variant='outline'
              size='sm'
              aria-label={`${hook.enabled ? 'Switch off' : 'Switch on'} the hook for ${name}`}
              onClick={() => setConfirmation(hook.enabled ? 'off' : 'on')}
            >
              {hook.enabled ? 'Switch off' : 'Switch on'}
            </ActionButton>
            <ActionButton
              variant='destructive'
              size='sm'
              aria-label={`Remove the hook for ${name}`}
              onClick={() => setConfirmation('remove')}
            >
              Remove
            </ActionButton>
          </div>
          <EditHookDialog hook={hook} open={editing} onClose={() => setEditing(false)} />
        </>
      )}
      {known ? (
        <CreateHookDialog
          point={point}
          open={adding}
          onClose={(created) => {
            if (created) {
              moved.current = true
            }
            setAdding(false)
          }}
        />
      ) : null}
      <ConfirmDialog
        open={active !== null}
        title={active?.title ?? ''}
        confirmLabel={active?.label ?? ''}
        destructive={active?.destructive}
        requireText={active?.typed ? name : undefined}
        pending={running}
        error={active?.error}
        errorText={hookMessageFor}
        onConfirm={() => active?.run()}
        onCancel={closeConfirmation}
      >
        {active?.body}
      </ConfirmDialog>
    </section>
  )
}
