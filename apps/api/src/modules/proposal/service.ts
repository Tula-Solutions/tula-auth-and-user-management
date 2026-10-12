import {
  type ApproveProposalRequest,
  type CreateProposalRequest,
  PROPOSAL_APPROVER_TYPES,
  PROPOSAL_OPERATION_TARGETS,
  type Proposal,
  type ProposalApprovalRefusal,
  type ProposalApprover,
  type ProposalApproverType,
  type ProposalCreationRefusal,
  type ProposalFailureReason,
  proposalSummary,
} from '@tula/contract'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, ConflictError, ForbiddenError, NotFoundError } from '~/exceptions'
import type { Actor } from '~/lib/actor'
import * as logger from '~/lib/logger'
import * as Audit from '~/modules/audit/service'
import * as Users from '~/modules/user/service'
import type { ProposalRecord } from '~/ports/proposal-store'

type Scope = Pick<Tenant, 'projectId' | 'environmentId'>

/**
 * How long a proposal can be approved: ten minutes from when it was asked for. Long enough
 * for a human to read it in another window and decide, short enough that an approval is of
 * something asked for just now. The database refuses a row that could be approved more than
 * an hour after it was made, whatever this says.
 */
export const PROPOSAL_TTL_MS = 10 * 60_000

/**
 * Proposals an environment's agents may ask for in a minute, whatever key or address they come
 * from. With {@link PROPOSAL_TTL_MS} it bounds how many can wait for a human at once (a
 * hundred), so an agent that was talked into asking again and again cannot bury the one that
 * matters, or wear an approver down, without limit.
 */
export const PROPOSALS_PER_MINUTE = 10

/** The most proposals the list answers: the newest. */
export const PROPOSAL_LIST_LIMIT = 100

/**
 * A stored proposal as the admin API answers it.
 *
 * "Expired" is decided here, from the clock: a pending proposal whose time has passed. The
 * sentence is the contract's, with the target's id in it and nothing anyone typed.
 *
 * @param record - The stored proposal.
 * @param now - The time to judge its expiry by.
 * @returns The proposal.
 */
export function toProposal(record: ProposalRecord, now: Date): Proposal {
  const target = { type: record.targetType, id: record.targetId }
  const expired = record.status === 'pending' && record.expiresAt.getTime() <= now.getTime()
  return {
    id: record.id,
    operation: record.operation,
    target,
    summary: proposalSummary(record.operation, target),
    status: expired ? 'expired' : record.status,
    proposedBy: { type: 'agent', id: record.proposedBy },
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    approvedBy:
      record.approvedByType === null
        ? null
        : { type: record.approvedByType, id: record.approvedById },
    approvedAt: record.approvedAt?.toISOString() ?? null,
    failureReason: record.failureReason,
  }
}

/** What every proposal event says of the proposal. */
function proposed(record: Pick<ProposalRecord, 'operation' | 'targetType' | 'targetId'>) {
  return {
    operation: record.operation,
    targetType: record.targetType,
    targetId: record.targetId,
  }
}

function refuseCreation(reason: ProposalCreationRefusal, message: string): never {
  throw new ForbiddenError({ message, params: { reason } })
}

function refuseApproval(reason: ProposalApprovalRefusal, message: string): never {
  throw new ConflictError({ message, params: { reason } })
}

/**
 * List the environment's proposals, newest first.
 *
 * @param deps - Proposal store and clock.
 * @param tenant - The resolved tenant.
 * @returns At most {@link PROPOSAL_LIST_LIMIT} proposals.
 */
export async function list(
  deps: Pick<Deps, 'proposals' | 'clock'>,
  tenant: Pick<Tenant, 'environmentId'>
): Promise<Proposal[]> {
  const now = deps.clock.now()
  const records = await deps.proposals.list(tenant.environmentId, PROPOSAL_LIST_LIMIT)
  return records.map((record) => toProposal(record, now))
}

/**
 * Read one proposal.
 *
 * @param deps - Proposal store and clock.
 * @param tenant - The resolved tenant.
 * @param id - The proposal.
 * @returns The proposal.
 * @throws NotFoundError when the environment has none with that id (another environment's
 *   proposal is answered the same).
 */
export async function get(
  deps: Pick<Deps, 'proposals' | 'clock'>,
  tenant: Pick<Tenant, 'environmentId'>,
  id: string
): Promise<Proposal> {
  const record = await deps.proposals.find(tenant.environmentId, id)
  if (!record) {
    throw new NotFoundError()
  }
  return toProposal(record, deps.clock.now())
}

