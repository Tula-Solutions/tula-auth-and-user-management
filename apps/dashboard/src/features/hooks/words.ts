import { type HookFailureMode, type HookStrength, hookWeakenings } from '@tula/contract'
import { messageFor, toApiError } from '~/api/errors'
import type { Hook } from '~/api/generated/api.gen'

// Every sentence the hooks screen says about a point, a state, a failure or a refusal. The
// server answers with fixed words (`before_token`, `allow`, `timeout`); what an operator
// reads is the dashboard's own text for each. A word this version does not know is shown as
// the text it is, never as markup and never as the only thing said.

// The key of every lookup below is text from the server. A plain object also answers for
// `constructor`, `toString` and `__proto__`, with a function or its prototype: only what the
// table itself holds is a word of the dashboard's.
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined
}

/** What the screen says about one point at which a hook is asked. */
export interface PointWords {
  /** The point's name as a heading. */
  label: string
  /** When the question is asked and what its answer can do. */
  asked: string
  /** What `failureMode: 'allow'` lets through at this point. */
  allowing: string
  /** What is lost when the hook is switched off or removed. */
  gone: string
}

const POINTS: Record<string, PointWords> = {
  before_sign_up: {
    label: 'Before a sign-up',
    asked:
      'Asked before a sign-up creates an account, once the address has been proven. The answer allows the sign-up or denies it.',
    allowing:
      'When a call of this hook fails, the sign-up goes ahead and the account is created, as if there were no hook.',
    gone: 'It is no longer asked: every sign-up goes ahead, as if there were no hook.',
  },
  before_session: {
    label: 'Before a session',
    asked:
      'Asked before a sign-in creates a session, after every factor has been proven. The answer allows the sign-in or denies it.',
    allowing:
      'When a call of this hook fails, the sign-in goes ahead and the session is created, as if there were no hook.',
    gone: 'It is no longer asked: every sign-in goes ahead, as if there were no hook.',
  },
  before_token: {
    label: 'Before a token',
    asked:
      'Asked when a session is created and each time its user proves a factor again. The answer adds claims to the session’s tokens; it cannot deny.',
    allowing:
      'When a call of this hook fails, the session carries none of its claims. An application that reads a restriction from a claim then finds none.',
    gone: 'It is no longer asked: from now on a new session, and a session whose user proves a factor again, carries none of its claims.',
  },
}

const UNKNOWN_POINT: Omit<PointWords, 'label'> = {
  asked: 'A point this version of the dashboard does not know.',
  allowing:
    'When a call of this hook fails, what it was asked about goes ahead, as if there were no hook.',
  gone: 'It is no longer asked: what it was asked about goes ahead, as if there were no hook.',
}

/**
 * The words for a point.
 *
 * @param point - One of the contract's points; a later server may know another.
 * @returns The point's words; for a point this version does not know, general ones under
 *   the point's own name.
 */
export function pointWords(point: string): PointWords {
  return own(POINTS, point) ?? { label: point, ...UNKNOWN_POINT }
}

/**
 * A hook as {@link hookWeakenings} reads it. A failure mode this version does not know is
 * read as `deny`, so that a change to `allow` is still asked about.
 *
 * @param hook - The hook as the API lists it.
 * @returns Its switch and its failure mode.
 */
export function strengthOf(hook: Pick<Hook, 'enabled' | 'failureMode'>): HookStrength {
  const failureMode: HookFailureMode = hook.failureMode === 'allow' ? 'allow' : 'deny'
  return { enabled: hook.enabled, failureMode }
}

/**
 * What a change lets through that the hook used to stop, in sentences: one for each field
 * the contract's `hookWeakenings` names. The rule is the contract's, shared with the audit
 * log and `tula apply`; only the words are the dashboard's.
 *
 * @param point - The hook's point.
 * @param was - The hook before; `null` when it is being added.
 * @param is - The hook after; `null` when it is being removed.
 * @returns The sentences; empty when the change weakens nothing.
 */
export function weakeningSentences(
  point: string,
  was: HookStrength | null,
  is: HookStrength | null
): string[] {
  const words = pointWords(point)
  return hookWeakenings(was, is).map((field) => (field === 'enabled' ? words.gone : words.allowing))
}

/** How a hook is doing, for the `data-state` of its badge. */
export type HookStateKind = 'on' | 'on-allowing' | 'off'

/** A hook's state in words. */
export interface HookState {
  kind: HookStateKind
  /** A few words: "On", "Switched off". */
  label: string
  /** What that means. */
  detail: string
}

/**
 * Say how a hook is set: on, on but letting through when a call fails, or off.
 *
 * @param hook - The hook as the API lists it.
 * @returns The state, as a kind for styling and words for reading.
 */
