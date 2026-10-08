// How a webhook delivery is signed: the Standard Webhooks scheme (standardwebhooks.com), in
// its symmetric form. This module imports nothing (no Zod) and uses web platform APIs only, so
// the server that signs, `@tula/admin`'s verifier and a receiver's own code share one
// definition without a schema library in a bundle: `@tula/contract/webhook-signature`.

/**
 * Request header carrying the delivery's id: the event's id. A delivery that is repeated
 * carries the same id, so a receiver drops duplicates by it.
 *
 * @example
 * ```ts
 * const id = request.headers.get(WEBHOOK_ID_HEADER)
 * ```
 */
export const WEBHOOK_ID_HEADER = 'webhook-id'

/**
 * Request header carrying when the delivery was sent, in whole seconds since the Unix epoch.
 * It is signed, and a receiver refuses one too far from its own clock.
 *
 * @example
 * ```ts
 * const sentAt = Number(request.headers.get(WEBHOOK_TIMESTAMP_HEADER)) * 1000
 * ```
 */
export const WEBHOOK_TIMESTAMP_HEADER = 'webhook-timestamp'

/**
 * Request header carrying the signatures: one or more of `v1,<base64>`, separated by spaces.
 * A receiver accepts the delivery when any one of them is right.
 *
 * @example
 * ```ts
 * const signatures = (request.headers.get(WEBHOOK_SIGNATURE_HEADER) ?? '').split(' ')
 * ```
 */
export const WEBHOOK_SIGNATURE_HEADER = 'webhook-signature'

/**
 * What an endpoint's signing secret starts with. The rest is the base64 of the key's bytes.
 *
 * @example
 * ```ts
 * secret.startsWith(WEBHOOK_SECRET_PREFIX) // 'whsec_…'
 * ```
 */
export const WEBHOOK_SECRET_PREFIX = 'whsec_'

/**
 * The version label of an HMAC-SHA256 signature: what stands before the comma.
 *
 * @example
 * ```ts
 * const [version, signature] = entry.split(',') // version === WEBHOOK_SIGNATURE_VERSION
 * ```
 */
export const WEBHOOK_SIGNATURE_VERSION = 'v1'

/**
 * How far a delivery's timestamp may be from the receiver's clock, either way, in seconds.
 * Five minutes: what bounds the replay of a captured delivery.
 *
 * @example
 * ```ts
 * const fresh = Math.abs(now - sentAt) <= WEBHOOK_TOLERANCE_SECONDS
 * ```
 */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60

/** The smallest and largest signing key the scheme allows, in bytes. */
const MIN_KEY_BYTES = 24
const MAX_KEY_BYTES = 64

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** Base64 of bytes, with padding: the alphabet the scheme uses (not the URL-safe one). */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

/**
 * The key bytes of a signing secret.
 *
 * @param secret - An endpoint's secret: `whsec_` and the base64 of 24 to 64 bytes.
 * @returns The bytes, or `null` for anything else. Never throws, and says nothing of the value.
 *
 * @example
 * ```ts
 * const key = webhookSecretBytes(process.env.TULA_WEBHOOK_SECRET ?? '')
 * ```
 */
export function webhookSecretBytes(secret: string): Uint8Array<ArrayBuffer> | null {
  if (!secret.startsWith(WEBHOOK_SECRET_PREFIX)) {
    return null
  }
  const encoded = secret.slice(WEBHOOK_SECRET_PREFIX.length)
  if (!BASE64.test(encoded) || encoded.length % 4 !== 0) {
    return null
  }
  let binary: string
  try {
    binary = atob(encoded)
  } catch {
    return null
  }
  if (binary.length < MIN_KEY_BYTES || binary.length > MAX_KEY_BYTES) {
    return null
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/**
 * Write a signing secret from its key bytes.
 *
 * @param key - 24 to 64 random bytes.
 * @returns `whsec_` and the base64 of the bytes.
 * @throws RangeError when the key is shorter or longer than the scheme allows.
 *
 * @example
 * ```ts
 * const secret = formatWebhookSecret(crypto.getRandomValues(new Uint8Array(32)))
 * ```
 */
export function formatWebhookSecret(key: Uint8Array): string {
  if (key.length < MIN_KEY_BYTES || key.length > MAX_KEY_BYTES) {
    throw new RangeError('a webhook signing key is 24 to 64 bytes')
  }
  return `${WEBHOOK_SECRET_PREFIX}${toBase64(key)}`
}

/**
 * Sign one delivery: HMAC-SHA256 over `<id>.<timestamp>.<body>`, keyed with the secret's bytes.
 *
 * The body is the exact text that is sent. A receiver must verify the bytes it received, not
 * a body it parsed and wrote out again.
 *
 * @param key - The key bytes ({@link webhookSecretBytes}).
 * @param id - The delivery's id (the `webhook-id` header). It has no `.` in it.
 * @param timestamp - Whole seconds since the Unix epoch (the `webhook-timestamp` header).
 * @param body - The request body, as sent.
 * @returns The signature as it stands in the header: `v1,<base64>`.
 *
 * @example
 * ```ts
 * const signature = await signWebhook(key, event.id, Math.floor(Date.now() / 1000), body)
 * // 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE='
 * ```
 */
export async function signWebhook(
  key: Uint8Array<ArrayBuffer>,
  id: string,
  timestamp: number,
  body: string
): Promise<string> {
  const hmac = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  const content = new TextEncoder().encode(`${id}.${timestamp}.${body}`)
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', hmac, content))
  return `${WEBHOOK_SIGNATURE_VERSION},${toBase64(signature)}`
}
