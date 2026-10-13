import { WEBHOOK_WAITING_TOO_LONG_MS } from '../../apps/api/src/modules/instance/constants'
import { verifyWebhook } from '../../packages/admin/src/webhook'

// The server's own threshold, not a copy of it: `.claude/hooks/worker-check.test.ts` holds
// the three numbers and their order.
export { WEBHOOK_WAITING_TOO_LONG_MS }

/**
 * How long the worker check leaves the owed event waiting with no worker: the time after
 * which the server's diagnostics call an event stuck, and a bit.
 */
export const OWED_WAIT_MS = WEBHOOK_WAITING_TOO_LONG_MS + 5_000

/** By when, counted from the owed event, the diagnostics must have called it stuck. */
export const STUCK_WITHIN_MS = OWED_WAIT_MS + 55_000

/** One request the receiver of the worker check was sent, as it wrote it to its output. */
export interface Received {
  method: string
  path: string
  /** The address the request came from, as the receiver's socket saw it. */
  peer: string | null
  /** The `webhook-id` header. */
  id: string | null
  /** The `webhook-timestamp` header. */
  timestamp: string | null
  /** The `webhook-signature` header. */
  signature: string | null
  /** The body, exactly as it arrived. */
  body: string
}

/** The part of a verified event the check compares with the delivery log. */
export interface SignedEvent {
  id: string
  type: string
  /** `true` for a test event, which is not a delivery of anything that happened. */
  test: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse a line of JSON, or `null` for anything else (Compose's own lines, a truncated one). */
function json(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/**
 * The requests in the receiver's output, in the order they arrived.
 *
 * @param log - The receiver's standard output: one JSON object a line (`receiver.ts`).
 * @returns Every `{ received: … }` line; every other line is left out.
 */
export function receivedRequests(log: string): Received[] {
  return log.split('\n').flatMap((line) => {
    const parsed = json(line)
    const received = isRecord(parsed) ? parsed.received : undefined
    if (!isRecord(received)) {
      return []
    }
    return [
      {
        method: text(received.method) ?? '',
        path: text(received.path) ?? '',
        peer: text(received.peer),
        id: text(received.id),
        timestamp: text(received.timestamp),
        signature: text(received.signature),
        body: text(received.body) ?? '',
      },
    ]
  })
}

/**
 * Verify a received request as an application would, with `@tula/admin`'s `verifyWebhook`.
 *
 * Reaching the receiver proves where a request came from; only the signature proves it is the
 * server's delivery for this endpoint.
 *
 * @param received - The request, as the receiver wrote it.
 * @param secret - The signing secret the endpoint's registration returned.
 * @param now - The time to judge the timestamp by.
 * @returns The event, or `null` when the request does not verify for any reason.
 */
export async function signedEvent(
  received: Received,
  secret: string,
  now: Date = new Date()
): Promise<SignedEvent | null> {
  try {
    const event = await verifyWebhook(
      received.body,
      {
        'webhook-id': received.id ?? undefined,
        'webhook-timestamp': received.timestamp ?? undefined,
        'webhook-signature': received.signature ?? undefined,
      },
      secret,
      { now: now.getTime() }
    )
    return { id: event.id, type: event.type, test: event.test === true }
  } catch {
    return null
  }
}

/**
 * How many deliveries a container's log says its delivery rounds made.
 *
 * The delivery job writes one `webhook delivery round finished` line for a round that did
 * something, with its counts. A container that makes no delivery writes none.
 *
 * @param log - The container's output, without Compose's prefix: one JSON object a line.
 * @returns The sum of `delivered` over those lines.
 */
export function deliveriesLogged(log: string): number {
  let delivered = 0
  for (const line of log.split('\n')) {
    const parsed = json(line)
    if (
      isRecord(parsed) &&
      parsed.msg === 'webhook delivery round finished' &&
      typeof parsed.delivered === 'number'
    ) {
      delivered += parsed.delivered
    }
  }
  return delivered
}
