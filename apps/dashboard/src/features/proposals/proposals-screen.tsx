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
import { ProposalCard, type TargetSnapshot } from './proposal-card'
import { refreshProposals } from './queries'
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
  // The proposal the question is about, and what its card said it was about, as they were
  // shown when the question was opened: what is asked and sent is this, never something
  // read again behind the dialog.
  const [asking, setAsking] = useState<{ proposal: Proposal; about: TargetSnapshot } | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  // The proposal whose approval is on its way, from the click until its answer: no other is
  // asked about or sent meanwhile, also after the question was closed.
  const [running, setRunning] = useState<string | null>(null)
  // Proposals this screen got an answer about. The list is read again without the answer
  // waiting for it, so a card can still read `pending` for a moment: it is not asked about
  // again on that.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set())
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
    setRunning(null)
    setAnswered((before) => new Set(before).add(next.shown.id))
    approve.reset()
    setAsking(null)
    setResult(next)
  }

  function send(shown: Proposal) {
    if (running !== null) {
      return
    }
    setRunning(shown.id)
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
        onSuccess: (decided) => {
          // The answer is shown at once. The list is read again and not waited for: a slow
          // read must not keep "the user is banned, end their sessions" off the screen.
          void refreshProposals(queryClient)
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
        onError: (error) => {
          // Whatever was refused, the list may no longer be what is on screen: read again,
          // not waited for.
          void refreshProposals(queryClient)
          const refusal = refusalText(error)
          if (refusal !== null) {
            finish({ shown, outcome: null, refusal, userId: null })
            return
          }
          // Not a refusal of the proposal: the question stays and can be tried again.
          setRunning(null)
        },
      }
    )
  }

  function ask(proposal: Proposal, about: TargetSnapshot) {
    if (running !== null) {
      return
    }
    // A failure of an earlier question is not this one's.
    approve.reset()
    setAsking({ proposal, about })
  }

  function cancel() {
    // An approval on its way is not taken back by closing the question: its answer is
    // still shown, and no other is started meanwhile (`running` stays).
    if (running === null) {
      approve.reset()
    }
    setAsking(null)
  }

  function unavailable(proposal: Proposal): string | null {
    if (running !== null && running !== proposal.id) {
      return 'Another approval is on its way: this one can be asked about once it is answered.'
    }
    if (answered.has(proposal.id)) {
      return 'This screen has an answer about this proposal (above). The list is being read again.'
    }
    return null
  }

  const named = asking ? naming(asking.proposal) : null
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
                      <ProposalCard
                        proposal={proposal}
                        now={now}
                        approving={running === proposal.id}
                        unavailable={unavailable(proposal)}
                        onApprove={ask}
                      />
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
                      <ProposalCard
                        proposal={proposal}
                        now={now}
                        approving={running === proposal.id}
                        unavailable={unavailable(proposal)}
                        onApprove={ask}
                      />
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
        pending={running !== null}
        error={approve.error}
        errorText={approvalErrorText}
        onConfirm={() => {
          if (asking) {
            send(asking.proposal)
          }
        }}
        onCancel={cancel}
      >
        {asking ? (
          <span className='flex flex-col gap-2'>
            <span data-testid='approve-consequence'>
              {consequenceOf(asking.proposal.operation)}
            </span>
            {/* The card's line as it was when this question was opened, kept as text: it is
                not read again here, so what is asked does not change while it is read. */}
            <span>
              About{' '}
              <bdi data-testid='proposal-target' data-read={asking.about.read}>
                {asking.about.text}
              </bdi>
              , as its card said when this question was opened.
              {asking.about.read
                ? null
                : ' It had not been read then: this question does not say how it is now. Cancel and look at the card to see.'}
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