/**
 * Ask for a change as a proposal. **Nothing changes**: a row and an audit entry are written,
 * and the operation waits for a human to approve it ({@link approve}).
 *
 * Asking again for the same operation on the same target while the first proposal still waits
 * answers that proposal: an agent that repeats itself does not put a second question in front
 * of a human. (Two requests at the very same instant can still make two; each is single use.)
 *
 * A production environment accepts no proposal. Whether one may is a setting an operator
 * chooses, which does not exist yet; until it does the answer is no.
 *
 * @param deps - Stores, ids and clock.
 * @param tenant - The resolved tenant.
 * @param input - The operation and its target: ids and closed words, no text.
 * @param actor - Who asks. Must be an agent.
 * @returns The proposal, `pending`.
 * @throws AuthError `auth.invalid_key` when the actor is not an agent.
 * @throws ForbiddenError with `params.reason` (`production_environment`).
 * @throws NotFoundError when the target does not exist in this environment.
 */
export async function create(
  deps: Pick<Deps, 'proposals' | 'environments' | 'users' | 'ids' | 'clock'>,
  tenant: Scope,
  input: CreateProposalRequest,
  actor: Actor
): Promise<Proposal> {
  // The router's middleware admits an agent key and nothing else; this holds the rule for
  // every other caller. A human who wants a change makes it.
  if (actor.type !== 'agent' || !actor.id) {
    throw new AuthError('auth.invalid_key')
  }
  // The contract's schema lists one target type per operation today; a second one must not
  // reach an operation that is not about it.
  if (PROPOSAL_OPERATION_TARGETS[input.operation] !== input.target.type) {
    throw new NotFoundError()
  }
  const environment = await deps.environments.findById(tenant.environmentId)
  if (!environment) {
    throw new NotFoundError()
  }
  if (environment.kind === 'production') {
    refuseCreation(
      'production_environment',
      'A production environment does not accept proposals from an agent.'
    )
  }
  // The agent can read the user anyway (an agent key reads what a secret key reads), so
  // saying that there is none tells it nothing new, and keeps a proposal about nobody from
  // being put in front of a human.
  const user = await deps.users.findById(tenant.environmentId, input.target.id)
  if (!user) {
    throw new NotFoundError()
  }
  const now = deps.clock.now()
  const like = {
    operation: input.operation,
    targetType: input.target.type,
    targetId: user.id,
    proposedBy: actor.id,
  }
  const waiting = await deps.proposals.findPending(tenant.environmentId, like, now)
  if (waiting) {
    return toProposal(waiting, now)
  }
  const id = deps.ids.next()
  const record = await deps.proposals.insert(
    {
      id,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      ...like,
      status: 'pending',
      expiresAt: new Date(now.getTime() + PROPOSAL_TTL_MS),
      approvedByType: null,
      approvedById: null,
      approvedAt: null,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    },
    Audit.entry(deps, tenant, {
      type: 'proposal.created',
      actor,
      target: { type: 'proposal', id },
      data: proposed(like),
    })
  )
  return toProposal(record, now)
}

/** The human behind an approving request, or a refusal when the actor is not one. */
function approverOf(actor: Actor): ProposalApprover {
  const types: readonly string[] = PROPOSAL_APPROVER_TYPES
  if (!types.includes(actor.type)) {
    throw new AuthError('auth.invalid_key')
  }
  return { type: actor.type as ProposalApproverType, id: actor.id }
}

type ExecutionDeps = Pick<Deps, 'users' | 'sessions' | 'revokedSessions' | 'clock' | 'ids'>

/**
 * Carry out an approved proposal's operation, as the agent that asked, with the approving
 * human named beside it.
 *
 * @returns `null` when it was carried out, otherwise why it was not, in a fixed word.
 */
async function execute(
  deps: ExecutionDeps,
  scope: Scope,
  record: ProposalRecord,
  agent: Actor,
  approvedBy: ProposalApprover
): Promise<ProposalFailureReason | null> {
  try {
    // One operation today. A second one is a branch here and an entry in the contract's
    // list, never a string taken from the row and looked up.
    await Users.ban(deps, scope, record.targetId, agent, { proposalId: record.id, approvedBy })
    return null
  } catch (error) {
    if (error instanceof NotFoundError) {
      return 'target_not_found'
    }
    // Fixed words and ids: the failure's own text can quote what it failed on.
    logger.error('an approved proposal could not be carried out', {
      environmentId: scope.environmentId,
      proposalId: record.id,
      error: error instanceof Error ? error.name : 'unknown',
    })
    return 'error'
  }
}

