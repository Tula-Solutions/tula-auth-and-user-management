import { type AdminClient, type AdminOperations, isTulaAdminError } from '@tula/admin'
import { OAUTH_PROVIDERS, type OAuthProvider } from '@tula/contract'
import { UsageError } from '../args'
import { DEPENDENTS_UNREAD, type KnownDependents } from '../diff'
import { printable } from '../doctor'
import { type Command, type CommandContext, EXIT } from '../framework'
import { resolveTarget } from '../target'
import { readDependents } from './shared'

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

/** Who or what a proposal is about, in words, and whether it is a provider that is on. */
interface About {
  /** The words shown and asked with. */
  text: string
  /** `true` only for a provider that was read as configured and switched on. */
  providerOn: boolean
}

/**
 * A provider as the environment has it now, read with the operator's own key. The name is
 * the proposal's, made printable; what is said of it is this CLI's words for two booleans.
 */
async function describeProvider(admin: AdminClient, id: string): Promise<About> {
  const { data } = await admin.call('listOAuthProviders', {})
  const found = data.data.find((one) => one.provider === id)
  const name = printable(id, 64)
  if (!found?.configured) {
    return { text: `provider ${name} (not configured now)`, providerOn: false }
  }
  return {
    text: `provider ${name} (${found.enabled ? 'on now' : 'already off'})`,
    providerOn: found.enabled === true,
  }
}

/** What is said of a count the server did not give, by why. The outcome is the same. */
const NOT_COUNTED = {
  unread: 'the count could not be read',
  none: 'this server has no count',
} as const

/**
 * The accounts that can sign in only with a provider, said for the question (ADR 0059):
 * this CLI's own words around the server's number, and nothing else of its answer.
 *
 * A count that was not had is never zero and never a number: fixed words say that it was
 * not counted and what follows if there are such accounts. A scan that stopped early found
 * a floor ("at least"); one that found none among what it read is said as that, with no
 * number and nobody locked out.
 */
function dependentsWords(known: KnownDependents): string {
  if (known === null || known === DEPENDENTS_UNREAD) {
    const why = known === null ? NOT_COUNTED.none : NOT_COUNTED.unread
    return `The accounts that can sign in only with this provider could not be counted (${why}): if there are any they are locked out while it is off.`
  }
  const { accounts, more } = known
  // The server counts again, under its lock, when it switches the provider off: what is
  // recorded is that count, and this one is what a person saw before answering.
  const when = 'Counted just now; the server counts again when it switches the provider off.'
  if (accounts === 0 && !more) {
    return `No account was found that can sign in only with this provider. ${when}`
  }
  if (accounts === 0) {
    // A floor of nothing is no number, and nobody found is nobody said to be locked out.
    return `No account that can sign in only with this provider was found among the accounts the server read, and it did not read them all: the rest were not looked at, so how many there are is not known. ${when}`
  }
  const one = accounts === 1 && !more
  const count = `${more ? 'At least ' : ''}${accounts} ${accounts === 1 ? 'account' : 'accounts'}`
  return `${count} can sign in only with this provider: ${one ? 'it is' : 'they are'} locked out while it is off. ${when}`
}

/**
 * Ask how many accounts depend on the provider a proposal would switch off, with the
 * operator's own key: one read, of a provider that is on now and that this version knows.
 *
 * It never fails the run and never stops the question: a count that could not be had is
 * said as that ({@link dependentsWords}), and nothing of a failure is kept.
 *
 * @returns The sentence for the question, or `null` when there is nothing to count.
 */
async function dependentsOf(
  admin: AdminClient,
  proposal: Proposal,
  about: About
): Promise<string | null> {
  if (proposal.operation !== 'disable_oauth_provider' || !about.providerOn) {
    return null
  }
  const provider = OAUTH_PROVIDERS.find((one) => one === proposal.target.id)
  if (provider === undefined) {
    return dependentsWords(DEPENDENTS_UNREAD)
  }
  let known: KnownDependents
  try {
    const read = (await readDependents(admin, [provider as OAuthProvider]))[provider]
    // `null` is an answer (a server from before the count); only "left out" is unread.
    known = read === undefined ? DEPENDENTS_UNREAD : read
  } catch {
    // Not an answer of the API's at all: a count that exists and was not read.
    known = DEPENDENTS_UNREAD
  }
  return dependentsWords(known)
}

