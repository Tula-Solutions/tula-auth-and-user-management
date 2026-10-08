import { MAX_WEBHOOK_ENDPOINTS } from '@tula/contract'
import { messageFor, toApiError } from '~/api/errors'
import type { WebhookEndpoint, WebhookSendResult } from '~/api/generated/api.gen'
import { formatDateTime } from '~/lib/format'

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
      SERVER_REASONS[endpoint.disabledReason] ??
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
  return DELIVERY_STATES[state] ?? state
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
  return FAILURE_REASONS[reason] ?? `The server gave this reason: ${reason}`
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

/** Which action failed, for the refusals that mean something different by action. */
export type WebhookAction = 'create' | 'send' | 'other'

/**
 * The sentence to show when a webhook call was refused or failed.
 *
 * The three webhook codes carry a fixed word in `params.reason`; each word has a sentence of
 * the dashboard's own. Registering an eleventh endpoint and the limit on requests made on
 * demand have theirs too. Anything else is what every other screen says.
 *
 * @param error - What the mutation threw.
 * @param action - What was being done: `create` (the endpoint limit is a conflict there),
 *   `send` (a test event or a delivery sent again, which share a rate limit), or `other`.
 * @returns A sentence for the operator, never a bare code.
 */
export function webhookMessageFor(error: unknown, action: WebhookAction = 'other'): string {
  const failure = toApiError(error)
  const refusal = REFUSALS[failure.code]
  if (refusal) {
    const reason = failure.params.reason
    return (typeof reason === 'string' ? refusal.reasons[reason] : undefined) ?? refusal.other
  }
  if (action === 'create' && failure.code === 'resource.conflict') {
    return `This environment already has ${MAX_WEBHOOK_ENDPOINTS} webhook endpoints, the most one can have. Delete one first.`
  }
  if (action === 'send' && failure.code === 'rate_limited') {
    const wait =
      failure.retryAfter === null
        ? 'Wait a moment, then try again.'
        : `Try again in ${failure.retryAfter} seconds.`
    return `Test events and deliveries sent again share a limit of ten a minute for the environment. ${wait}`
  }
  return messageFor(error)
}
