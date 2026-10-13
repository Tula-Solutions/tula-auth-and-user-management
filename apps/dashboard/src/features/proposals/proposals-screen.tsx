import { useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { type RefObject, useEffect, useRef, useState } from 'react'
import { messageFor, toApiError } from '~/api/errors'
import { type Proposal, useApproveProposal, useListProposals } from '~/api/generated/api.gen'
import { ActionButton } from '~/components/action-button'
import { ConfirmDialog } from '~/components/confirm-dialog'
import { PageHeader } from '~/components/page'
import { EmptyState, QueryState } from '~/components/states'
import { useEnvironment, useEnvironmentRequest } from '~/features/shell/environment-context'
import { EnvironmentLink } from '~/features/shell/environment-link'
import { cn } from '~/lib/utils'
import { ProposalCard } from './proposal-card'
import { refreshProposals } from './queries'
import { TargetDescription } from './target'
import {
  type ApprovalOutcome,
  approvalOutcome,
  consequenceOf,
  MAY_HAVE_BEEN_TAKEN,
  naming,
  refusalText,
} from './words'

/** How often the list is read again while the screen is open: an operator waits here. */
export const PROPOSALS_REFRESH_MS = 10_000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * This browser's time, moving once a second while something on screen counts down. A timer
 * in an effect: started when `ticking` becomes true, stopped in the cleanup, and started
 * again by whatever sets the effect up again (StrictMode, Fast Refresh).
 *
 * @param ticking - Whether anything shown depends on the time.
 * @returns The time in milliseconds.
 */
export function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) {
      return
    }
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [ticking])
  // The clock stood still while nothing counted down: the first render that counts again
  // reads the time itself, and the timer has it from its first tick on.
  return ticking && Date.now() - now > 1500 ? Date.now() : now
}

/**
 * What a failed approval says when the server did not refuse the proposal itself. A request
 * that got no answer, and a server error, may have been taken all the same: that is said,
 * never guessed away.
 *
 * @param error - What the approval threw.
 * @returns The sentence.
 */
export function approvalErrorText(error: unknown): string {
  const failure = toApiError(error)
  const unknown = failure.status === 0 || failure.status >= 500
  return unknown ? `${messageFor(error)} ${MAY_HAVE_BEEN_TAKEN}` : messageFor(error)
}

/** What became of the last approval made on this screen. */
interface Result {
  /** The proposal as it was shown when it was approved. */
  shown: Proposal
  /** The server carried the approval out, or tried to: what its answer says. */
  outcome: ApprovalOutcome | null
  /** The server refused the approval: why, in fixed words. */
  refusal: string | null
  /** For a ban whose sessions were not ended: the user whose page ends them. */
  userId: string | null
}

function ResultPanel({
  result,
  panel,
  onDismiss,
}: {
  result: Result
  /** The screen focuses it: see where it does. */
  panel: RefObject<HTMLDivElement | null>
  onDismiss: () => void
}) {
  const params = useParams({ strict: false }) as Partial<
    Record<'workspaceId' | 'projectId' | 'environmentId', string>
  >
  const named = naming(result.shown)
  const problem = result.outcome === null || result.outcome.kind === 'problem'

  return (
    <div
      ref={panel}
      tabIndex={-1}
      role={problem ? 'alert' : 'status'}
      data-testid='approval-result'
      data-outcome={result.outcome?.kind ?? 'refused'}
      className={cn(
        'flex flex-col items-start gap-2 rounded-xl border bg-card p-5 text-sm outline-none focus-visible:ring-2',
        problem ? 'border-destructive' : 'border-input'
      )}
    >
      {/* The outcome leads as words: never the border's colour alone. */}
      <p className='font-semibold'>{result.outcome?.title ?? 'Not approved'}</p>
      <p>
        <code className='font-mono'>{named.operation}</code> for {named.what}{' '}
        <bdi dir='ltr' className='font-mono break-all'>
          {named.id}
        </bdi>
      </p>
      <p data-testid='approval-result-text'>{result.outcome?.text ?? result.refusal}</p>
      {result.userId && params.workspaceId && params.projectId && params.environmentId ? (
        <Link
          to='/w/$workspaceId/p/$projectId/e/$environmentId/users/$userId'
          params={{
            workspaceId: params.workspaceId,
            projectId: params.projectId,
            environmentId: params.environmentId,
            userId: result.userId,
          }}
          className='text-link underline underline-offset-4'
        >
          Open the user’s page to end their sessions
        </Link>
      ) : null}
      <ActionButton variant='outline' size='sm' onClick={onDismiss}>
        Close this message
      </ActionButton>
    </div>
  )
}

