import {
  type ApproveProposalRequest,
  type CreateProposalRequest,
  isProposalTargetId,
  type OAuthProvider,
  PROPOSAL_APPROVER_TYPES,
  PROPOSAL_OPERATION_TARGETS,
  type Proposal,
  type ProposalApprovalRefusal,
  type ProposalApprover,
  type ProposalApproverType,
  type ProposalCreationRefusal,
  type ProposalExpiryReason,
  type ProposalFailureReason,
  type ProposalTargetType,
  proposalSummary,
} from '@tula/contract'
import type { Deps, Tenant } from '~/dependencies'
import {
  AuthError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '~/exceptions'
import type { Actor } from '~/lib/actor'
import * as logger from '~/lib/logger'
import * as Audit from '~/modules/audit/service'
import * as OAuth from '~/modules/oauth/service'
import * as Sessions from '~/modules/session/service'
import * as Settings from '~/modules/settings/service'
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

/**
 * Proposals of **one operation** an environment's agents may ask for in a minute. Each
 * operation has a count of its own beside the one all of them share
 * ({@link PROPOSALS_PER_MINUTE}): an agent that was talked into asking for one thing again
 * and again uses up that operation's minute and half of the shared one, and the other
 * operations can still be asked for. The shared count stays, because what it protects (how
 * many proposals wait for a human at once) is shared.
 */
export const PROPOSALS_PER_OPERATION_PER_MINUTE = 5

/** The most proposals the list answers: the newest. */
export const PROPOSAL_LIST_LIMIT = 100

/**
 * A stored proposal as the admin API answers it.
 *
 * "Expired" is decided here: a pending proposal whose time has passed (from the clock) or
 * whose agent key has been revoked (read with the row). The
 * sentence is the contract's, with the target's id in it and nothing anyone typed.
 *
 * @param record - The stored proposal.
 * @param now - The time to judge its expiry by.
 * @returns The proposal.
 */
export function toProposal(record: ProposalRecord, now: Date): Proposal {
  const target = { type: record.targetType, id: record.targetId }
  const pending = record.status === 'pending'
  // Revoking an agent key ends what it asked for and nobody approved: nothing is written
  // to the proposal, the revocation is the write. Said first, because it is the reason
  // that matters to whoever reads it, also when the time has run out as well.
  const revoked = pending && !record.proposerActive
  const timedOut = pending && record.expiresAt.getTime() <= now.getTime()
  const expiryReason: ProposalExpiryReason | null = revoked
    ? 'agent_key_revoked'
    : timedOut
      ? 'time'
      : null
  return {
    id: record.id,
    operation: record.operation,
    target,
    summary: proposalSummary(record.operation, target),
    status: expiryReason === null ? record.status : 'expired',
    proposedBy: { type: 'agent', id: record.proposedBy },
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    approvedBy:
      record.approvedByType === null
        ? null
        : { type: record.approvedByType, id: record.approvedById },
    approvedAt: record.approvedAt?.toISOString() ?? null,
    failureReason: record.failureReason,
    expiryReason,
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
 * Refuse unless the environment accepts agents' proposals now: every environment that is not
 * a production one does, and a production one only while its settings say so
 * (`agents.proposalsInProduction`, off by default).
 *
 * "Production" is the environment's own kind, as the control plane stores it and the
 * dashboard shows it: never `ENVIRONMENT` or `NODE_ENV`, which describe the deployment.
 *
 * The setting is read **past the cache**, when a proposal is asked for and again when it is
 * approved: an opt-in that was switched off stops what is waiting on this instance and on
 * every other at once, not within the cache's seconds. (A request that passed this line and
 * writes its approval a moment after the setting changed is still an approval: the two are
 * not one transaction, and the entries say the order.)
 *
 * @param refuse - What says no, in the caller's own code and word.
 * @throws NotFoundError when the environment is gone.
 */
async function requireAccepted(
  deps: Pick<Deps, 'environments' | 'environmentSettings' | 'config'>,
  tenant: Pick<Tenant, 'environmentId'>,
  refuse: () => never
): Promise<void> {
  const environment = await deps.environments.findById(tenant.environmentId)
  if (!environment) {
    throw new NotFoundError()
  }
  if (environment.kind !== 'production') {
    return
  }
  const { settings } = await Settings.get(deps, tenant, true)
  if (!settings.agents.proposalsInProduction) {
    refuse()
  }
}

type TargetDeps = Pick<Deps, 'users' | 'sessions' | 'oauthProviders'>

/**
 * Whether what a proposal names exists in this environment, read through the store of its
 * kind. One branch per target type of the contract's closed list.
 */
async function targetExists(
  deps: TargetDeps,
  environmentId: string,
  target: { type: ProposalTargetType; id: string }
): Promise<boolean> {
  switch (target.type) {
    case 'user':
      return (await deps.users.findById(environmentId, target.id)) !== null
    case 'session':
      return (await deps.sessions.findById(environmentId, target.id)) !== null
    case 'oauth_provider':
      return (await deps.oauthProviders.find(environmentId, target.id as OAuthProvider)) !== null
  }
}

/** What a revoked key asked for is never carried out, however recently it asked. */
function refuseRevoked(): never {
  refuseApproval(
    'agent_key_revoked',
    'The agent key that asked for this has been revoked. Nothing was changed.'
  )
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
 * A production environment accepts no proposal unless its operator switched that on
 * (`agents.proposalsInProduction`, off by default): decided before the target is read.
 *
 * Switching a provider off is judged here as a courtesy and again, with authority, when the
 * approval carries it out: a proposal that would leave the environment with no way to sign
 * in is refused with the error the admin route answers, so that a person is not asked to
 * approve what would be refused anyway.
 *
 * @param deps - Stores, settings, ids and clock.
 * @param tenant - The resolved tenant.
 * @param input - The operation and its target: ids and closed words, no text.
 * @param actor - Who asks. Must be an agent.
 * @returns The proposal, `pending`.
 * @throws AuthError `auth.invalid_key` when the actor is not an agent.
 * @throws ForbiddenError with `params.reason` (`production_environment`).
 * @throws NotFoundError when the target does not exist in this environment.
 * @throws ValidationError (422) for a provider whose switching off would leave the
 *   environment with no way to sign in.
 */
export async function create(
  deps: Pick<
    Deps,
    'proposals' | 'environments' | 'environmentSettings' | 'config' | 'ids' | 'clock'
  > &
    TargetDeps,
  tenant: Scope,
  input: CreateProposalRequest,
  actor: Actor
): Promise<Proposal> {
  // The router's middleware admits an agent key and nothing else; this holds the rule for
  // every other caller. A human who wants a change makes it.
  if (actor.type !== 'agent' || !actor.id) {
    throw new AuthError('auth.invalid_key')
  }
  // An operation acts on one kind of thing, named the way that kind is named. The request's
  // schema holds the second half; both are asked here for every other caller.
  if (
    PROPOSAL_OPERATION_TARGETS[input.operation] !== input.target.type ||
    !isProposalTargetId(input.target.type, input.target.id)
  ) {
    throw new NotFoundError()
  }
  await requireAccepted(deps, tenant, () =>
    refuseCreation(
      'production_environment',
      'This production environment does not accept proposals from an agent.'
    )
  )
  // The agent can read the target anyway (an agent key reads what a secret key reads), so
  // saying that there is none tells it nothing new, and keeps a proposal about nothing from
  // being put in front of a human.
  if (!(await targetExists(deps, tenant.environmentId, input.target))) {
    throw new NotFoundError()
  }
  if (input.operation === 'disable_oauth_provider') {
    const provider = input.target.id as OAuthProvider
    const existing = await deps.oauthProviders.find(tenant.environmentId, provider)
    // A courtesy, outside the lock: the approval asks again inside it, and that is what
    // decides. The error is the admin route's own.
    if (existing?.enabled) {
      await OAuth.requireWayIn(deps, tenant, provider)
    }
  }
  const now = deps.clock.now()
  const like = {
    operation: input.operation,
    targetType: input.target.type,
    targetId: input.target.id,
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

type ExecutionDeps = Pick<
  Deps,
  | 'users'
  | 'sessions'
  | 'revokedSessions'
  | 'oauthProviders'
  | 'environmentSettings'
  | 'environmentLock'
  | 'config'
  | 'clock'
  | 'ids'
>

/**
 * Run the one function an operation is, as the agent that asked, with the proposal and its
 * approver for the change's own entry. One branch per operation of the contract's closed
 * list, each calling a service function an administrator's route calls too (or, for a
 * provider, the function that holds the same rule under the same lock): never a string
 * taken from the row and looked up, never a stored request replayed.
 */
async function run(
  deps: ExecutionDeps,
  scope: Scope,
  record: ProposalRecord,
  agent: Actor,
  approvedBy: ProposalApprover
): Promise<void> {
  const proposal = { proposalId: record.id, approvedBy }
  switch (record.operation) {
    case 'ban_user':
      await Users.ban(deps, scope, record.targetId, agent, proposal)
      return
    case 'unban_user':
      await Users.unban(deps, scope, record.targetId, agent, proposal)
      return
    case 'end_session':
      await Sessions.revokeForProposal(deps, scope, record.targetId, agent, proposal)
      return
    case 'disable_oauth_provider':
      await OAuth.switchOff(deps, scope, record.targetId as OAuthProvider, agent, proposal)
      return
  }
}

/**
 * Carry out an approved proposal's operation, as the agent that asked, with the approving
 * human named beside it.
 *
 * The target is read once before the operation, so that a failure can be told apart:
 * `incomplete` is said only when the operation's change was not there before and is there
 * after. A user somebody had already banned, whose ban this run failed to write, was not
 * changed by it (`error`).
 *
 * @returns `null` when it was carried out, otherwise why it did not end so, in a fixed
 *   word: `incomplete` when the operation's own change was made and a later step failed.
 */
async function execute(
  deps: ExecutionDeps,
  scope: Scope,
  record: ProposalRecord,
  agent: Actor,
  approvedBy: ProposalApprover
): Promise<ProposalFailureReason | null> {
  // `null`: the target could not be read, so nothing can be claimed about what a failure
  // left. The approval is written by now; the operation runs all the same.
  const changedBefore = await changeIsThere(deps, scope, record)
  try {
    await run(deps, scope, record, agent, approvedBy)
    return null
  } catch (error) {
    if (error instanceof NotFoundError) {
      return 'target_not_found'
    }
    // The one refusal an operation has of its own: `OAuth.switchOff` throws nothing else of
    // this kind. Judged under the environment's lock, at this moment: what the proposal's
    // creation saw minutes ago decided nothing.
    if (record.operation === 'disable_oauth_provider' && error instanceof ValidationError) {
      return 'last_sign_in_method'
    }
    // Fixed words and ids: the failure's own text can quote what it failed on.
    logger.error('an approved proposal could not be carried out', {
      environmentId: scope.environmentId,
      proposalId: record.id,
      error: error instanceof Error ? error.name : 'unknown',
    })
    if (changedBefore !== false) {
      return 'error'
    }
    return (await changeIsThere(deps, scope, record)) === true ? 'incomplete' : 'error'
  }
}

/**
 * Whether the target shows the operation's own change, asked before the operation and
 * again after it failed.
 *
 * A ban is committed before the user's sessions are ended, so a failure of the second step
 * leaves a banned user who may still hold a live session. That must not be reported as
 * "not carried out": a ban that was not there before and is there after is said as
 * `incomplete`. A read that fails claims nothing (`error`); nothing is retried.
 *
 * The other operations' own write is their last step (a ban is lifted after the sessions
 * are ended once more; a session is ended after its id is denylisted; a provider is one
 * row's update), so for them `incomplete` would take a failure after the write committed.
 * Each still says here what its write looks like, so that such a failure is not reported
 * as "nothing happened".
 *
 * @returns `true` when the target shows the operation's write, `false` when it does not
 *   (a target that is gone included), `null` when it could not be read.
 */
async function changeIsThere(
  deps: ExecutionDeps,
  scope: Scope,
  record: ProposalRecord
): Promise<boolean | null> {
  try {
    switch (record.operation) {
      case 'ban_user':
        return (await deps.users.findById(scope.environmentId, record.targetId))?.bannedAt != null
      case 'unban_user': {
        const user = await deps.users.findById(scope.environmentId, record.targetId)
        return user !== null && user.bannedAt === null
      }
      case 'end_session': {
        const session = await deps.sessions.findById(scope.environmentId, record.targetId)
        return session?.revokedAt != null
      }
      case 'disable_oauth_provider': {
        const provider = await deps.oauthProviders.find(
          scope.environmentId,
          record.targetId as OAuthProvider
        )
        return provider !== null && !provider.enabled
      }
    }
  } catch (error) {
    logger.error('the target of an approved proposal could not be read', {
      environmentId: scope.environmentId,
      proposalId: record.id,
      error: error instanceof Error ? error.name : 'unknown',
    })
    return null
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
 * A production environment that does not accept proposals (it never did, or its operator
 * switched that off after this one was made) approves none: refused before anything is
 * written, and the proposal is not spent.
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
 * @throws ConflictError with `params.reason`: `production_environment`, `mismatch`,
 *   `agent_key_revoked`, `already_decided` or `expired`.
 */
export async function approve(
  deps: Pick<Deps, 'proposals' | 'environments'> & ExecutionDeps,
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
  // Asked again here, past the settings cache: an environment that stopped accepting
  // proposals after this one was made carries none out.
  await requireAccepted(deps, tenant, () =>
    refuseApproval(
      'production_environment',
      'This production environment does not accept proposals from an agent. Nothing was changed.'
    )
  )
  if (
    shown.operation !== found.operation ||
    shown.target.type !== found.targetType ||
    shown.target.id !== found.targetId
  ) {
    refuseApproval('mismatch', 'That is not what this proposal would do.')
  }
  // The first of two defences: the store's statement has the same condition, which is the
  // one that holds against a revocation landing after this line.
  if (found.status === 'pending' && !found.proposerActive) {
    refuseRevoked()
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
    if (!current.proposerActive) {
      refuseRevoked()
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