/**
 * Approve a proposal and carry out its operation.
 *
 * The order is what makes a proposal single use: the approval is written first, by a
 * compare-and-set on "still pending and not expired" together with its audit entry, and only
 * the request that wrote it goes on to the operation. A second approval, one at the same
 * instant and one after the expiry all write nothing and do nothing.
 *
 * The body names the operation and the target the human was shown. What is carried out is
 * what the **proposal** holds, and only when the body names the same: an approval is of what
 * was read, never of an id alone.
 *
 * The operation runs as the agent that asked (its entries, `user.banned` among them, carry
 * the `agent` actor) with the approving human in their `data`; the approval itself is the
 * human's entry. An operation that fails leaves the proposal `failed` and spent: it is never
 * run again. When even that cannot be recorded the proposal stays `approved`, which is just
 * as final, and the log says so.
 *
 * @param deps - Stores, sessions, ids and clock.
 * @param tenant - The resolved tenant.
 * @param id - The proposal.
 * @param shown - The operation and target the approver was shown.
 * @param actor - Who approves: a secret key or a dashboard session, never an agent.
 * @returns The proposal as it is afterwards (`executed`, `failed`, or `approved`).
 * @throws AuthError `auth.invalid_key` when the actor is not a human's credential.
 * @throws NotFoundError when the environment has no such proposal.
 * @throws ConflictError with `params.reason`: `mismatch`, `already_decided` or `expired`.
 */
export async function approve(
  deps: Pick<Deps, 'proposals'> & ExecutionDeps,
  tenant: Scope,
  id: string,
  shown: ApproveProposalRequest,
  actor: Actor
): Promise<Proposal> {
  const approvedBy = approverOf(actor)
  const found = await deps.proposals.find(tenant.environmentId, id)
  if (!found) {
    throw new NotFoundError()
  }
  if (
    shown.operation !== found.operation ||
    shown.target.type !== found.targetType ||
    shown.target.id !== found.targetId
  ) {
    refuseApproval('mismatch', 'That is not what this proposal would do.')
  }
  const now = deps.clock.now()
  const approved = await deps.proposals.approve(
    tenant.environmentId,
    id,
    approvedBy,
    now,
    Audit.entry(deps, tenant, {
      type: 'proposal.approved',
      actor,
      target: { type: 'proposal', id },
      data: { ...proposed(found), proposedBy: found.proposedBy },
    })
  )
  if (!approved) {
    // Nothing was written. Which of the two it was is read again, for the answer only.
    const current = await deps.proposals.find(tenant.environmentId, id)
    if (!current) {
      throw new NotFoundError()
    }
    if (current.status !== 'pending') {
      refuseApproval('already_decided', 'This proposal was approved before.')
    }
    refuseApproval('expired', 'This proposal has expired. Nothing was changed.')
  }

  // From here on the proposal is spent, whatever happens.
  // The agent is the actor of what follows, and it did not make this request: the address
  // and the user agent here are the approver's, and are on the approver's entry alone. An
  // agent's entry with a person's origin would mix two origins under one actor.
  const agent: Actor = {
    type: 'agent',
    id: approved.proposedBy,
    ipAddress: null,
    userAgent: null,
  }
  const reason = await execute(deps, tenant, approved, agent, approvedBy)
  const target = { type: 'proposal', id } as const
  try {
    const finished = await deps.proposals.finish(
      tenant.environmentId,
      id,
      reason === null ? { status: 'executed' } : { status: 'failed', reason },
      deps.clock.now(),
      reason === null
        ? Audit.entry(deps, tenant, {
            type: 'proposal.executed',
            actor: agent,
            target,
            data: { ...proposed(approved), approvedBy },
          })
        : Audit.entry(deps, tenant, {
            type: 'proposal.failed',
            actor: agent,
            target,
            data: { ...proposed(approved), approvedBy, reason },
          })
    )
    return toProposal(finished ?? approved, deps.clock.now())
  } catch (error) {
    // The operation ran (or was refused) and its own entries are written; only the
    // proposal's last word is missing. It stays `approved`, which nothing approves again.
    logger.error('the outcome of an approved proposal could not be recorded', {
      environmentId: tenant.environmentId,
      proposalId: id,
      carriedOut: reason === null,
      error: error instanceof Error ? error.name : 'unknown',
    })
    return toProposal(approved, deps.clock.now())
  }
}
