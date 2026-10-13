import { type ReactNode, useId } from 'react'
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
  /** True while an approval of this screen is on its way: no second one is started. */
  busy: boolean
  /** Ask about approving this proposal, as it is shown here. */
  onApprove: (proposal: Proposal) => void
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
export function ProposalCard({ proposal, now, busy, onApprove }: ProposalCardProps) {
  const titleId = useId()
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
          <TargetDescription target={proposal.target} />
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
            <ActionButton
              size='sm'
              pending={busy}
              aria-label={`Approve ${named.operation} for ${named.what} ${named.id}`}
              onClick={() => onApprove(proposal)}
            >
              Approve
            </ActionButton>
          )}
        </div>
      ) : null}
    </article>
  )
}