export function hookState(hook: Pick<Hook, 'point' | 'enabled' | 'failureMode'>): HookState {
  const words = pointWords(hook.point)
  if (!hook.enabled) {
    return { kind: 'off', label: 'Switched off', detail: `It is not asked. ${words.gone}` }
  }
  if (hook.failureMode === 'allow') {
    return { kind: 'on-allowing', label: 'On, letting through on failure', detail: words.allowing }
  }
  return {
    kind: 'on',
    label: 'On',
    detail: 'It is asked, and a call that fails refuses what was asked about.',
  }
}

const FAILURE_MODES: Record<string, string> = {
  deny: 'Refuse what was asked about (deny)',
  allow: 'Let it through (allow)',
}

/**
 * What happens when a call fails, as the screen says it.
 *
 * @param mode - `deny` or `allow`; a later server may know another.
 * @returns The words; an unknown mode as it is.
 */
export function failureModeText(mode: string): string {
  return own(FAILURE_MODES, mode) ?? mode
}

const FAILURE_REASONS: Record<string, string> = {
  invalid_url: 'The address is not one the server can call.',
  invalid_request: 'The request could not be built.',
  scheme_not_allowed: 'The address does not use https.',
  resolve_failed: 'The host name of the address could not be resolved.',
  address_not_allowed:
    'The address led to a private or local network address, which the server does not call.',
  connection_failed: 'The connection could not be made, or broke.',
  timeout: 'There was no answer within the deadline.',
  response_too_large: 'The answer was larger than the server reads.',
  status_not_ok: 'The endpoint answered with a status that is not 2xx.',
  answer_invalid: 'The answer was not exactly the answer this point takes.',
  secret_unreadable:
    'No request was made: the server could not open the signing secret. Check that every API instance has the same TULA_MASTER_KEY, or remove this one and add it again.',
  claims_invalid:
    'The claims broke a rule: a reserved name, a malformed key, or a value that is not one string, number or boolean.',
  claims_too_large:
    'The claims were over the size limit, by themselves or together with the claims of the session’s JWT template.',
}

/**
 * Why a call failed, as a sentence.
 *
 * @param reason - One of the server's fixed words.
 * @returns The sentence; for a word this version does not know, a sentence that quotes it.
 */
export function failureReasonText(reason: string): string {
  return own(FAILURE_REASONS, reason) ?? `The server gave this reason: ${reason}`
}

/** How the last failed call ended, for the `data-outcome` of its line. */
export type FailureOutcome = 'none' | 'timed-out' | 'failed'

/**
 * Which kind of failure a hook's last failed call was. The server records a failed call and
 * nothing else: a call that was answered, with an allow or a denial, leaves no record.
 *
 * @param hook - The hook's `lastFailedAt` and `lastFailureReason`.
 * @returns `none` when no failed call is recorded; `timed-out` for no answer in time; else `failed`.
 */
export function failureOutcome(
  hook: Pick<Hook, 'lastFailedAt' | 'lastFailureReason'>
): FailureOutcome {
  if (hook.lastFailedAt === null) {
    return 'none'
  }
  return hook.lastFailureReason === 'timeout' ? 'timed-out' : 'failed'
}

const URL_REFUSALS: Record<string, string> = {
  scheme_not_allowed: 'The address must start with https://.',
  address_not_allowed:
    'The address leads to a private or local network address, which the server does not call. Use an address on the public internet.',
  resolve_failed: 'The host name of the address could not be resolved. Check the spelling.',
  invalid_url:
    'That is not an address the server can call. Enter a full https:// URL with no user name or password in it.',
  timeout: 'Looking up the host name of the address took too long. Try again.',
}

/** Which action failed, for the refusals that mean something different by action. */
export type HookAction = 'create' | 'change'

/**
 * The sentence to show when a call about a hook was refused or failed.
 *
 * `hook.url_not_allowed` carries a fixed word in `params.reason`; each has a sentence of the
 * dashboard's own. A conflict means "this point already has one" when adding and "it changed
 * since it was read" otherwise. Anything else is what every other screen says.
 *
 * @param error - What the mutation threw.
 * @param action - What was being done.
 * @returns A sentence for the operator, never a bare code.
 */
export function hookMessageFor(error: unknown, action: HookAction = 'change'): string {
  const failure = toApiError(error)
  if (failure.code === 'hook.url_not_allowed') {
    const reason = own(failure.params, 'reason')
    return (
      (typeof reason === 'string' ? own(URL_REFUSALS, reason) : undefined) ??
      'The server cannot call that address.'
    )
  }
  if (failure.code === 'resource.conflict') {
    return action === 'create'
      ? 'This point already has one: it was added elsewhere. Close this and look at the list again.'
      : 'It was changed elsewhere since this screen read it. Close this, look at it again, and repeat the change if it is still wanted.'
  }
  if (action === 'change' && failure.status === 404) {
    return 'It no longer exists: it was removed elsewhere. Close this and look at the list again.'
  }
  return messageFor(error)
}
