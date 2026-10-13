import { z } from 'zod'
import { OAUTH_PROVIDERS } from './oauth'

// A proposal (ADR 0053): a change an AI agent has asked for and that has not happened. It
// happens only when a human approves it, with a credential the agent never holds.

/**
 * What an agent may propose: a closed list of **reversible** operations. An operation is here
 * because a human can undo it:
 *
 * - `ban_user`: the ban is lifted;
 * - `unban_user`: the user is banned again;
 * - `end_session`: one session, by its id; its user signs in again;
 * - `disable_oauth_provider`: one provider is switched off (`enabled: false` and nothing
 *   else: its credentials stay, nothing is removed); an administrator switches it on again.
 *
 * Never on the list: anything that cannot be undone (deleting a user, resetting a user's
 * factors, rotating keys, removing a provider's credentials), anything that returns or sets
 * a secret, switching a provider **on**, replacing settings, and anything that acts on more
 * than one target (ending every session of a user is such a thing).
 *
 * @example
 * ```ts
 * const operation: ProposalOperation = 'ban_user'
 * ```
 */
export const PROPOSAL_OPERATIONS = [
  'ban_user',
  'unban_user',
  'end_session',
  'disable_oauth_provider',
] as const

/**
 * What a proposal can be about.
 *
 * @example
 * ```ts
 * const type: ProposalTargetType = 'user'
 * ```
 */
export const PROPOSAL_TARGET_TYPES = ['user', 'session', 'oauth_provider'] as const

/**
 * What each operation acts on. A proposal whose target is of another kind is refused.
 *
 * @example
 * ```ts
 * PROPOSAL_OPERATION_TARGETS.ban_user // 'user'
 * ```
 */
export const PROPOSAL_OPERATION_TARGETS = {
  ban_user: 'user',
  unban_user: 'user',
  end_session: 'session',
  disable_oauth_provider: 'oauth_provider',
} as const satisfies Record<
  (typeof PROPOSAL_OPERATIONS)[number],
  (typeof PROPOSAL_TARGET_TYPES)[number]
>

/**
 * Where a proposal stands:
 *
 * - `pending`: asked for, nothing has happened, a human may approve it until `expiresAt`;
 * - `expired`: it can no longer be approved, and nothing happened: nobody approved it in
 *   time, or the agent key that asked was revoked (`expiryReason` says which);
 * - `approved`: a human approved it and the operation was started. A proposal stays here
 *   only when the server could not record how the operation ended; it is never run again;
 * - `executed`: approved, and the operation was carried out;
 * - `failed`: approved, and the operation was not carried out (`failureReason` says why).
 *
 * A proposal is approved at most once: every status but `pending` is final for an approval.
 *
 * @example
 * ```ts
 * if (proposal.status === 'pending') {
 *   // A human can still approve it.
 * }
 * ```
 */
export const PROPOSAL_STATUSES = ['pending', 'expired', 'approved', 'executed', 'failed'] as const

/**
 * Why an approved proposal's operation did not end as carried out, in one of the server's
 * fixed words:
 *
 * - `target_not_found`: what it names no longer exists; nothing was changed;
 * - `incomplete`: **the operation's own change was made and a later step of it failed.**
 *   For `ban_user`: the user is banned, and ending their sessions failed, so some may
 *   still be live until they are ended (the admin route that ends a user's sessions, or
 *   the dashboard). Never read this as "nothing happened";
 * - `error`: anything else. The target was read again afterwards and the change was not
 *   there; the server's log has the failure;
 * - `last_sign_in_method`: for `disable_oauth_provider`: when the approval came, switching
 *   the provider off would have left the environment with no way to sign in, so it was
 *   refused, by the rule an administrator's own change is held to. Nothing was changed.
 *
 * @example
 * ```ts
 * const reason: ProposalFailureReason = 'target_not_found'
 * ```
 */
export const PROPOSAL_FAILURE_REASONS = [
  'target_not_found',
  'error',
  'incomplete',
  'last_sign_in_method',
] as const

/**
 * Why a proposal is `expired`, in one of the server's fixed words:
 *
 * - `time`: nobody approved it before its `expiresAt`;
 * - `agent_key_revoked`: the agent key that asked was revoked (or is gone) while it waited.
 *   Revoking an agent key ends everything it has asked for and that nobody has approved.
 *
 * @example
 * ```ts
 * if (proposal.expiryReason === 'agent_key_revoked') {
 *   // The key was revoked: whatever it asked for is not to be trusted.
 * }
 * ```
 */
export const PROPOSAL_EXPIRY_REASONS = ['time', 'agent_key_revoked'] as const

/**
 * Why an approval is refused with `resource.conflict`, as `params.reason` says it:
 *
 * - `expired`: the proposal was not approved before its `expiresAt`;
 * - `already_decided`: it was approved before (a proposal is single use);
 * - `mismatch`: the approval names another operation or target than the proposal holds;
 * - `agent_key_revoked`: the agent key that asked has been revoked (or is gone). What a
 *   revoked key asked for is never carried out, however recently it asked;
 * - `production_environment`: the environment is a production one and does not accept
 *   agents' proposals now (`agents.proposalsInProduction` is off: it was never on, or was
 *   switched off after the proposal was made). The proposal is not spent by this refusal.
 *
 * @example
 * ```ts
 * if (error.params.reason === 'expired') {
 *   // Ask the agent to propose again.
 * }
 * ```
 */
