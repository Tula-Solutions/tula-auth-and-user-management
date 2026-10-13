import { toApiError } from '~/api/errors'
import type { Proposal } from '~/api/generated/api.gen'
import { printable } from '~/lib/printable'

// What the proposals screen says: the dashboard's own words for an operation, a status, a
// refusal and an outcome, by the server's fixed words (ADR 0053). They are the sentences
// `tula approve` says (`packages/cli/src/commands/approve.ts`), so that a person who approves
// here is told what one who approves there is told. Nothing in a sentence of this file came
// over the network but an id, which goes through `printable()`.

/**
 * What approving each operation does, said to the person who is about to: this dashboard's
 * own words. The server's `summary` is shown beside it; the question is asked with this, so
 * that it never rests on text that arrived over the network. **An operation with no row here
 * cannot be approved on the screen** ({@link consequenceOf}): a version that cannot describe
 * a change does not make it.
 */
const CONSEQUENCES: Readonly<Record<string, string>> = {
  ban_user: 'The user is banned at once: every session of theirs ends and they cannot sign in.',
  unban_user:
    'The user’s ban is lifted at once: they can sign in again. Sessions that were ended stay ended.',
  end_session:
    'That one session is ended at once: whoever holds it is signed out and has to sign in again.',
  disable_oauth_provider:
    'Sign-in with that provider is switched off at once: nobody signs in or signs up with it until it is switched on again. Its credentials are kept.',
}

/**
 * What approving an operation does, in this dashboard's words.
 *
 * @param operation - The proposal's operation, as the server sent it.
 * @returns The sentence, or `null` for an operation this version does not know: such a
 *   proposal is shown and cannot be approved here.
 */
export function consequenceOf(operation: string): string | null {
  return Object.hasOwn(CONSEQUENCES, operation) ? (CONSEQUENCES[operation] as string) : null
}

/** What is said of a proposal whose operation this version has no words for. */
export const UNKNOWN_OPERATION =
  'This version of the dashboard does not know this operation, and does not approve what it cannot describe. Nothing was changed.'

const TARGET_WORDS: Readonly<Record<string, string>> = {
  user: 'user',
  session: 'session',
  oauth_provider: 'provider',
}

/**
 * What a kind of target is called here.
 *
 * @param type - The target's type, as the server sent it.
 * @returns The word; a kind this version does not know, as sent and made printable.
 */
export function targetWord(type: string): string {
  return Object.hasOwn(TARGET_WORDS, type) ? (TARGET_WORDS[type] as string) : printable(type)
}

const SPENT = 'The proposal is spent: it cannot be approved again.'

const REFUSALS: Readonly<Record<string, string>> = {
  expired: 'The proposal has expired. Nothing was changed. The agent can ask again.',
  already_decided:
    'The proposal was already approved, here or somewhere else: a proposal is approved once. This click changed nothing. How it ended is in the list.',
  mismatch:
    'The proposal is not the one that was shown: its operation or its target differs. Nothing was changed.',
  agent_key_revoked:
    'The agent key that asked for this was revoked: what a revoked key asked for is never carried out. Nothing was changed.',
  production_environment:
    'This is a production environment, and its settings do not (or no longer) accept proposals from an agent. Nothing was changed, and the proposal is not spent: it can still be approved before it expires if the setting is switched on (Settings, “AI agents”).',
}

/**
 * Why the server refused an approval, when it refused it for the proposal itself
 * (`resource.conflict` with one of the contract's `PROPOSAL_APPROVAL_REFUSALS`).
 *
 * @param error - What the approval threw.
 * @returns The fixed sentence for the reason; `null` for any other failure (the network, a
 *   limit, a reason this version does not know), which is said as every failure is.
 */
export function refusalText(error: unknown): string | null {
  const failure = toApiError(error)
  if (failure.code !== 'resource.conflict') {
    return null
  }
  const reason = typeof failure.params.reason === 'string' ? failure.params.reason : ''
  return Object.hasOwn(REFUSALS, reason) ? (REFUSALS[reason] as string) : null
}

