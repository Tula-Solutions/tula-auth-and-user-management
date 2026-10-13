import { type ReactNode, useId, useRef } from 'react'
import type { Proposal } from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { formatDateTime } from '~/lib/format'
import { printable } from '~/lib/printable'
import { cn } from '~/lib/utils'
import { TargetDescription } from './target'
import { consequenceOf, naming, proposalState, timeLeft, UNKNOWN_OPERATION } from './words'

/** Props of {@link ProposalCard}. */
export interface ProposalCardProps {
  /** The proposal as the API lists it. */
  proposal: Proposal
  /** This browser's time in milliseconds, for the time left; the screen's one clock. */
  now: number
  /** True while the approval of **this** proposal is on its way. */
  approving: boolean
  /**
   * Why this proposal cannot be asked about just now, in words: another approval is on its
   * way, or this one was answered and the list has not been read again. `null`: it can.
   */
  unavailable: string | null
  /** Ask about approving this proposal, as it is shown here. */
  onApprove: (proposal: Proposal, about: TargetSnapshot) => void
}

/** What a card said its target was, at one moment: the text, and whether it had been read. */
export interface TargetSnapshot {
  /** The line as it was drawn, as text. */
  text: string
  /** False when the target had not been read (still loading, or the read failed). */
  read: boolean
}

function Entry({
  label,
  wide = false,
  children,
}: {
  label: string
  /** Take both columns. On the entry itself: a `<dt>` sits directly in a group of a `<dl>`. */
  wide?: boolean
  children: ReactNode
}) {
  return (
    <div className={cn('flex flex-col gap-0.5', wide && 'sm:col-span-2')}>
      <dt className='text-xs font-medium text-muted-foreground'>{label}</dt>
      <dd className='break-words'>{children}</dd>
    </div>
  )
}

/**
 * One proposal: what it would do (the server's sentence, the exact operation, the target as
 * the environment has it now), the agent that asked, how it stands and, while it waits, how
 * long it can still be approved. Only a proposal the server says is `pending`, with an
 * operation this version can describe, has a button; every other says in words why it has
 * none. Everything from the server is rendered as text.
 *
 * @param props - See {@link ProposalCardProps}.
 * @returns The card.
 */
export function ProposalCard({
  proposal,
  now,
  approving,
  unavailable,
  onApprove,
}: ProposalCardProps) {
  const titleId = useId()
  const reasonId = useId()
  const about = useRef<HTMLSpanElement>(null)

  function approve() {
    if (approving || unavailable !== null) {
      return
    }
    // What the question says the proposal is about is what this card says now, kept as
    // text: the question must not change under the person reading it.
    const line = about.current?.querySelector('[data-testid="proposal-target"]')
    onApprove(proposal, {
      text: line?.textContent ?? '',
      read: line?.getAttribute('data-read') === 'true',
    })
  }
  const state = proposalState(proposal)
  const named = naming(proposal)
  const consequence = consequenceOf(proposal.operation)
  const pending = state.kind === 'pending'
  const left = pending ? timeLeft(proposal.expiresAt, now) : null
  const calm = state.kind === 'pending' || state.kind === 'executed'
  return (
    <article
      aria-labelledby={titleId}
      data-testid='proposal'
      data-status={state.kind}
      className='flex flex-col gap-4 rounded-xl border bg-card p-5 text-card-foreground'
    >
      <div className='flex flex-col gap-1'>
        <h3 id={titleId} className='text-sm font-semibold break-words'>
          <code className='font-mono'>{named.operation}</code> for {named.what}{' '}
          <bdi dir='ltr' className='font-mono break-all'>
            {named.id}
          </bdi>
        </h3>
        {/* The server's own sentence for the operation: no agent wrote a word of it. */}
        <p data-testid='proposal-summary' className='text-sm text-muted-foreground'>
          {proposal.summary}
        </p>
      </div>
      <p
        data-testid='proposal-state'
        data-state={state.kind}
        className='flex flex-col items-start gap-1 text-sm'
      >
        <span
          className={cn(
            'rounded-full border px-2 py-0.5 text-xs font-semibold',
            calm ? 'border-input' : 'border-destructive bg-destructive-surface text-destructive'
          )}
        >
          {state.label}
        </span>
        <span className='text-muted-foreground'>{state.detail}</span>
      </p>
      <dl className='grid gap-3 text-sm sm:grid-cols-2'>
        <Entry label='Operation'>
          <code className='font-mono'>{named.operation}</code>
        </Entry>
        <Entry label='Asked for by'>
          An agent (agent key{' '}
          <bdi dir='ltr' className='font-mono break-all'>
            {printable(proposal.proposedBy.id)}
          </bdi>
          )
        </Entry>
        <Entry label='About, as it is now' wide>
          <span ref={about}>
            <TargetDescription target={proposal.target} />
          </span>
        </Entry>
        <Entry label='Asked for'>{formatDateTime(proposal.createdAt)}</Entry>
        {left ? (
          <Entry label='Can be approved until'>
            {formatDateTime(proposal.expiresAt)}
            {/* The screen's own countdown, a tick a second: read when a person gets to it,
                never announced (no live region). The server decides when the time is up. */}
            <span data-testid='proposal-time-left' data-up={left.up} className='block'>
              {left.text}
              {left.up ? ': the server decides, and an approval now is likely refused.' : '.'}
            </span>
          </Entry>
        ) : null}
        {proposal.approvedBy ? (
          <Entry label='Approved by'>
            {printable(proposal.approvedBy.type)}
            {proposal.approvedBy.id ? (
              <>
                {' '}
                <bdi dir='ltr' className='font-mono break-all'>
                  {printable(proposal.approvedBy.id)}
                </bdi>
              </>
            ) : null}
            {proposal.approvedAt ? <>, {formatDateTime(proposal.approvedAt)}</> : null}
          </Entry>
        ) : null}
      </dl>
      {pending ? (
        <div className='flex flex-col items-start gap-2'>
          {consequence === null ? (
            <p data-testid='proposal-unknown-operation' className='text-sm'>
              {UNKNOWN_OPERATION}
            </p>
          ) : (
            <>
              {/* Busy is said of the one approval that is on its way. Any other card is
                  unavailable, and says why: focusable, never `disabled`. */}
              <ActionButton
                size='sm'
                pending={approving}
                aria-disabled={approving || unavailable !== null || undefined}
                aria-describedby={unavailable !== null ? reasonId : undefined}
                aria-label={`Approve ${named.operation} for ${named.what} ${named.id}`}
                onClick={approve}
              >
                Approve
              </ActionButton>
              {unavailable !== null ? (
                <p
                  id={reasonId}
                  data-testid='proposal-unavailable'
                  className='text-sm text-muted-foreground'
                >
                  {unavailable}
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </article>
  )
}