export const PROPOSAL_APPROVAL_REFUSALS = [
  'expired',
  'already_decided',
  'mismatch',
  'agent_key_revoked',
  'production_environment',
] as const

/**
 * Why asking for a proposal is refused with `auth.forbidden`, as `params.reason` says it:
 *
 * - `production_environment`: a production environment accepts no proposal from an agent
 *   unless its settings say so (`agents.proposalsInProduction`, off by default).
 *
 * @example
 * ```ts
 * if (error.params.reason === 'production_environment') {
 *   // Make the change yourself, in the dashboard.
 * }
 * ```
 */
export const PROPOSAL_CREATION_REFUSALS = ['production_environment'] as const

/**
 * Who may approve a proposal: an `admin` (a secret key) or the `instance_admin` (a dashboard
 * session). Never an `agent`.
 *
 * @example
 * ```ts
 * const type: ProposalApproverType = 'admin'
 * ```
 */
export const PROPOSAL_APPROVER_TYPES = ['admin', 'instance_admin'] as const

/** One of {@link PROPOSAL_OPERATIONS}. */
export const ProposalOperationSchema = z
  .enum(PROPOSAL_OPERATIONS)
  .meta({ ref: 'ProposalOperation' })

/** One of {@link PROPOSAL_STATUSES}. */
export const ProposalStatusSchema = z.enum(PROPOSAL_STATUSES).meta({ ref: 'ProposalStatus' })

/**
 * Whether `id` is how a target of that kind is named: a user and a session by the server's
 * own id (a UUID), an OAuth provider by its name from the closed list `OAUTH_PROVIDERS`
 * (`google`), which is how the admin API names one everywhere. Never anything a person
 * typed.
 *
 * @param type - The kind of target.
 * @param id - The candidate id.
 * @returns Whether a proposal may name that target so.
 *
 * @example
 * ```ts
 * isProposalTargetId('oauth_provider', 'google') // true
 * isProposalTargetId('user', 'google') // false
 * ```
 */
export function isProposalTargetId(
  type: (typeof PROPOSAL_TARGET_TYPES)[number],
  id: string
): boolean {
  const providers: readonly string[] = OAUTH_PROVIDERS
  return type === 'oauth_provider' ? providers.includes(id) : z.uuid().safeParse(id).success
}

/**
 * What a proposal would change: the kind of thing and its id. The id is the server's own
 * (a UUID) for a user and a session, and for an OAuth provider its name from the closed
 * list (`google`): never a name or an address anyone wrote.
 */
export const ProposalTargetSchema = z
  .strictObject({
    type: z.enum(PROPOSAL_TARGET_TYPES),
    id: z.union([z.uuid(), z.enum(OAUTH_PROVIDERS)]),
  })
  .refine((target) => isProposalTargetId(target.type, target.id), {
    path: ['id'],
    message: 'must name a target of that type',
  })
  .meta({ ref: 'ProposalTarget' })

/**
 * The human who approved a proposal: an `admin` (the id is the secret key's) or the
 * `instance_admin` (the id is the dashboard session's).
 */
export const ProposalApproverSchema = z
  .object({
    type: z.enum(PROPOSAL_APPROVER_TYPES),
    id: z.string().min(1).max(128).nullable(),
  })
  .meta({ ref: 'ProposalApprover' })

/** An operation acts on its own kind of target ({@link PROPOSAL_OPERATION_TARGETS}). */
function targetIsOfOperation(request: {
  operation: (typeof PROPOSAL_OPERATIONS)[number]
  target: { type: (typeof PROPOSAL_TARGET_TYPES)[number] }
}): boolean {
  return PROPOSAL_OPERATION_TARGETS[request.operation] === request.target.type
}

const TARGET_OF_OPERATION = {
  path: ['target', 'type'],
  message: 'must be the kind of target the operation acts on',
}

/**
 * Body of `POST /v1/agent/proposals`: the operation and its one target, and nothing else.
 * Strict: a proposal has no free text, no reason and no second target. The target is of
 * the operation's own kind ({@link PROPOSAL_OPERATION_TARGETS}).
 */
export const CreateProposalRequestSchema = z
  .strictObject({ operation: ProposalOperationSchema, target: ProposalTargetSchema })
  .refine(targetIsOfOperation, TARGET_OF_OPERATION)
  .meta({ ref: 'CreateProposalRequest' })

/**
 * Body of `POST /v1/admin/proposals/{id}/approve`: the operation and the target the human
 * was shown. The server carries out what the **proposal** holds, and only when this names
 * the same thing: an approval is of what was read, not of an id.
 */
export const ApproveProposalRequestSchema = z
  .strictObject({ operation: ProposalOperationSchema, target: ProposalTargetSchema })
  .refine(targetIsOfOperation, TARGET_OF_OPERATION)
  .meta({ ref: 'ApproveProposalRequest' })

