import { ApproveProposalRequestSchema, proposalSummary } from '@tula/contract'
import { z } from 'zod'
import { type FakeCall, type FakeHandler, failure, IDS } from './fake-api'
import { invalid } from './fake-webhooks'

// The fake API's proposal routes (`/v1/admin/proposals`, and the one session read the
// screen makes to describe a target): the shapes, the refusals and their order of
// `apps/api/src/modules/proposal`, on plain in-memory data.
//
// Held to the API by `fake-proposals.test.ts`: an id that is no UUID and a body the
// contract's strict schema refuses are 422 before anything is looked up; a proposal of
// another environment is not found; an approval is refused with `resource.conflict` and the
// contract's reason, in the service's order (`mismatch`, a revoked key, `already_decided`,
// `expired`); a proposal past its time, or whose key was revoked, is read as `expired`
// with its reason; `changed` is in the approval's answer and in no later read.
//
// Where it differs from the API, on purpose:
// - Nobody proposes: a test puts proposals in the state (`fakeProposal`).
// - An operation is "carried out" on the fake's users, sessions and nothing else: a ban
//   sets `bannedAt`, ending a session removes it; a provider is never changed. A test of
//   `failed`, of `changed: false` for a provider or of `production_environment` overrides
//   the route.
// - There is one set of users and sessions for every environment.
// - No rate limit, and no audit entry is written.

const ENVIRONMENT = 'x-tula-environment'

const ProposalParams = z.object({ id: z.uuid() })

/** A proposal as the fake holds it: what is stored, plus the environment it is in. */
export interface FakeProposal {
  id: string
  environmentId: string
  operation: string
  target: { type: string; id: string }
  /** What is stored: `expired` is derived when it is read. */
  status: 'pending' | 'approved' | 'executed' | 'failed'
  proposedBy: { type: 'agent'; id: string }
  createdAt: string
  expiresAt: string
  approvedBy: { type: string; id: string | null } | null
  approvedAt: string | null
  failureReason: string | null
  /** Whether the agent key that asked has been revoked since. */
  keyRevoked: boolean
  /** The server's sentence; made from the contract's when left out. */
  summary?: string
}

/** The part of the fake's state the proposal routes work on. */
export interface FakeProposalState {
  /** Every environment's proposals, oldest first. */
  proposals: FakeProposal[]
  /** The server's clock, as the proposal routes read it. Only a test moves it. */
  proposalNow: string
  users: { id: string; bannedAt: string | null }[]
  sessions: Record<string, unknown>[]
}

/** The agent key the fake's proposals were asked for with. */
export const FAKE_AGENT_KEY_ID = '00000000-0000-7000-8000-0000000000f9'

let made = 0

/**
 * A proposal for a test to put in the fake's state: a ban of the fake's user, asked for in
 * the development environment a minute ago, waiting, with nine minutes left.
 *
 * @param overrides - What differs.
 * @returns The proposal.
 */
export function fakeProposal(overrides: Partial<FakeProposal> = {}): FakeProposal {
  made += 1
  return {
    id: `00000000-0000-7000-8000-a${String(made).padStart(11, '0')}`,
    environmentId: IDS.development,
    operation: 'ban_user',
    target: { type: 'user', id: IDS.user },
    status: 'pending',
    proposedBy: { type: 'agent', id: FAKE_AGENT_KEY_ID },
    createdAt: '2026-10-04T11:59:00.000Z',
    expiresAt: '2026-10-04T12:09:00.000Z',
    approvedBy: null,
    approvedAt: null,
    failureReason: null,
    keyRevoked: false,
    ...overrides,
  }
}

function summaryOf(proposal: FakeProposal): string {
  if (proposal.summary !== undefined) {
    return proposal.summary
  }
  try {
    return proposalSummary(proposal.operation as never, proposal.target as never)
  } catch {
    return 'An operation this fake has no sentence for.'
  }
}

/** Why a pending proposal can no longer be approved; `null` while it can. */
function ended(proposal: FakeProposal, now: string): 'agent_key_revoked' | 'time' | null {
  if (proposal.status !== 'pending') {
    return null
  }
  // Revoked wins over time, as the API reads it.
  if (proposal.keyRevoked) {
    return 'agent_key_revoked'
  }
  return Date.parse(proposal.expiresAt) <= Date.parse(now) ? 'time' : null
}

