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
 * The secret, or secrets, a delivery is verified with: one `whsec_…` secret, or a list of
 * them (at most {@link WEBHOOK_MAX_SECRETS}) while a secret is being replaced.
 *
 * @example
 * ```ts
 * // The secret a rotation returned, and the one it replaced until the overlap has ended.
 * const secrets: WebhookSecrets = [rotated.secret, secretInUseBefore]
 * ```
 */
export type WebhookSecrets = string | readonly string[]

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

/**
 * Most secrets {@link verifyWebhook} takes. Tula signs with one secret, and with two while a
 * secret is being replaced: never three. A third in a receiver's list is one that should
 * have been taken out, and a secret left in a list stays good for whoever holds it.
 *
 * @example
 * ```ts
 * secrets.length <= WEBHOOK_MAX_SECRETS
 * ```
 */
export const WEBHOOK_MAX_SECRETS = 2

/** Longest `webhook-signature` header read; {@link WEBHOOK_MAX_SIGNATURES} of them fit well inside. */
const MAX_SIGNATURE_HEADER_LENGTH = 1024

/** Longest `webhook-id` accepted. Tula's is an event id (36 characters). */
const MAX_ID_LENGTH = 256

/** Whole seconds since the epoch, in decimal: nothing else is a timestamp. */
const TIMESTAMP = /^[0-9]{1,15}$/

/**
 * Every value a header was sent with, in order.
 *
 * A plain record (Node's `req.headers`) keeps a repeated header as a list, or under two
 * spellings of its name. A `Headers` object has already joined the values with `, `: there
 * the one string is all there is, and what it holds is judged by the caller.
 */
function headerValues(headers: WebhookHeaders, name: string): string[] {
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const joined = headers.get(name)
    return joined === null ? [] : [joined]
  }
  const found: string[] = []
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name || value === undefined) {
      continue
    }
    found.push(...(typeof value === 'string' ? [value] : value))
  }
  return found
}

/**
 * The value of a header that has exactly one: `undefined` when it is missing, empty or was
 * sent twice. A value with a comma in it is refused as sent twice, because that is what a
 * `Headers` object makes of a repeated header, and neither an id nor a timestamp has one.
 */
function single(headers: WebhookHeaders, name: string): string | undefined {
  const [value, ...more] = headerValues(headers, name)
  return value && more.length === 0 && !value.includes(',') ? value : undefined
}

/**
 * The entries of the signature header. It is a list by definition (space-separated, so that
 * two secrets can sign during a rotation), and a signature header sent twice is read as one
 * longer list, as the reference Standard Webhooks library reads it: a `Headers` object joins
 * the two with `, `, which leaves a comma at the end of an entry, dropped here.
 */
function signatureEntries(headers: WebhookHeaders): string[] | undefined {
  const joined = headerValues(headers, WEBHOOK_SIGNATURE_HEADER).join(' ')
  if (joined === '' || joined.length > MAX_SIGNATURE_HEADER_LENGTH) {
    return undefined
  }
  const entries = joined
    .split(' ')
    .map((entry) => entry.replace(/,+$/, ''))
    .filter((entry) => entry !== '')
  const wellFormed =
    entries.length > 0 &&
    entries.length <= WEBHOOK_MAX_SIGNATURES &&
    entries.every((entry) => entry.indexOf(',') > 0)
  return wellFormed ? entries : undefined
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

/**
 * The signing keys of what the caller passed as the secret: one secret or a short list.
 *
 * `undefined` for anything else: no list, an empty one, more than
 * {@link WEBHOOK_MAX_SECRETS}, or **any** entry that is not a signing secret, even beside one
 * that is. A list with a broken entry is a misconfiguration, and saying so on every delivery
 * is how it gets noticed; a verifier that quietly used the entries it liked would hide, for
 * instance, a new secret that was pasted wrong until the day the old one stops signing.
 */
function signingKeys(secret: unknown): Uint8Array<ArrayBuffer>[] | undefined {
  const listed: unknown = typeof secret === 'string' ? [secret] : secret
  if (!Array.isArray(listed) || listed.length === 0 || listed.length > WEBHOOK_MAX_SECRETS) {
    return undefined
  }
  const keys: Uint8Array<ArrayBuffer>[] = []
  for (const one of listed as unknown[]) {
    const key = typeof one === 'string' ? webhookSecretBytes(one) : null
    if (!key) {
      return undefined
    }
    keys.push(key)
  }
  return keys
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
    isRecord(value.data) &&
    // A test event says `true`; a real one has no such key. Anything else is neither.
    (value.test === undefined || value.test === true)
  )
}

