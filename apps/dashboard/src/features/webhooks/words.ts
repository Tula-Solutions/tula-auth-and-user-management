import { MAX_WEBHOOK_ENDPOINTS } from '@tula/contract'
import { messageFor, toApiError } from '~/api/errors'
import type { WebhookEndpoint, WebhookSendResult } from '~/api/generated/api.gen'
import { formatDateTime } from '~/lib/format'
import { own } from '~/lib/own'

// Every sentence the webhooks screens say about a state, a refusal or a failure. The server
// answers with fixed words (`gone`, `rotation_in_progress`, `timeout`); what an operator reads
// is the dashboard's own text for each. A word this version does not know is shown as the
// text it is, never as markup and never as the only thing said.

/** How an endpoint is doing, for the `data-state` of its badge. */
export type EndpointStateKind = 'active' | 'failing' | 'off' | 'off-by-server'

/** An endpoint's state in words. */
export interface EndpointState {
  kind: EndpointStateKind
  /** A few words: "Active", "Switched off by the server". */
  label: string
  /** What that means and, where there is something to do, what. */
  detail: string
}

const SERVER_REASONS: Record<string, string> = {
  failing:
    'Requests to it failed for five days with no success among them, so the server stopped sending. Fix the receiver, send a test event, then switch it on.',
  gone: 'It answered “410 Gone”, which means “stop”, so the server stopped sending at once. Switch it on only once the receiver takes deliveries again.',
}

/**
 * Say how an endpoint is doing: on, on but failing, switched off by an operator, or switched
 * off by the server and why.
 *
 * @param endpoint - The endpoint as the API lists it.
 * @returns The state, as a kind for styling and words for reading.
 */
export function endpointState(
  endpoint: Pick<WebhookEndpoint, 'enabled' | 'disabledReason' | 'failingSince'>
): EndpointState {
  if (endpoint.enabled) {
    return endpoint.failingSince === null
      ? { kind: 'active', label: 'Active', detail: 'Events of its types are delivered to it.' }
      : {
          kind: 'failing',
          label: 'Active, but failing',
          detail: `Requests to it have failed since ${formatDateTime(endpoint.failingSince)}. After five days of failures with no success the server switches it off.`,
        }
  }
  if (endpoint.disabledReason === null) {
    return {
      kind: 'off',
      label: 'Switched off',
      detail:
        'An operator switched it off. Nothing is sent to it, and events from this time are not sent later.',
    }
  }
  return {
    kind: 'off-by-server',
    label: 'Switched off by the server',
    detail:
      own(SERVER_REASONS, endpoint.disabledReason) ??
      `The server stopped sending to it. The server’s reason: ${endpoint.disabledReason}`,
  }
}

const DELIVERY_STATES: Record<string, string> = {
  pending: 'Pending',
  delivered: 'Delivered',
  failed: 'Failed',
}

/**
 * A delivery's state as a word.
 *
 * @param state - `pending`, `delivered` or `failed`; a later server may know another.
 * @returns The word; an unknown state as it is.
 */
export function deliveryStateLabel(state: string): string {
  return own(DELIVERY_STATES, state) ?? state
}

const FAILURE_REASONS: Record<string, string> = {
  timeout: 'No answer within five seconds.',
  connection_failed: 'The connection could not be made, or broke.',
  resolve_failed: 'The host name of the address could not be resolved.',
  address_not_allowed:
    'The address now leads to a private or local network address, which the server does not call.',
  scheme_not_allowed: 'The address does not use https.',
  invalid_url: 'The address is not one the server can call.',
  invalid_request: 'The request could not be built.',
  response_too_large: 'The answer was larger than the server reads.',
  signing_failed:
    'No request was made: the server could not open the endpoint’s signing secret. Check that every API instance has the same TULA_MASTER_KEY.',
  endpoint_unresponsive:
    'No request was made: the endpoint had just let another request time out, so this one was put off.',
  expired: 'Given up after three days pending.',
  event_gone: 'Given up because the event is no longer kept.',
}