function view(proposal: FakeProposal, now: string) {
  const { environmentId: _environmentId, keyRevoked: _keyRevoked, ...rest } = proposal
  const expiry = ended(proposal, now)
  return {
    ...rest,
    summary: summaryOf(proposal),
    status: expiry === null ? proposal.status : 'expired',
    expiryReason: expiry,
  }
}

function notFound(): Response {
  return failure(404, 'resource.not_found', 'The requested resource does not exist.')
}

function conflict(reason: string, detail: string): Response {
  return failure(409, 'resource.conflict', detail, undefined, { reason })
}

/** Carry an operation out on the fake's data; whether anything changed. */
function carryOut(state: FakeProposalState, proposal: FakeProposal): boolean | 'missing' {
  if (proposal.operation === 'end_session') {
    const before = state.sessions.length
    state.sessions = state.sessions.filter((session) => session.id !== proposal.target.id)
    return state.sessions.length < before
  }
  if (proposal.operation === 'ban_user' || proposal.operation === 'unban_user') {
    const user = state.users.find((entry) => entry.id === proposal.target.id)
    if (!user) {
      return 'missing'
    }
    const banned = user.bannedAt !== null
    const wanted = proposal.operation === 'ban_user'
    user.bannedAt = wanted ? (user.bannedAt ?? state.proposalNow) : null
    // As the API answers: `changed` is what the operation itself wrote. A ban always says
    // true (it ends sessions and writes its entry again for a user banned already);
    // lifting a ban says true only when there was one to lift.
    return wanted || banned
  }
  return true
}

/**
 * The fake's proposal routes, and the read of one session by its id.
 *
 * @param state - The fake's state.
 * @returns The routes, for `installFakeApi`.
 */
export function proposalRoutes(state: FakeProposalState): [string, RegExp, FakeHandler][] {
  function find(call: FakeCall, id: string): FakeProposal | undefined {
    return state.proposals.find(
      (entry) => entry.id === id && entry.environmentId === call.headers.get(ENVIRONMENT)
    )
  }
  return [
    [
      'GET',
      /^\/v1\/admin\/proposals$/,
      (call) => ({
        // Newest first, whatever became of them.
        data: state.proposals
          .filter((entry) => entry.environmentId === call.headers.get(ENVIRONMENT))
          .map((entry) => view(entry, state.proposalNow))
          .reverse(),
      }),
    ],
    [
      'GET',
      /^\/v1\/admin\/proposals\/([^/]+)$/,
      (call, match) => {
        const params = ProposalParams.safeParse({ id: match[1] })
        if (!params.success) {
          return invalid(params.error)
        }
        const proposal = find(call, params.data.id)
        return proposal ? view(proposal, state.proposalNow) : notFound()
      },
    ],
    [
      'POST',
      /^\/v1\/admin\/proposals\/([^/]+)\/approve$/,
      (call, match) => {
        const params = ProposalParams.safeParse({ id: match[1] })
        if (!params.success) {
          return invalid(params.error)
        }
        const body = ApproveProposalRequestSchema.safeParse(call.body)
        if (!body.success) {
          return invalid(body.error)
        }
        const proposal = find(call, params.data.id)
        if (!proposal) {
          return notFound()
        }
        if (
          body.data.operation !== proposal.operation ||
          body.data.target.type !== proposal.target.type ||
          body.data.target.id !== proposal.target.id
        ) {
          return conflict('mismatch', 'That is not what this proposal would do.')
        }
        if (proposal.status !== 'pending') {
          return conflict('already_decided', 'This proposal was approved before.')
        }
        const expiry = ended(proposal, state.proposalNow)
        if (expiry === 'agent_key_revoked') {
          return conflict('agent_key_revoked', 'The agent key that asked was revoked.')
        }
        if (expiry === 'time') {
          return conflict('expired', 'This proposal has expired. Nothing was changed.')
        }
        proposal.approvedBy = { type: 'instance_admin', id: 'dash-session' }
        proposal.approvedAt = state.proposalNow
        const changed = carryOut(state, proposal)
        if (changed === 'missing') {
          proposal.status = 'failed'
          proposal.failureReason = 'target_not_found'
          return view(proposal, state.proposalNow)
        }
        proposal.status = 'executed'
        // Only this answer says whether anything changed: it is not stored with the row.
        return { ...view(proposal, state.proposalNow), changed }
      },
    ],
    [
      'GET',
      /^\/v1\/admin\/sessions\/([^/]+)$/,
      (_call, match) => {
        const session = state.sessions.find((entry) => entry.id === match[1])
        return session ? { userId: IDS.user, active: true, ...session } : notFound()
      },
    ],
  ]
}