/** A user's address and name as this command shows them: the server's text, made printable. */
function userLabel(user: {
  email?: string | null
  firstName?: string | null
  lastName?: string | null
}): string {
  const email = printable(user.email ?? '', 320)
  const name = printable([user.firstName, user.lastName].filter(Boolean).join(' '), 200)
  return [email || 'no email address', name].filter(Boolean).join(', ')
}

/**
 * A session as the environment has it now, read with the operator's own key: whose it is,
 * what kind of client, when it began and whether it is still live.
 *
 * "Live" is the server's `active`: live by what is stored (not ended, inside the stored
 * limits). The session's profile as configured now is not asked, so a profile tightened
 * since may end a session shown as live at its next request.
 *
 * An agent's account of a session ("my stale session") is a claim; the id alone gives a
 * person nothing to check it against. Two reads and nothing else: neither touches the
 * proposal or the session. What could not be read is said in fixed words beside the bare
 * id, never guessed, and nothing of a failure's own text is shown. Of the device only its
 * kind is printed: a user agent is text the session's holder chose.
 */
async function describeSessionText(admin: AdminClient, sessionId: string): Promise<string> {
  const id = printable(sessionId, 64)
  let session: Awaited<ReturnType<typeof readSession>>
  try {
    session = await readSession(admin, sessionId)
  } catch (error) {
    if (isTulaAdminError(error) && error.code === 'resource.not_found') {
      return `session ${id} (no such session now)`
    }
    return `session ${id} (could not be read)`
  }
  let whose: string
  try {
    const { data } = await admin.call('getUser', { params: { userId: session.userId } })
    whose = userLabel(data)
  } catch (error) {
    whose =
      isTulaAdminError(error) && error.code === 'resource.not_found'
        ? 'no such user now'
        : 'the user could not be read'
  }
  const owner = printable(session.userId, 64)
  const client = printable(session.client, 40)
  const since = printable(session.createdAt, 40)
  const state = session.active === true ? 'live now' : 'already ended'
  return `session ${id} (of user ${owner}: ${whose}; ${client} client, signed in ${since}; ${state})`
}

async function readSession(admin: AdminClient, sessionId: string) {
  const { data } = await admin.call('getSession', { params: { sessionId } })
  return data
}

/** Who or what the proposal is about, read with the operator's own key, for the eye only. */
async function describeTarget(admin: AdminClient, proposal: Proposal): Promise<About> {
  const id = printable(proposal.target.id, 64)
  if (proposal.target.type === 'oauth_provider') {
    return describeProvider(admin, proposal.target.id)
  }
  const said = (text: string): About => ({ text, providerOn: false })
  if (proposal.target.type === 'session') {
    return said(await describeSessionText(admin, proposal.target.id))
  }
  if (proposal.target.type !== 'user') {
    // A kind of target this version does not know: named by its id and nothing more.
    return said(`${targetWord(proposal)} ${id}`)
  }
  try {
    const { data } = await admin.call('getUser', { params: { userId: proposal.target.id } })
    return said(`user ${id} (${userLabel(data)}${data.bannedAt ? '; already banned' : ''})`)
  } catch (error) {
    if (isTulaAdminError(error) && error.code === 'resource.not_found') {
      return said(`user ${id} (no such user now)`)
    }
    throw error
  }
}

/**
 * What a target already was when an approved operation found nothing to change
 * (`changed: false` in the approval's answer): the words after "carried out".
 *
 * No row for `ban_user`: the server never answers `changed: false` for a ban, which always
 * writes its entry and ends the sessions made since.
 */
const ALREADY_SO: Record<string, string> = {
  unban_user: 'the user was not banned',
  end_session: 'the session had already ended',
  disable_oauth_provider: 'the provider was already off',
}

/**
 * The proposal as a person reads it before the question. `line` is standard output, or
 * standard error under `--json` (standard output is then the JSON alone): the question is
 * never asked about a proposal that was not shown.
 */
function render(line: (text: string) => void, proposal: Proposal, about: string, now: Date): void {
  const status = String(proposal.status)
  line(`Proposal ${printable(proposal.id, 64)}`)
  line(`  Asked for by   an agent (agent key ${printable(proposal.proposedBy.id, 64)})`)
  line(`  Operation      ${printable(proposal.operation, 40)}`)
  line(`  About          ${about}`)
  line(`  What it does   ${printable(proposal.summary, 400)}`)
  line(`  Status         ${statusWords(proposal)}`)
  if (status === 'pending') {
    line(
      `  Expires        ${timeLeft(proposal.expiresAt, now)} (${printable(proposal.expiresAt, 40)})`
    )
  }
}