/**
 * Why a request got no answer, or why none was made, as a sentence.
 *
 * @param reason - One of the server's fixed words.
 * @returns The sentence; for a word this version does not know, a sentence that quotes it.
 */
export function failureReasonText(reason: string): string {
  return own(FAILURE_REASONS, reason) ?? `The server gave this reason: ${reason}`
}

/**
 * How one request ended, in a few words: the receiver's status code, or that there was none.
 *
 * @param statusCode - The receiver's HTTP status; `null` when there was no answer.
 * @returns For example `HTTP 204` or `No answer`.
 */
export function answerText(statusCode: number | null): string {
  return statusCode === null ? 'No answer' : `HTTP ${statusCode}`
}

/**
 * How a delivery last went, for its row in the list: the receiver's status code, or why
 * there was none, or that nothing has been tried.
 *
 * @param delivery - The delivery's last status code and the server's word for a failure.
 * @returns For example `HTTP 503`, `No answer within five seconds.` or `No request yet`.
 */
export function lastResultText(delivery: {
  statusCode: number | null
  failureReason: string | null
}): string {
  if (delivery.statusCode !== null) {
    return answerText(delivery.statusCode)
  }
  return delivery.failureReason === null
    ? 'No request yet'
    : failureReasonText(delivery.failureReason)
}

/**
 * What became of a request made on demand (a test event, a delivery sent again).
 *
 * @param result - The outcome, the status code, the duration and the server's word.
 * @returns One sentence.
 */
