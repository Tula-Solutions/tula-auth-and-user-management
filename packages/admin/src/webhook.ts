import {
  signWebhook,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_VERSION,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_TOLERANCE_SECONDS,
  webhookSecretBytes,
} from '@tula/contract/webhook-signature'
import { clientError } from './errors'
import type { Schemas } from './generated/api.gen'

/**
 * An event as a webhook delivers it: a union told apart by `type`.
 *
 * A later server may send a type this version does not list, or add a field to a known one:
 * handle the types you know and ignore the rest.
 *
 * @example
 * ```ts
 * function handle(event: TulaWebhookEvent) {
 *   if (event.type === 'session.reuse_detected') {
 *     alertSecurity(event.data.userId)
 *   }
 * }
 * ```
 */
export type TulaWebhookEvent = Schemas['TulaEvent']

/**
 * The headers of the request a delivery arrived in: a `Headers` object, or a plain record as
 * Node's `req.headers` is. Names are matched whatever their case.
 *
 * @example
 * ```ts
 * const headers: WebhookHeaders = request.headers
 * ```
 */
export type WebhookHeaders =
  | Headers
  | Readonly<Record<string, string | readonly string[] | undefined>>

/**
 * Options of {@link verifyWebhook}.
 *
 * @example
 * ```ts
 * const options: VerifyWebhookOptions = { now: Date.now() }
 * ```
 */
export interface VerifyWebhookOptions {
  /**
   * The time to judge the delivery's timestamp by, in milliseconds since the Unix epoch.
   * Defaults to the clock (`Date.now()`); a test passes its own.
   */
  now?: number
}

/**
 * Most signatures read from one `webhook-signature` header. Tula sends one, and two while a
 * secret is being replaced; the bound keeps a forged header from costing more than a few
 * comparisons.
 *
 * @example
 * ```ts
 * signatures.length <= WEBHOOK_MAX_SIGNATURES
 * ```
 */
export const WEBHOOK_MAX_SIGNATURES = 8

/** Longest `webhook-signature` header read; {@link WEBHOOK_MAX_SIGNATURES} of them fit well inside. */
const MAX_SIGNATURE_HEADER_LENGTH = 1024

/** Longest `webhook-id` accepted. Tula's is an event id (36 characters). */
const MAX_ID_LENGTH = 256

/** Whole seconds since the epoch, in decimal: nothing else is a timestamp. */
const TIMESTAMP = /^[0-9]{1,15}$/

/** The one value of a header, or `undefined` when it is missing, empty or was sent twice. */
function header(headers: WebhookHeaders, name: string): string | undefined {
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(name) || undefined
  }
  const found: string[] = []
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name || value === undefined) {
      continue
    }
    found.push(...(typeof value === 'string' ? [value] : value))
  }
  // Two values of one of these headers is a request no Tula server sent.
  return found.length === 1 ? found[0] || undefined : undefined
}

/**
 * Whether two strings are equal, in time that depends on their length only.
 *
 * The length of a signature is public (it is the base64 of a SHA-256), so returning early on
 * a different length tells an attacker nothing.
 */
function equalInConstantTime(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false
  }
  let difference = 0
  for (let index = 0; index < a.length; index++) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return difference === 0
}