/**
 * What is added to a failure that is not a refusal of the proposal: a request that got no
 * answer, or an answer that was an error, may still have been taken by the server.
 */
export const MAY_HAVE_BEEN_TAKEN =
  'If the request reached the server the proposal may have been approved all the same: the list was read again, check how it stands before trying once more.'

/** How a proposal stands, for a badge and a sentence. */
export interface ProposalState {
  /** A closed word for tests and styling; `unknown` for a status of a later server. */
  kind: 'pending' | 'expired' | 'approved' | 'executed' | 'failed' | 'unknown'
  /** The badge: two or three words. */
  label: string
  /** What it means, and whether it can still be approved. */
  detail: string
}

const EXPIRY_DETAILS: Readonly<Record<string, string>> = {
  time: 'It was not approved in time, and nothing was changed. It cannot be approved any more; the agent can ask again.',
  agent_key_revoked:
    'The agent key that asked for it was revoked, and nothing was changed. What a revoked key asked for is never carried out: it cannot be approved.',
}

/**
 * Why an approved proposal did not end as carried out, by the server's fixed word.
 * `incomplete` is the one that must never read as "nothing happened".
 *
 * @param proposal - The proposal, `failed`.
 * @returns What happened, and what is left for a person to do.
 */
export function failureText(proposal: Proposal): string {
  const reason = proposal.failureReason === null ? '' : String(proposal.failureReason)
  if (reason === 'incomplete' && proposal.operation === 'ban_user') {
    return (
      'Approved, and only partly carried out. The user is banned, and ending their sessions failed: ' +
      'a session of theirs may still be live until its access token runs out, and is refused at its next refresh. ' +
      `End them now, on the user’s page (“End all sessions”) or with DELETE /v1/admin/users/${printable(proposal.target.id)}/sessions. ${SPENT}`
    )
  }
  if (reason === 'incomplete') {
    return `Approved, and only partly carried out: the change was made and a later step failed. Check the ${targetWord(proposal.target.type)} as it is now. ${SPENT}`
  }
  const what = targetWord(proposal.target.type)
  if (reason === 'target_not_found') {
    return `Approved, but nothing was changed: the ${what} no longer exists. ${SPENT}`
  }
  if (reason === 'last_sign_in_method') {
    return `Approved, but nothing was changed: switching this provider off would leave the environment with no way to sign in, which the server refuses for an administrator too. The provider is still on. ${SPENT}`
  }
  return (
    `Approved, but the operation failed on the server (${reason === '' ? 'unknown' : printable(reason)}). ` +
    `Check the ${what} as it is now, and have the agent ask again if the change is still wanted. ${SPENT}`
  )
}

/**
 * A proposal's status, said so that it cannot be taken for "done" when it is not, and so
 * that one which can no longer be approved says so.
 *
 * @param proposal - The proposal as the API lists it.
 * @returns The badge and the sentence.
 */
export function proposalState(proposal: Proposal): ProposalState {
  const status = String(proposal.status)
  if (status === 'pending') {
    return {
      kind: 'pending',
      label: 'Waiting for approval',
      detail: 'Nothing has happened. It can be approved once, until it expires.',
    }
  }
  if (status === 'expired') {
    const reason = proposal.expiryReason === null ? 'time' : String(proposal.expiryReason)
    return {
      kind: 'expired',
      label: reason === 'agent_key_revoked' ? 'Expired: agent key revoked' : 'Expired',
      detail: Object.hasOwn(EXPIRY_DETAILS, reason)
        ? (EXPIRY_DETAILS[reason] as string)
        : 'Nothing was changed, and it cannot be approved any more.',
    }
  }
  if (status === 'executed') {
    return {
      kind: 'executed',
      label: 'Approved and carried out',
      detail: SPENT,
    }
  }
  if (status === 'failed') {
    return {
      kind: 'failed',
      label:
        proposal.failureReason === 'incomplete'
          ? 'Approved, only partly carried out'
          : 'Approved, not carried out',
      detail: failureText(proposal),
    }
  }
  if (status === 'approved') {
    return {
      kind: 'approved',
      label: 'Approved, outcome not recorded',
      detail: `It was approved and its operation was started, and the server could not record how the operation ended. Check the ${targetWord(proposal.target.type)} as it is now. ${SPENT}`,
    }
  }
  return {
    kind: 'unknown',
    label: printable(status),
    detail:
      'This version of the dashboard does not know this status. It is not waiting for approval here.',
  }
}

