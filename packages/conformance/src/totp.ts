import { TOTP_DIGITS, TOTP_PERIOD_SECONDS } from '@tula/contract'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * Time steps either side of the current one whose codes {@link wrongTotp} avoids: one more
 * than a server accepts (RFC 6238 §5.2 recommends at most one), so the wrong code stays wrong
 * when the request lands just after a step rolls over.
 */
const WRONG_CODE_CLEARANCE_STEPS = 2

/**
 * Decode Base32 (RFC 4648), the form an authenticator secret is shown in. Case, spaces, dashes
 * and `=` padding are ignored.
 *
 * @param text - The Base32 text.
 * @returns The decoded bytes.
 * @throws RangeError when the text holds a character outside the Base32 alphabet. The message
 *   never quotes the text: it is a secret.
 *
 * @example
 * ```ts
 * base32Decode('MZXW6YTBOI') // the bytes of "foobar"
 * ```
 */
export function base32Decode(text: string): Uint8Array<ArrayBuffer> {
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const character of text.toUpperCase().replace(/[\s=-]/g, '')) {
    const value = BASE32_ALPHABET.indexOf(character)
    if (value < 0) {
      throw new RangeError('not a Base32 secret')
    }
    buffer = (buffer << 5) | value
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >>> bits) & 255)
      // Keep only the bits not yet written, so the accumulator never overflows.
      buffer &= (1 << bits) - 1
    }
  }
  return Uint8Array.from(bytes)
}

/**
 * The HOTP value of a counter (RFC 4226): HMAC-SHA-1, dynamic truncation, six digits.
 *
 * @param secret - The shared secret's bytes.
 * @param counter - The counter (for TOTP, the time step).
 * @returns The code, zero-padded to six digits.
 *
 * @example
 * ```ts
 * await hotp(new TextEncoder().encode('12345678901234567890'), 0) // '755224'
 * ```
 */
export async function hotp(secret: Uint8Array<ArrayBuffer>, counter: number): Promise<string> {
  const message = new DataView(new ArrayBuffer(8))
  message.setUint32(0, Math.floor(counter / 2 ** 32))
  message.setUint32(4, counter % 2 ** 32)
  // SHA-1 is what RFC 6238 authenticator apps use by default; it is not a choice made here.
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-1' }, false, [
    'sign',
  ])
  const mac = new DataView(await crypto.subtle.sign('HMAC', key, message.buffer))
  const offset = mac.getUint8(mac.byteLength - 1) & 15
  const binary = mac.getUint32(offset) & 0x7fffffff
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0')
}

/**
 * The time step a moment falls in (RFC 6238): whole 30-second periods since the Unix epoch.
 *
 * @param atMs - The moment, in milliseconds since the epoch.
 * @returns The step number.
 */
export function totpStep(atMs: number): number {
  return Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS)
}

/**
 * The code an authenticator app holding a secret shows at a moment (RFC 6238, SHA-1, six
 * digits, 30-second steps).
 *
 * @param secret - The shared secret's bytes.
 * @param atMs - The moment, in milliseconds since the epoch.
 * @returns The 6-digit code.
 *
 * @example
 * ```ts
 * await totp(base32Decode(enrolment.secret), Date.now())
 * ```
 */
export function totp(secret: Uint8Array<ArrayBuffer>, atMs: number): Promise<string> {
  return hotp(secret, totpStep(atMs))
}

/**
 * A 6-digit code that is certainly not the right one at a moment: it differs from the code of
 * the current step and of the two steps either side, so no server window accepts it by chance.
 *
 * @param secret - The shared secret's bytes.
 * @param atMs - The moment, in milliseconds since the epoch.
 * @returns The wrong code.
 */
export async function wrongTotp(secret: Uint8Array<ArrayBuffer>, atMs: number): Promise<string> {
  const step = totpStep(atMs)
  const valid = new Set<string>()
  for (let near = -WRONG_CODE_CLEARANCE_STEPS; near <= WRONG_CODE_CLEARANCE_STEPS; near++) {
    valid.add(await hotp(secret, step + near))
  }
  let candidate = Number(await hotp(secret, step))
  do {
    candidate = (candidate + 1) % 10 ** TOTP_DIGITS
  } while (valid.has(String(candidate).padStart(TOTP_DIGITS, '0')))
  return String(candidate).padStart(TOTP_DIGITS, '0')
}