/**
 * Verify a webhook delivery from Tula and return its event.
 *
 * A delivery is a `POST` whose body is the event as JSON and whose headers carry its id
 * (`webhook-id`), when it was sent (`webhook-timestamp`, in seconds) and one or more
 * signatures (`webhook-signature`: `v1,<base64>`, separated by spaces): the Standard Webhooks
 * scheme, HMAC-SHA256 over `<id>.<timestamp>.<body>` with the endpoint's secret. The delivery
 * is accepted when **any one** signature is right for **any one** of the secrets given and the
 * timestamp is within five minutes of this server's clock, either way.
 *
 * **Replacing a secret without losing a delivery.** `secret` may be a list of two. When an
 * endpoint's secret is rotated, the server signs every delivery with the new secret *and* the
 * previous one for 24 hours, so the order of work is:
 *
 * 1. Rotate (`rotateWebhookSecret`); the answer has the new secret and
 *    `rotationOverlapEndsAt`. Nothing breaks: deliveries still carry the old signature.
 * 2. Inside those 24 hours, deploy the receiver with **both** secrets (or with the new one
 *    alone: during the overlap either verifies).
 * 3. After `rotationOverlapEndsAt`, take the old secret out. Do take it out: a secret left
 *    in the list stays good for anyone who holds it.
 *
 * The rotation comes first because the server makes the secret: there is nothing to deploy
 * until it has answered. The overlap is what makes that order safe.
 *
 * A `webhook-id` or `webhook-timestamp` that was sent twice is refused (also where a `Headers`
 * object has joined the two values with a comma). A `webhook-signature` sent twice is read as
 * one list, like the reference library does: it is a list already, and one right entry is
 * enough.
 *
 * **Pass the body exactly as it arrived**: the raw text or bytes of the request, never an
 * object your framework parsed and you wrote out again. The signature is over the bytes.
 *
 * Delivery is at least once. The same event can arrive again with the same `id` (the
 * `webhook-id` header): a delivery you answered with anything but a 2xx is sent again, up to
 * eight times over about a day, and an administrator can send one again by hand. Keep the ids
 * you have handled and drop a repeat. Events can arrive out of order (a retry of an older one
 * after a newer one): order them by `occurredAt`.
 *
 * **Check `event.test` before acting.** A test event (one an administrator asked the server to
 * send) is a real, signed delivery of an example: nothing it describes happened. It carries
 * `test: true` inside the signed body; a real event has no such field.
 *
 * Runs on any server runtime (it uses Web Crypto). Never call it from a browser: it takes the
 * endpoint's secret.
 *
 * @param body - The request body as received: text or bytes.
 * @param headers - The request's headers.
 * @param secret - The endpoint's signing secret (`whsec_…`), as its registration or a rotation
 *   returned it; or a list of one or two of them. Every secret listed must be a signing
 *   secret: an empty list, a third secret or a malformed entry is refused
 *   (`webhook.invalid_secret`), whatever the delivery.
 * @param options - The clock to judge the timestamp by; the real one unless given.
 * @returns The event. Its `type` may be one a later server added.
 * @throws TulaAdminError with `status` 0 and one of these codes, and never with the secret, a
 *   signature or the body in it, nor which of two secrets was the wrong one:
 *   `webhook.invalid_secret` (not a `whsec_…` secret, or not one or two of them),
 *   `webhook.invalid_headers` (a header missing or malformed, or an id or a timestamp sent
 *   twice),
 *   `webhook.timestamp_out_of_tolerance` (more than five minutes old, or ahead),
 *   `webhook.invalid_signature` (no signature matches any secret), `webhook.invalid_payload` (signed
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
 *   if (event.test || (await alreadyHandled(event.id))) {
 *     return new Response(null, { status: 204 })
 *   }
 *   if (event.type === 'user.created') {
 *     await provisionWorkspace(event.target.id)
 *   }
 *   return new Response(null, { status: 204 })
 * }
 * ```
 *
 * @example
 * ```ts
 * // While a secret is being replaced: the new one, and the previous one until the overlap
 * // has ended (`rotationOverlapEndsAt`), then deploy again without it.
 * const secrets = [process.env.TULA_WEBHOOK_SECRET, process.env.TULA_WEBHOOK_SECRET_PREVIOUS].filter(
 *   (secret): secret is string => Boolean(secret)
 * )
 * const event = await verifyWebhook(await request.text(), request.headers, secrets)
 * ```
 */
export async function verifyWebhook(
  body: string | Uint8Array,
  headers: WebhookHeaders,
  secret: WebhookSecrets,
  options: VerifyWebhookOptions = {}
): Promise<TulaWebhookEvent> {
  const keys = signingKeys(secret)
  if (!keys) {
    throw clientError('webhook.invalid_secret')
  }
  const id = single(headers, WEBHOOK_ID_HEADER)
  const sentAt = single(headers, WEBHOOK_TIMESTAMP_HEADER)
  const entries = signatureEntries(headers)
  if (
    id === undefined ||
    id.length > MAX_ID_LENGTH ||
    // The signed text is `<id>.<timestamp>.<body>`: a full stop in the id would let one
    // delivery be read as another.
    id.includes('.') ||
    sentAt === undefined ||
    !TIMESTAMP.test(sentAt) ||
    entries === undefined
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
  // The signature every secret would have made, all of them, before anything is compared.
  const expected: string[] = []
  for (const key of keys) {
    expected.push(await signWebhook(key, id, timestamp, text))
  }
  // Every entry is put to every secret's signature, whichever matched first, and the results
  // are gathered without a branch: how long this takes says nothing about which entry, or
  // which secret, was right.
  let matched = 0
  for (const entry of entries) {
    // The label before the comma is public; an entry of another version is never a match.
    const versioned = entry.slice(0, entry.indexOf(',')) === WEBHOOK_SIGNATURE_VERSION ? 1 : 0
    for (const signature of expected) {
      matched |= versioned & (equalInConstantTime(entry, signature) ? 1 : 0)
    }
  }
  if (matched === 0) {
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
