import { type AdminClient, type AdminOperations, isTulaAdminError } from '@tula/admin'
import { UsageError } from '../args'
import { printable } from '../doctor'
import { type Command, type CommandContext, EXIT } from '../framework'
import type { Output } from '../output'
import { resolveTarget } from '../target'

type Proposal = AdminOperations['getProposal']['response']

/** A proposal's id is a UUID. Anything else is refused before any request, and not repeated. */
const PROPOSAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * What approving each operation does, said to the person who is about to: this CLI's own
 * words. The server's `summary` is printed beside it; this is what the question is asked
 * with, so that it never rests on text that arrived over the network.
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

/** What each kind of target is called, in this CLI's own words. */
const TARGET_WORDS: Readonly<Record<string, string>> = {
  user: 'user',
  session: 'session',
  oauth_provider: 'provider',
}

/** What a target of a proposal is called here; a kind this version does not know, as sent. */
function targetWord(proposal: Proposal): string {
  const type = String(proposal.target.type)
  return Object.hasOwn(TARGET_WORDS, type) ? (TARGET_WORDS[type] as string) : printable(type, 40)
}

/** Why an approval was refused, by the server's fixed word. */
const REFUSALS: Readonly<Record<string, string>> = {
  expired: 'The proposal has expired. Nothing was changed. The agent can ask again.',
  already_decided:
    'The proposal was already approved: a proposal is approved once. Nothing was changed by this run.',
  mismatch:
    'The proposal is not the one that was shown: its operation or its target differs. Nothing was changed.',
  agent_key_revoked:
    'The agent key that asked for this was revoked: what a revoked key asked for is never carried out. Nothing was changed.',
  production_environment:
    'This is a production environment, and its settings do not (or no longer) accept proposals from an agent (agents.proposalsInProduction). Nothing was changed, and the proposal is not spent: it can still be approved before it expires if the setting is switched on.',
}

/** Why a proposal is expired, by the server's fixed word. */
const EXPIRY_WORDS: Readonly<Record<string, string>> = {
  time: 'expired (it was not approved in time)',
  agent_key_revoked: 'expired (the agent key that asked for it was revoked)',
}

/**
 * How an approved proposal ended when it was not carried out, by the server's fixed word.
 * `incomplete` is the one that must never read as "nothing happened".
 */
function failureWords(proposal: Proposal): string {
  const spent = 'The proposal is spent: it cannot be approved again.'
  const reason = proposal.failureReason === null ? '' : String(proposal.failureReason)
  if (reason === 'incomplete' && proposal.operation === 'ban_user') {
    const id = printable(proposal.target.id, 64)
    return (
      'Approved, and only partly carried out. The user is banned, and ending their sessions failed: ' +
      'a session of theirs may still be live until its access token runs out, and is refused at its next refresh. ' +
      `End them now: DELETE /v1/admin/users/${id}/sessions with your secret key, or the user’s page in the dashboard. ${spent}`
    )
  }
  if (reason === 'incomplete') {
    return `Approved, and only partly carried out: the change was made and a later step failed. Check the target. ${spent}`
  }
  const what = targetWord(proposal)
  if (reason === 'target_not_found') {
    return `Approved, but nothing was changed: the ${what} no longer exists. ${spent}`
  }
  if (reason === 'last_sign_in_method') {
    return (
      'Approved, but nothing was changed: switching this provider off would leave the environment ' +
      `with no way to sign in, which the server refuses for an administrator too. The provider is still on. ${spent}`
    )
  }
  return (
    `Approved, but the operation failed on the server (${reason === '' ? 'unknown' : printable(reason, 40)}). ` +
    `Check the ${what} as it is now, and have the agent ask again if the change is still wanted. ${spent}`
  )
}

/** A status, said so that it cannot be taken for "done" when it is not. */
const STATUS_WORDS: Readonly<Record<string, string>> = {
  pending: 'waiting for approval',
  expired: 'expired',
  approved: 'approved, its operation not finished',
  executed: 'approved and carried out',
  failed: 'approved, and its operation did not end as carried out',
}