export function sendResultText(
  result: Pick<WebhookSendResult, 'outcome' | 'statusCode' | 'durationMs' | 'failureReason'>
): string {
  const lead = result.outcome === 'delivered' ? 'Delivered' : 'Failed'
  if (result.statusCode !== null) {
    return `${lead}: the endpoint answered ${result.statusCode} in ${result.durationMs} ms.`
  }
  const why = result.failureReason ? ` ${failureReasonText(result.failureReason)}` : ''
  return `${lead}: there was no answer (${result.durationMs} ms).${why}`
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

const REDELIVER_REFUSALS: Record<string, string> = {
  delivery_pending:
    'The server is still retrying this delivery and will send it by itself. It can be sent again by hand once it has been delivered or given up.',
  endpoint_disabled:
    'The endpoint is switched off, and nothing is sent to one that is. Switch it on first.',
  event_gone:
    'The event is no longer kept (events are kept for 30 days), so there is nothing to send again.',
  attempt_limit: 'This delivery has had twenty requests, the most one delivery can have.',
}

const ROTATION_REFUSALS: Record<string, string> = {
  rotation_in_progress:
    'A rotation is already under way: two secrets are signing, and an endpoint never has three. End the overlap first, or wait for it to end.',
  no_rotation_in_progress:
    'No overlap is under way: the previous secret has already stopped signing.',
  secret_unreadable:
    'The server cannot open this endpoint’s current secret, so it could not keep it signing beside a new one. Check that every API instance has the same TULA_MASTER_KEY, or delete the endpoint and add it again.',
}

const REFUSALS: Record<string, { reasons: Record<string, string>; other: string }> = {
  'webhook.url_not_allowed': {
    reasons: URL_REFUSALS,
    other: 'The server cannot deliver to that address.',
  },
  'webhook.cannot_redeliver': {
    reasons: REDELIVER_REFUSALS,
    other: 'This delivery cannot be sent again.',
  },
  'webhook.rotation_refused': {
    reasons: ROTATION_REFUSALS,
    other: 'The signing secret cannot be changed now.',
  },
}

/**
 * What a deployment whose webhook worker is a service of its own says to a request made on
 * demand, by action. Its API instances call no endpoint, so the answer is the same whatever
 * was asked for; what the operator needs to hear is that only this is unavailable.
 */
const WORKER_SEPARATE: Record<'test' | 'redeliver', string> = {
  test: 'This deployment delivers webhooks from a separate worker, so a test event cannot be sent from here. Real events are delivered by that worker, to an endpoint that is switched on and subscribed to their type; this endpoint’s deliveries show them.',
  redeliver:
    'This deployment delivers webhooks from a separate worker, so a delivery cannot be sent again from here. A delivery that is pending is retried by that worker.',
}

/** The fixed word in a refusal's `params.reason`: the answer's own, and a string, or nothing. */
function reasonOf(params: Record<string, unknown>): string | undefined {
  const reason = Object.hasOwn(params, 'reason') ? params.reason : undefined
  return typeof reason === 'string' ? reason : undefined
}

/** Which action failed, for the refusals that mean something different by action. */
export type WebhookAction = 'create' | 'test' | 'redeliver' | 'other'

/**
 * The sentence to show when a webhook call was refused or failed.
 *
 * The three webhook codes carry a fixed word in `params.reason`; each word has a sentence of
 * the dashboard's own. Registering an eleventh endpoint has its own too, and a refusal for
 * too many requests made on demand says that those have an allowance of their own. So does
 * `not_implemented` with the reason `worker_separate`, for those two requests: a deployment
 * whose worker is a service of its own makes neither. Anything else, a `not_implemented`
 * with another reason or none among it, is what every other screen says.
 *
 * @param error - What the mutation threw.
 * @param action - What was being done: `create` (the endpoint limit is a conflict there),
 *   `test` (a test event) or `redeliver` (a delivery sent again), which are the requests
 *   made on demand and share an allowance, or `other`.
 * @returns A sentence for the operator, never a bare code.
 */
export function webhookMessageFor(error: unknown, action: WebhookAction = 'other'): string {
  const failure = toApiError(error)
  // Own properties only, of the answer and of both tables: a code or a reason such as
  // `constructor` would otherwise find what every object has, which is no sentence.
  const refusal = Object.hasOwn(REFUSALS, failure.code) ? REFUSALS[failure.code] : undefined
  if (refusal) {
    const reason = reasonOf(failure.params)
    return reason !== undefined && Object.hasOwn(refusal.reasons, reason)
      ? (refusal.reasons[reason] ?? refusal.other)
      : refusal.other
  }
  if (action === 'create' && failure.code === 'resource.conflict') {
    return `This environment already has ${MAX_WEBHOOK_ENDPOINTS} webhook endpoints, the most one can have. Delete one first.`
  }
  const onDemand = action === 'test' || action === 'redeliver'
  if (
    onDemand &&
    failure.code === 'not_implemented' &&
    reasonOf(failure.params) === 'worker_separate'
  ) {
    return WORKER_SEPARATE[action]
  }
  if (onDemand && failure.code === 'rate_limited') {
    // The answer says "too many" and how long to wait, not which limit it was (the admin
    // API's general one counts too). So no number is named: only that these requests have
    // an allowance beside it, which is why this may be said after very few of them.
    return `${messageFor(error)} Test events and deliveries sent again also have an allowance of their own, for the whole environment.`
  }
  return messageFor(error)
}

/** The path parameters of the webhook routes: what an address names an endpoint or a delivery by. */
const PATH_FIELDS: ReadonlySet<string> = new Set(['id', 'deliveryId'])

/**
 * Whether a failed read means "there is no such endpoint or delivery here".
 *
 * A 404 does, and so does a 422 that is only about the ids in the path: an address typed by
 * hand may name something that is no id at all, which the API refuses before it looks. To
 * the reader both are the same: nothing has that id.
 *
 * @param error - What the query threw.
 * @returns True for a 404, and for a `validation.failed` whose every field is a path id.
 */
export function isNotFound(error: unknown): boolean {
  if (!error) {
    return false
  }
  const failure = toApiError(error)
  if (failure.status === 404) {
    return true
  }
  return (
    failure.code === 'validation.failed' &&
    failure.fieldErrors.length > 0 &&
    failure.fieldErrors.every((entry) => PATH_FIELDS.has(entry.field))
  )
}