const ALREADY_SO: Readonly<Record<string, string>> = {
  ban_user: 'the user was already banned',
  unban_user: 'the user was not banned',
  end_session: 'the session had already ended',
  disable_oauth_provider: 'the provider was already off',
}

/** What an approval came to, for the dialog that made it. */
export interface ApprovalOutcome {
  /** `done`: carried out. `nothing`: carried out, nothing changed. `problem`: anything else. */
  kind: 'done' | 'nothing' | 'problem'
  /** The heading: never "done" for a run that was not. */
  title: string
  /** The sentence. */
  text: string
}

/**
 * What the answer to an approval says happened. A run that failed, in whole or in part, is
 * never reported as carried out, and one that changed nothing is not said to have changed
 * something.
 *
 * @param decided - The proposal as the approval answered it.
 * @returns The heading and the sentence.
 */
export function approvalOutcome(decided: Proposal): ApprovalOutcome {
  const status = String(decided.status)
  if (status === 'executed') {
    if (decided.changed === false) {
      const already = Object.hasOwn(ALREADY_SO, decided.operation)
        ? (ALREADY_SO[decided.operation] as string)
        : 'it was already so'
      return {
        kind: 'nothing',
        title: 'Approved; nothing changed',
        text: `Approved and carried out; ${already}, so nothing changed. ${SPENT}`,
      }
    }
    return {
      kind: 'done',
      title: 'Approved and carried out',
      text: `${consequenceOf(decided.operation) ?? 'The operation was carried out.'} ${SPENT}`,
    }
  }
  if (status === 'failed') {
    return {
      kind: 'problem',
      title:
        decided.failureReason === 'incomplete'
          ? 'Approved, and only partly carried out'
          : 'Approved, and not carried out',
      text: failureText(decided),
    }
  }
  return {
    kind: 'problem',
    title: 'Approved; how it ended is not known',
    text: `Approved, and the server could not record how the operation ended. Check the ${targetWord(decided.target.type)} as it is now. ${SPENT}`,
  }
}

/**
 * How long a pending proposal can still be approved, by this browser's clock. The server
 * decides whether it has expired; this is only what a person reads while they wait.
 *
 * @param expiresAt - The proposal's `expiresAt`.
 * @param now - This browser's time, in milliseconds.
 * @returns Minutes and seconds left, or that the time is up by this clock.
 */
export function timeLeft(expiresAt: string, now: number): { up: boolean; text: string } {
  const ms = Date.parse(expiresAt) - now
  if (!Number.isFinite(ms) || ms <= 0) {
    return { up: true, text: 'The time is up by this browser’s clock' }
  }
  // Rounded down: never more time than there is.
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return {
    up: false,
    text: minutes > 0 ? `${minutes} min ${rest} s left` : `${rest} s left`,
  }
}

/**
 * How a proposal's operation and target are said in a control's name, a dialog's title and
 * the text to type: what is shown, made printable.
 *
 * @param proposal - The proposal.
 * @returns The operation, the kind of target and the target's id.
 */
export function naming(proposal: Proposal): { operation: string; what: string; id: string } {
  return {
    operation: printable(proposal.operation),
    what: targetWord(proposal.target.type),
    id: printable(proposal.target.id),
  }
}