/** The text of a body, or `undefined` for bytes that are not UTF-8: no Tula server sent them. */
function bodyText(body: string | Uint8Array): string | undefined {
  if (typeof body === 'string') {
    return body
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a parsed body has the envelope of an event and is the event the delivery names. */
function isEvent(value: unknown, id: string): value is TulaWebhookEvent {
  return (
    isRecord(value) &&
    value.id === id &&
    typeof value.type === 'string' &&
    typeof value.schemaVersion === 'number' &&
    typeof value.occurredAt === 'string' &&
    isRecord(value.actor) &&
    isRecord(value.target) &&
    isRecord(value.data)
  )
}

/**
 * Verify a webhook delivery from Tula and return its event.
 *
 * A delivery is a `POST` whose body is the event as JSON and whose headers carry its id
 * (`webhook-id`), when it was sent (`webhook-timestamp`, in seconds) and one or more
 * signatures (`webhook-signature`: `v1,<base64>`, separated by spaces): the Standard Webhooks
 * scheme, HMAC-SHA256 over `<id>.<timestamp>.<body>` with the endpoint's secret. The delivery
 * is accepted when **any one** signature is right and the timestamp is within five minutes of
 * this server's clock, either way.
 *
 * **Pass the body exactly as it arrived**: the raw text or bytes of the request, never an
 * object your framework parsed and you wrote out again. The signature is over the bytes.
 *
 * Delivery is at least once. The same event can arrive again with the same `id` (the
 * `webhook-id` header): keep the ids you have handled and drop a repeat.
 *
 * Runs on any server runtime (it uses Web Crypto). Never call it from a browser: it takes the
 * endpoint's secret.
 *
 * @param body - The request body as received: text or bytes.
 * @param headers - The request's headers.
 * @param secret - The endpoint's signing secret (`whsec_…`), as its registration returned it.
 * @param options - The clock to judge the timestamp by; the real one unless given.
 * @returns The event. Its `type` may be one a later server added.
 * @throws TulaAdminError with `status` 0 and one of these codes, and never with the secret, a
 *   signature or the body in it: `webhook.invalid_secret` (not a `whsec_…` secret),
 *   `webhook.invalid_headers` (a header missing, sent twice or malformed),
 *   `webhook.timestamp_out_of_tolerance` (more than five minutes old, or ahead),
 *   `webhook.invalid_signature` (no signature matches), `webhook.invalid_payload` (signed
 *   correctly, but not an event with the delivery's id).
 *
 * @example
 * ```ts
 * // A route handler (Next.js, Hono, any `Request`-based server).
 * export async function POST(request: Request) {
 *   let event: TulaWebhookEvent
 *   try {
 *     event = await verifyWebhook(await request.text(), request.headers, process.env.TULA_WEBHOOK_SECRET ?? '')
 *   } catch {
 *     return new Response(null, { status: 400 })
 *   }
 *   if (await alreadyHandled(event.id)) {
 *     return new Response(null, { status: 204 })
 *   }
 *   if (event.type === 'user.created') {
 *     await provisionWorkspace(event.target.id)
 *   }
 *   return new Response(null, { status: 204 })
 * }
 * ```
 */
export async function verifyWebhook(
  body: string | Uint8Array,
  headers: WebhookHeaders,
  secret: string,
  options: VerifyWebhookOptions = {}
): Promise<TulaWebhookEvent> {
  const key = webhookSecretBytes(secret)
  if (!key) {
    throw clientError('webhook.invalid_secret')
  }
  const id = header(headers, WEBHOOK_ID_HEADER)
  const sentAt = header(headers, WEBHOOK_TIMESTAMP_HEADER)
  const signatures = header(headers, WEBHOOK_SIGNATURE_HEADER)
  if (
    id === undefined ||
    id.length > MAX_ID_LENGTH ||
    // The signed text is `<id>.<timestamp>.<body>`: a full stop in the id would let one
    // delivery be read as another.
    id.includes('.') ||
    sentAt === undefined ||
    !TIMESTAMP.test(sentAt) ||
    signatures === undefined ||
    signatures.length > MAX_SIGNATURE_HEADER_LENGTH
  ) {
    throw clientError('webhook.invalid_headers')
  }
  const entries = signatures.split(' ').filter((entry) => entry !== '')
  if (
    entries.length === 0 ||
    entries.length > WEBHOOK_MAX_SIGNATURES ||
    !entries.every((entry) => entry.indexOf(',') > 0)
  ) {
    throw clientError('webhook.invalid_headers')
  }
  const timestamp = Number(sentAt)
  const now = Math.floor((options.now ?? Date.now()) / 1000)
  if (Math.abs(now - timestamp) > WEBHOOK_TOLERANCE_SECONDS) {
    throw clientError('webhook.timestamp_out_of_tolerance')
  }
  const text = bodyText(body)
  if (text === undefined) {
    throw clientError('webhook.invalid_signature')
  }
  const expected = await signWebhook(key, id, timestamp, text)
  // Every entry is compared, whichever matched first: how long this takes says nothing about
  // which one was right.
  let matched = false
  for (const entry of entries) {
    const version = entry.slice(0, entry.indexOf(','))
    if (version === WEBHOOK_SIGNATURE_VERSION && equalInConstantTime(entry, expected)) {
      matched = true
    }
  }
  if (!matched) {
    throw clientError('webhook.invalid_signature')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw clientError('webhook.invalid_payload')
  }
  if (!isEvent(parsed, id)) {
    throw clientError('webhook.invalid_payload')
  }
  return parsed
}