/**
 * The proposals of an environment: the changes an AI agent asked for that are waiting for a
 * person, and what became of the earlier ones. A waiting proposal is approved here with the
 * dashboard's session, as `tula approve` does it with a secret key: the question names the
 * operation and the target (typed, in a production environment), and the approval sends the
 * operation and the target that were shown, so the server carries out nothing else.
 *
 * Nothing is dismissed here: a proposal nobody approves expires by itself.
 *
 * @returns The screen.
 */
export function ProposalsScreen() {
  const queryClient = useQueryClient()
  const environment = useEnvironment()
  const request = useEnvironmentRequest()
  const proposals = useListProposals({
    request,
    query: { refetchInterval: PROPOSALS_REFRESH_MS },
  })
  const approve = useApproveProposal({ request })
  // The proposal the question is about, as it was shown when the question was opened: what
  // is sent is this, never something read again behind the dialog.
  const [asking, setAsking] = useState<Proposal | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  // From the click until the answer was shown, which is after the list was read again: the
  // request has succeeded well before that, and a button that came back to life in between
  // would send it a second time. A ref beside the state, for what has to know at once and
  // after the question was closed (`cancel`, a second `send`).
  const [running, setRunning] = useState(false)
  const sending = useRef(false)
  const panel = useRef<HTMLDivElement>(null)
  // Proposals whose time ran out by this browser's clock and that were asked about again.
  const lapsed = useRef(new Set<string>())

  const list = proposals.data?.data ?? []
  const waiting = list.filter((proposal) => proposal.status === 'pending')
  const others = list.filter((proposal) => proposal.status !== 'pending')
  const now = useNow(waiting.length > 0)

  // The countdown is this browser's; whether a proposal has expired is the server's to say.
  // When a time runs out here the list is read again, once for that proposal.
  useEffect(() => {
    const due = waiting.filter(
      (proposal) => Date.parse(proposal.expiresAt) <= now && !lapsed.current.has(proposal.id)
    )
    if (due.length > 0) {
      for (const proposal of due) {
        lapsed.current.add(proposal.id)
      }
      void refreshProposals(queryClient)
    }
  })

  // The button that was used is gone with its card, and with it the focus a closing dialog
  // gives back: the focus goes to what the approval came to. From this component's effect,
  // which runs after the dialog's own (a child's effects run first): while the dialog is
  // still modal nothing outside it can take the focus.
  useEffect(() => {
    if (result !== null && asking === null) {
      panel.current?.focus()
    }
  }, [result, asking])

  function finish(next: Result) {
    sending.current = false
    setRunning(false)
    approve.reset()
    setAsking(null)
    setResult(next)
  }

  function send(shown: Proposal) {
    if (sending.current) {
      return
    }
    sending.current = true
    setRunning(true)
    approve.mutate(
      // The approval names what was shown: the server refuses it (`mismatch`) for a
      // proposal that is anything else.
      {
        id: shown.id,
        data: {
          operation: shown.operation,
          target: { type: shown.target.type, id: shown.target.id },
        },
      },
      {
        onSuccess: async (decided) => {
          await refreshProposals(queryClient)
          const incompleteBan =
            decided.status === 'failed' &&
            decided.failureReason === 'incomplete' &&
            decided.operation === 'ban_user' &&
            UUID.test(decided.target.id)
          finish({
            shown,
            outcome: approvalOutcome(decided),
            refusal: null,
            userId: incompleteBan ? decided.target.id : null,
          })
        },
        onError: async (error) => {
          // Whatever was refused, the list may no longer be what is on screen.
          await refreshProposals(queryClient)
          const refusal = refusalText(error)
          if (refusal !== null) {
            finish({ shown, outcome: null, refusal, userId: null })
            return
          }
          // Not a refusal of the proposal: the question stays and can be tried again.
          sending.current = false
          setRunning(false)
        },
      }
    )
  }

  function ask(proposal: Proposal) {
    // A failure of an earlier question is not this one's.
    if (!sending.current) {
      approve.reset()
    }
    setAsking(proposal)
  }

  function cancel() {
    // An approval on its way is not taken back by closing the question: its answer is
    // still shown, and no other is started meanwhile (`sending` stays).
    if (!sending.current) {
      approve.reset()
    }
    setAsking(null)
  }

  const named = asking ? naming(asking) : null
  return (
    <>
      <PageHeader
        title='Proposals'
        description='A proposal is a change an AI agent asked for with an agent key. It has not happened: it waits here, for ten minutes, until someone approves it with a credential the agent does not hold. Approving carries it out at once.'
      />
      {result ? (
        <ResultPanel result={result} panel={panel} onDismiss={() => setResult(null)} />
      ) : null}
      <QueryState query={proposals} label='Loading proposals'>
        {() => (
          <>
            <section aria-labelledby='proposals-waiting' className='flex flex-col gap-4'>
              <div className='flex flex-wrap items-center justify-between gap-2'>
                <h2 id='proposals-waiting' className='text-base font-semibold'>
                  Waiting for approval
                </h2>
                <ActionButton
                  variant='outline'
                  size='sm'
                  pending={proposals.isFetching}
                  onClick={() => void proposals.refetch()}
                >
                  Read the list again
                </ActionButton>
              </div>
              {waiting.length === 0 ? (
                <EmptyState title='No proposal is waiting'>
                  When an agent asks for a change it appears here. The list is read again every few
                  seconds while this screen is open.
                </EmptyState>
              ) : (
                <ul className='grid gap-4'>
                  {waiting.map((proposal) => (
                    <li key={`${environment.id}:${proposal.id}`}>
                      <ProposalCard proposal={proposal} now={now} busy={running} onApprove={ask} />
                    </li>
                  ))}
                </ul>
              )}
              <p
                data-testid='proposals-no-dismiss'
                className='max-w-prose text-sm text-muted-foreground'
              >
                There is nothing to do about a proposal you do not want: it cannot be dismissed
                here, and it expires by itself ten minutes after it was asked for, with nothing
                changed. To end everything an agent has asked for at once, revoke its agent key
                under{' '}
                <EnvironmentLink to='/w/$workspaceId/p/$projectId/e/$environmentId/api-keys'>
                  API keys
                </EnvironmentLink>
                . An approval shows that this dashboard session was used, which the agent’s own
                tools do not hold; every proposal, approval and outcome is in the{' '}
                <EnvironmentLink to='/w/$workspaceId/p/$projectId/e/$environmentId/audit-log'>
                  audit log
                </EnvironmentLink>
                , with the agent and the approver.
              </p>
            </section>
            <section aria-labelledby='proposals-earlier' className='flex flex-col gap-4'>
              <h2 id='proposals-earlier' className='text-base font-semibold'>
                No longer waiting
              </h2>
              {others.length === 0 ? (
                <p className='text-sm text-muted-foreground'>
                  No earlier proposal: none has expired or been approved.
                </p>
              ) : (
                <ul className='grid gap-4'>
                  {others.map((proposal) => (
                    <li key={`${environment.id}:${proposal.id}`}>
                      <ProposalCard proposal={proposal} now={now} busy={running} onApprove={ask} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </QueryState>
      <ConfirmDialog
        open={asking !== null}
        title={
          named ? (
            <>
              Approve <code className='font-mono'>{named.operation}</code> for {named.what}{' '}
              <bdi dir='ltr' className='font-mono break-all'>
                {named.id}
              </bdi>
              ?
            </>
          ) : (
            ''
          )
        }
        confirmLabel='Approve'
        // In production what is acted on is typed: the target's id, as it is shown.
        requireText={environment.kind === 'production' ? named?.id : undefined}
        pending={running}
        error={approve.error}
        errorText={approvalErrorText}
        onConfirm={() => {
          if (asking) {
            send(asking)
          }
        }}
        onCancel={cancel}
      >
        {asking ? (
          <span className='flex flex-col gap-2'>
            <span data-testid='approve-consequence'>{consequenceOf(asking.operation)}</span>
            <span>
              About <TargetDescription target={asking.target} />.
            </span>
            <span>
              It is carried out at once and cannot be approved twice. It is recorded with the agent
              as its actor and this dashboard session as the one that approved.
            </span>
          </span>
        ) : null}
      </ConfirmDialog>
    </>
  )
}
