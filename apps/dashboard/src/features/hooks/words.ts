import {
  HOOK_OUTCOME_WINDOW_HOURS,
  type HookFailureMode,
  type HookStrength,
  hookLastCallFailed,
  hookWeakenings,
} from '@tula-tech/contract'
import { messageFor, toApiError } from '~/api/errors'
import type { Hook } from '~/api/generated/api.gen'
import { own } from '~/lib/own'

// Every sentence the hooks screen says about a point, a state, a failure or a refusal. The
// server answers with fixed words (`before_token`, `allow`, `timeout`); what an operator
// reads is the dashboard's own text for each. A word this version does not know is shown as
// the text it is, never as markup and never as the only thing said.

// The key of every lookup below is text from the server, so each goes through `own`: only
// what a table itself holds is a word of the dashboard's.

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
 * Which kind of failure a hook's last failed call was. The reason of a failed call is kept
 * for the last one only; what every call came to is counted (`outcomeCounts`).
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

/** One of the four counts the server keeps of a hook's calls, as the screen lists it. */
export interface OutcomeCount {
  /** The count's key in the API's answer, for a test id. */
  key: 'allowed' | 'denied' | 'failed' | 'timedOut'
  /** What the calls came to, as a few words. */
  label: string
  /** How many calls, as the server answered it. */
  count: number
}

/**
 * The four counts of a hook's recent calls, in a fixed order and with the server's numbers:
 * no sum, no share and no rate of the screen's own.
 *
 * @param recent - The hook's `recentOutcomes`.
 * @returns Allowed, denied, failed, timed out.
 */
export function outcomeCounts(recent: Hook['recentOutcomes']): OutcomeCount[] {
  return [
    { key: 'allowed', label: 'Allowed', count: recent.allowed },
    { key: 'denied', label: 'Denied', count: recent.denied },
    { key: 'failed', label: 'Failed', count: recent.failed },
    { key: 'timedOut', label: 'Timed out', count: recent.timedOut },
  ]
}

/**
 * The window the counts cover, as the screen says it. The server counts by the hour, so
 * the window is the current hour and the ones before it: between 23 and 24 hours, never
 * said as "the last 24 hours".
 */
export const OUTCOME_WINDOW_TEXT = `the current hour and the ${HOOK_OUTCOME_WINDOW_HOURS - 1} before it`

const LAST_OUTCOMES: Record<string, string> = {
  allowed: 'was answered and not refused',
  denied: 'was answered with a denial',
  failed: 'failed',
  timed_out: 'got no answer within the deadline',
}

/**
 * What the most recent call of the window came to, as the end of a sentence that begins
 * "The most recent call, on …,".
 *
 * @param outcome - One of the contract's outcomes; a later server may know another.
 * @returns The words; for a word this version does not know, words that quote it.
 */
export function lastOutcomeText(outcome: string): string {
  return own(LAST_OUTCOMES, outcome) ?? `came to what the server calls: ${outcome}`
}

/**
 * What a hook's most recent call came to, for the `data-health` of its line. It is about
 * that one call, whenever it was: never about how the hook is doing now.
 */
export type HookHealth = 'not-called' | 'answered' | 'failed' | 'timed-out' | 'unknown'

/** What a hook's most recent call came to, in words. */
export interface HookHealthWords {
  kind: HookHealth
  /** A few words: "Last call failed". Never "now": the call may be most of a day old. */
  label: string
  /** When that call was asked, as the server answered it; `null` when there was none. */
  at: string | null
  /** What that rests on, and what it does not say. */
  detail: string
}

const ONE_CALL =
  'That is one call, at the time shown: it does not say what a call made now would come to.'
const OFF = 'It is switched off, so it has not been asked since.'

/**
 * Say what a hook's most recent call came to, **and nothing about now**: the screen has one
 * call and its time, and a hook whose last call failed 23 hours ago and has not been asked
 * since has not been shown to be still broken. Whether that call got no usable answer is
 * the contract's `hookLastCallFailed`, shared with every other reader of the API. Never
 * from `lastFailedAt` (it is never cleared), and never from a share of the counts.
 *
 * @param hook - The hook's switch and its `recentOutcomes`.
 * @returns The kind for styling, the words for reading and when the call was.
 */
export function hookHealth(hook: Pick<Hook, 'enabled' | 'recentOutcomes'>): HookHealthWords {
  const { lastCallAt, lastOutcome } = hook.recentOutcomes
  if (lastCallAt === null || lastOutcome === null) {
    return {
      kind: 'not-called',
      label: 'Not called',
      at: null,
      detail: `The server made no call of it in ${OUTCOME_WINDOW_TEXT}, so nothing says whether it answers.`,
    }
  }
  const since = hook.enabled ? ONE_CALL : OFF
  if (hookLastCallFailed(lastOutcome)) {
    return lastOutcome === 'timed_out'
      ? {
          kind: 'timed-out',
          label: 'Last call timed out',
          at: lastCallAt,
          detail: `Its most recent call got no answer within the deadline. ${since}`,
        }
      : {
          kind: 'failed',
          label: 'Last call failed',
          at: lastCallAt,
          detail: `Its most recent call got no usable answer. ${since}`,
        }
  }
  if (own(LAST_OUTCOMES, lastOutcome) === undefined) {
    // A word a later server wrote: not read as an answer, and not as a failure.
    return {
      kind: 'unknown',
      label: 'Last call: not known to this version',
      at: lastCallAt,
      detail:
        'The server says what its most recent call came to in a word this version of the dashboard does not know. It is quoted below.',
    }
  }
  return {
    kind: 'answered',
    label: 'Last call answered',
    at: lastCallAt,
    detail: `Its most recent call was answered. ${since}`,
  }
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