/** A proposal's status in words, with why it expired when it has. */
function statusWords(proposal: Proposal): string {
  const status = String(proposal.status)
  if (status === 'expired') {
    const reason = proposal.expiryReason === null ? 'time' : String(proposal.expiryReason)
    return Object.hasOwn(EXPIRY_WORDS, reason) ? (EXPIRY_WORDS[reason] as string) : 'expired'
  }
  if (status === 'failed' && proposal.failureReason === 'incomplete') {
    return 'approved, and only partly carried out'
  }
  return Object.hasOwn(STATUS_WORDS, status)
    ? (STATUS_WORDS[status] as string)
    : printable(status, 40)
}

/** Whole minutes and seconds until `expiresAt`, by this machine's clock. */
function timeLeft(expiresAt: string, now: Date): string {
  const ms = Date.parse(expiresAt) - now.getTime()
  if (!Number.isFinite(ms) || ms <= 0) {
    return 'now'
  }
  const seconds = Math.ceil(ms / 1000)
  return seconds >= 60 ? `in about ${Math.round(seconds / 60)} min` : `in ${seconds} s`
}

/**
 * A provider as the environment has it now, read with the operator's own key. The name is
 * the proposal's, made printable; what is said of it is this CLI's words for two booleans.
 */
async function describeProvider(admin: AdminClient, id: string): Promise<string> {
  const { data } = await admin.call('listOAuthProviders', {})
  const found = data.data.find((one) => one.provider === id)
  const name = printable(id, 64)
  if (!found?.configured) {
    return `provider ${name} (not configured now)`
  }
  return `provider ${name} (${found.enabled ? 'on now' : 'already off'})`
}

/** Who or what the proposal is about, read with the operator's own key, for the eye only. */
async function describeTarget(admin: AdminClient, proposal: Proposal): Promise<string> {
  const id = printable(proposal.target.id, 64)
  if (proposal.target.type === 'oauth_provider') {
    return describeProvider(admin, proposal.target.id)
  }
  if (proposal.target.type !== 'user') {
    // A session is named by its id: the admin API reads a session under its user, and a
    // proposal names the session alone.
    return `${targetWord(proposal)} ${id}`
  }
  try {
    const { data } = await admin.call('getUser', { params: { userId: proposal.target.id } })
    const email = printable(data.email ?? '', 320)
    const name = printable([data.firstName, data.lastName].filter(Boolean).join(' '), 200)
    const label = [email || 'no email address', name].filter(Boolean).join(', ')
    return `user ${id} (${label}${data.bannedAt ? '; already banned' : ''})`
  } catch (error) {
    if (isTulaAdminError(error) && error.code === 'resource.not_found') {
      return `user ${id} (no such user now)`
    }
    throw error
  }
}

function render(output: Output, proposal: Proposal, about: string, now: Date): void {
  const status = String(proposal.status)
  output.line(`Proposal ${printable(proposal.id, 64)}`)
  output.line(`  Asked for by   an agent (agent key ${printable(proposal.proposedBy.id, 64)})`)
  output.line(`  Operation      ${printable(proposal.operation, 40)}`)
  output.line(`  About          ${about}`)
  output.line(`  What it does   ${printable(proposal.summary, 400)}`)
  output.line(`  Status         ${statusWords(proposal)}`)
  if (status === 'pending') {
    output.line(
      `  Expires        ${timeLeft(proposal.expiresAt, now)} (${printable(proposal.expiresAt, 40)})`
    )
  }
}