/**
 * Why a run away from a terminal is refused: one fixed sentence, whatever the options.
 * It repeats nothing it was given.
 */
const NOT_A_TERMINAL =
  'tula approve asks its question at a terminal and takes the answer typed there: standard ' +
  'input and standard error are not both a terminal, so there is nobody to ask. There is no ' +
  'option that answers for you. Nothing was read or changed.'

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
    // Only the approval's answer has it: whether the operation changed its target.
    ...(typeof proposal.changed === 'boolean' ? { changed: proposal.changed } : {}),
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
  // An approval is a person's act (ADR 0053, "An approval cannot be scripted"): whoever can
  // run this command without a terminal, an agent with a shell among them, must not be able
  // to approve by running it. So the refusal comes before the key is resolved and before
  // any request, and no option stands in for the typed answer. `io.isTTY` is the injected
  // "standard input and standard error are both a terminal" (`process-io.ts`).
  if (flags['secret-key-file'] === '-') {
    throw new UsageError(
      '--secret-key-file - takes the key from standard input, which is where the question of ' +
        'tula approve is answered: put the key in a file or in the environment. Nothing was ' +
        'read or changed.'
    )
  }
  const ask = io.isTTY === true ? io.prompt : undefined
  if (ask === undefined) {
    throw new UsageError(NOT_A_TERMINAL)
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
  const described = await describeTarget(target.admin, proposal)
  const about = described.text
  render(say, proposal, about, now)
  say('')
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

  // Who is locked out by a provider that goes off, when the server could be asked: read
  // only for a proposal that can still be approved, and said with the consequence.
  const dependents = await dependentsOf(target.admin, proposal, described)
  const asked = dependents === null ? consequence : `${consequence} ${dependents}`

  // Always asked: nothing in this command skips it. The question names the operation and
  // the target it would be carried out on, both made printable, and the word is typed out.
  const answer = await ask(
    `${asked} Approve ${printable(proposal.operation, 40)} for ${about} at ${target.apiUrl}? Type yes to continue: `
  )
  if (answer.trim().toLowerCase() !== 'yes') {
    output.error('Cancelled. Nothing was changed.')
    return EXIT.error
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
    if (decided.changed === false) {
      // The operation's own write did nothing: the target was already so when it got there
      // (it changed after it was shown, or was shown so). The consequence sentence would
      // describe a change nobody made.
      const already = Object.hasOwn(ALREADY_SO, decided.operation)
        ? ALREADY_SO[decided.operation]
        : 'it was already so'
      say(`Approved and carried out; ${already}, so nothing changed. The proposal is spent.`)
      return EXIT.ok
    }
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
 * An agent holds an agent key, which reads and proposes and, a sign-in test's throwaway user
 * aside (ADR 0058), can change nothing. Its proposal
 * waits, for minutes, until a person approves it with a credential the agent never has: the
 * environment's secret key, which this command reads from where every command reads it (the
 * environment or `--secret-key-file`, never an argument). The command shows what the
 * proposal would do and to whom, asks, and approves exactly what it showed: the approval
 * repeats the operation and the target, and the server refuses it for anything else.
 *
 * It runs at a terminal or not at all: where standard input and standard error are not both
 * a terminal it refuses before any request, and it has no option that answers the question
 * (no `--yes`), so a program that can run commands cannot approve by running this one. A
 * key on standard input (`--secret-key-file -`) is refused for the same reason: the answer
 * is typed there.
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
    'tula approve <proposal id> [--env <name>] [--api-url <url>] [--secret-key-file <path>] [--json]',
  description:
    'Shows a proposal an agent made through `tula mcp` (what it would do, to whom, and when it ' +
    'expires), asks, then approves it on a typed yes: the operation is carried out at once, ' +
    'and recorded with the agent as its actor and you as the one who approved. A proposal is ' +
    'approved once, and only before it expires.\n\n' +
    'It needs a terminal: the question is asked there and the answer typed, and no option ' +
    'answers it (there is no --yes). Away from a terminal, in a script or in CI, it refuses ' +
    'before it reads or changes anything.\n\n' +
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
        'Read the secret key from a file (never - for standard input: the answer is typed there). Default: TULA_SECRET_KEY_<NAME>, then TULA_SECRET_KEY.',
    },
    json: {
      type: 'boolean',
      description:
        'Print the proposal as it stands after the run as JSON. The question is still asked, and the proposal shown first, on standard error.',
    },
  },
  run,
}