/**
 * A proposal, as the admin API answers it.
 *
 * `summary` is the server's own sentence for the operation with the target's id in it
 * ({@link proposalSummary}): no text an agent or a user wrote is ever part of a proposal.
 */
export const ProposalSchema = z
  .object({
    id: z.uuid(),
    operation: ProposalOperationSchema,
    target: ProposalTargetSchema,
    /** What approving it does, in plain words. Written by the server. */
    summary: z.string(),
    status: ProposalStatusSchema,
    /** The agent that asked: the id is its agent key's. */
    proposedBy: z.object({ type: z.literal('agent'), id: z.uuid() }),
    createdAt: z.iso.datetime(),
    /** After this instant a pending proposal can no longer be approved. */
    expiresAt: z.iso.datetime(),
    /** Who approved it; `null` while nobody has. */
    approvedBy: ProposalApproverSchema.nullable(),
    /** When it was approved; `null` while it has not been. */
    approvedAt: z.iso.datetime().nullable(),
    /** For `failed`: why, in a fixed word. `null` otherwise. */
    failureReason: z.enum(PROPOSAL_FAILURE_REASONS).nullable(),
    /** For `expired`: why, in a fixed word. `null` otherwise. */
    expiryReason: z.enum(PROPOSAL_EXPIRY_REASONS).nullable(),
  })
  .meta({ ref: 'Proposal' })

/** An environment's proposals, newest first. */
export const ProposalListSchema = z
  .object({ data: z.array(ProposalSchema) })
  .meta({ ref: 'ProposalList' })

/** An operation an agent may propose. */
export type ProposalOperation = (typeof PROPOSAL_OPERATIONS)[number]
/** What a proposal can be about. */
export type ProposalTargetType = (typeof PROPOSAL_TARGET_TYPES)[number]
/** Where a proposal stands. */
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]
/** Why an approved proposal's operation was not carried out. */
export type ProposalFailureReason = (typeof PROPOSAL_FAILURE_REASONS)[number]
/** One of {@link PROPOSAL_EXPIRY_REASONS}. */
export type ProposalExpiryReason = (typeof PROPOSAL_EXPIRY_REASONS)[number]
/** Why asking for a proposal was refused. */
export type ProposalCreationRefusal = (typeof PROPOSAL_CREATION_REFUSALS)[number]
/** Why an approval was refused. */
export type ProposalApprovalRefusal = (typeof PROPOSAL_APPROVAL_REFUSALS)[number]
/** The kind of credential that may approve. */
export type ProposalApproverType = (typeof PROPOSAL_APPROVER_TYPES)[number]
/** What a proposal would change. */
export type ProposalTarget = z.infer<typeof ProposalTargetSchema>
/** Who approved a proposal. */
export type ProposalApprover = z.infer<typeof ProposalApproverSchema>
/** A proposal. */
export type Proposal = z.infer<typeof ProposalSchema>
/** A list of proposals. */
export type ProposalList = z.infer<typeof ProposalListSchema>
/** The body that asks for a proposal. */
export type CreateProposalRequest = z.infer<typeof CreateProposalRequestSchema>
/** The body that approves one. */
export type ApproveProposalRequest = z.infer<typeof ApproveProposalRequestSchema>

const SUMMARIES: Readonly<Record<ProposalOperation, (id: string) => string>> = {
  ban_user: (id) =>
    `Ban the user ${id}: every session of theirs ends now, and they cannot sign in until an administrator lifts the ban.`,
  unban_user: (id) =>
    `Lift the ban on the user ${id}: they can sign in again. The sessions that ended when they were banned stay ended.`,
  end_session: (id) =>
    `End the session ${id}: whoever holds it is signed out now and has to sign in again. The user’s other sessions and the account are left as they are.`,
  disable_oauth_provider: (id) =>
    `Switch off sign-in with the provider ${id}: nobody can sign in or sign up with it until an administrator switches it on again. Its credentials are kept and nothing is removed. It is refused if it would leave the environment with no way to sign in.`,
}

/**
 * What approving a proposal does, in plain words: the server's fixed sentence for the
 * operation, with the target's id in it. The id must be how a target of that kind is named
 * ({@link isProposalTargetId}: a UUID, or a provider's name from the closed list) and the
 * target of the operation's own kind; anything else is not written into the sentence.
 *
 * @param operation - The operation.
 * @param target - What it acts on.
 * @returns The sentence.
 * @throws TypeError when the target is not of the operation's kind or is not named by its id.
 *
 * @example
 * ```ts
 * proposalSummary('ban_user', { type: 'user', id: '0199c2f4-7a10-7c3e-9b1a-5d2e8f4a6c01' })
 * // 'Ban the user 0199c2f4-…: every session of theirs ends now, and they cannot sign in until …'
 * ```
 */
export function proposalSummary(operation: ProposalOperation, target: ProposalTarget): string {
  if (
    PROPOSAL_OPERATION_TARGETS[operation] !== target.type ||
    !isProposalTargetId(target.type, target.id)
  ) {
    throw new TypeError('a proposal’s target is named by its id')
  }
  return SUMMARIES[operation](target.id)
}