/** The proposal as `--json` prints it: named field by field, server text made printable. */
function toJson(proposal: Proposal): Record<string, unknown> {
  return {
    id: printable(proposal.id, 64),
    operation: printable(proposal.operation, 40),
    target: {
      type: printable(proposal.target.type, 40),
      id: printable(proposal.target.id, 64),
    },
    summary: printable(proposal.summary, 400),
    status: printable(proposal.status, 40),
    proposedBy: { type: 'agent', id: printable(proposal.proposedBy.id, 64) },
    createdAt: printable(proposal.createdAt, 40),
    expiresAt: printable(proposal.expiresAt, 40),
    approvedBy: proposal.approvedBy
      ? {
          type: printable(proposal.approvedBy.type, 40),
          id: proposal.approvedBy.id === null ? null : printable(proposal.approvedBy.id, 64),
        }
      : null,
    approvedAt: proposal.approvedAt === null ? null : printable(proposal.approvedAt, 40),
    failureReason: proposal.failureReason === null ? null : printable(proposal.failureReason, 40),
    expiryReason: proposal.expiryReason === null ? null : printable(proposal.expiryReason, 40),
  }
}

async function run(context: CommandContext): Promise<number> {
  const { flags, io, output, positionals } = context
  const id = positionals[0]
  if (id === undefined) {
    throw new UsageError('Which proposal? Usage: tula approve <proposal id>')
  }
  if (!PROPOSAL_ID.test(id)) {
    throw new UsageError(
      'That is not a proposal id (a UUID, as the agent reported it). Nothing was read or changed.'
    )
  }
  if (flags['secret-key-file'] === '-' && flags.yes !== true) {
    throw new UsageError(
      '--secret-key-file - takes standard input for the key, which leaves nothing to answer the ' +
        'confirmation: pass --yes as well. Nothing was read or changed.'
    )
  }
  const name = typeof flags.env === 'string' ? flags.env : 'default'
  const target = await resolveTarget({ name, environment: {}, flags, io, output }).catch(
    (error: unknown) => {
      if (isTulaAdminError(error) && error.code === 'client.agent_key') {
        throw new UsageError(
          'That is an agent key (tula_ak_…). A proposal is approved by a person, with a secret ' +
            'key (tula_sk_…): an agent key cannot approve. Nothing was read or changed.'
        )
      }
      throw error
    }
  )
  const now = io.now?.() ?? new Date()
  const json = flags.json === true
  const say = json ? (text: string) => output.error(text) : (text: string) => output.line(text)

  const { data: proposal } = await target.admin.call('getProposal', { params: { id } })
  const about = await describeTarget(target.admin, proposal)
  if (!json) {
    render(output, proposal, about, now)
    output.line()
  }
  const consequence = Object.hasOwn(CONSEQUENCES, proposal.operation)
    ? CONSEQUENCES[proposal.operation]
    : undefined
  if (consequence === undefined) {
    output.error(
      `${output.errorStyle.red('error:')} This version of tula does not know the operation of ` +
        'this proposal, and does not approve what it cannot describe. Nothing was changed.'
    )
    return EXIT.error
  }
  if (proposal.status !== 'pending') {
    if (json) {
      output.line(JSON.stringify(toJson(proposal), null, 2))
    }
    output.error(
      `${output.errorStyle.red('error:')} This proposal is ${statusWords(proposal)}: there is nothing to approve. Nothing was changed by this run.`
    )
    return EXIT.error
  }

  if (flags.yes !== true) {
    if (!io.isTTY || !io.prompt) {
      throw new UsageError(
        'Not at a terminal, so there is nobody to confirm: pass --yes to approve without asking. Nothing was changed.'
      )
    }
    const answer = await io.prompt(
      `${consequence} Approve this for ${about} at ${target.apiUrl}? Type yes to continue: `
    )
    if (answer.trim().toLowerCase() !== 'yes') {
      output.error('Cancelled. Nothing was changed.')
      return EXIT.error
    }
  }

  let decided: Proposal
  try {
    // The approval names what was shown: the server refuses it (`mismatch`) for a proposal
    // that is anything else, so what a person agreed to is what is carried out.
    const answer = await target.admin.call('approveProposal', {
      params: { id },
      body: { operation: proposal.operation, target: proposal.target },
    })
    decided = answer.data
  } catch (error) {
    if (isTulaAdminError(error) && error.code === 'resource.conflict') {
      const reason = typeof error.params.reason === 'string' ? error.params.reason : ''
      const why = Object.hasOwn(REFUSALS, reason) ? REFUSALS[reason] : undefined
      if (why !== undefined) {
        output.error(`${output.errorStyle.red('error:')} ${why}`)
        return EXIT.error
      }
    }
    throw error
  }
  if (json) {
    output.line(JSON.stringify(toJson(decided), null, 2))
  }
  if (decided.status === 'executed') {
    say(`Approved and carried out. ${consequence}`)
    return EXIT.ok
  }
  if (decided.status !== 'failed') {
    // `approved`: the server could not record how the operation ended.
    output.error(
      `${output.errorStyle.red('error:')} Approved, and the server could not record how the operation ended. Check the ${targetWord(decided)} as it is now. The proposal is spent: it cannot be approved again.`
    )
    return EXIT.error
  }
  output.error(`${output.errorStyle.red('error:')} ${failureWords(decided)}`)
  return EXIT.error
}

/**
 * `tula approve <proposal id>`: a person's answer to a change an AI agent asked for
 * ([ADR 0053](../../../../docs/adr/0053-proposals.md)).
 *
 * An agent holds an agent key, which reads and proposes and can change nothing. Its proposal
 * waits, for minutes, until a person approves it with a credential the agent never has: the
 * environment's secret key, which this command reads from where every command reads it (the
 * environment or `--secret-key-file`, never an argument). The command shows what the
 * proposal would do and to whom, asks, and approves exactly what it showed: the approval
 * repeats the operation and the target, and the server refuses it for anything else.
 *
 * @example
 * ```sh
 * TULA_API_URL=https://auth.example.com TULA_SECRET_KEY=… tula approve 0199c2f4-7a10-7c3e-9b1a-5d2e8f4a6c01
 * ```
 */
export const approveCommand: Command = {
  name: 'approve',
  summary: 'Approve a change an AI agent proposed, after showing what it does.',
  usage:
    'tula approve <proposal id> [--env <name>] [--api-url <url>] [--secret-key-file <path>] [--yes] [--json]',
  description:
    'Shows a proposal an agent made through `tula mcp` (what it would do, to whom, and when it ' +
    'expires), asks for confirmation, then approves it: the operation is carried out at once, ' +
    'and recorded with the agent as its actor and you as the one who approved. A proposal is ' +
    'approved once, and only before it expires.\n\n' +
    'The secret key decides the environment and is what makes the approval yours: ' +
    '--secret-key-file, TULA_SECRET_KEY_<NAME> or TULA_SECRET_KEY, never the command line. An ' +
    'agent key cannot approve. Keep the secret key out of the environment the agent runs in.\n\n' +
    'Exit codes: 0 approved and carried out, 1 anything else (declined, expired, already ' +
    'approved, not carried out, an error).\n\n' +
    'What an agent can propose: banning a user, lifting a ban, ending one session, switching ' +
    'one OAuth provider off. A production environment accepts proposals only where its ' +
    'settings say so (agents.proposalsInProduction, off by default).',
  maxPositionals: 1,
  options: {
    env: {
      type: 'string',
      short: 'e',
      value: '<name>',
      description: 'Read TULA_SECRET_KEY_<NAME> and TULA_API_URL_<NAME> first.',
    },
    'api-url': {
      type: 'string',
      value: '<url>',
      description: 'The Tula API. Default: TULA_API_URL_<NAME>, then TULA_API_URL.',
    },
    'insecure-http': {
      type: 'boolean',
      description:
        'Allow a plain http API URL that is not localhost: the secret key then crosses the network in clear text.',
    },
    'secret-key-file': {
      type: 'string',
      value: '<path>',
      description:
        'Read the secret key from a file (- for standard input, piped; then --yes is needed). Default: TULA_SECRET_KEY_<NAME>, then TULA_SECRET_KEY.',
    },
    yes: {
      type: 'boolean',
      short: 'y',
      description: 'Approve without asking. The proposal is still printed first.',
    },
    json: {
      type: 'boolean',
      description: 'Print the proposal as it stands after the run as JSON.',
    },
  },
  run,
}
