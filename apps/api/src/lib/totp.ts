import { createHmac } from 'node:crypto'
import { TOTP_DIGITS, TOTP_PERIOD_SECONDS } from '@tula/contract'
import { timingSafeEqual } from '~/lib/crypto'

/**
 * Bytes in a TOTP secret: 160 bits, the size of an HMAC-SHA-1 key that RFC 4226 §4 recommends
 * and every authenticator app accepts.
 */
export const TOTP_SECRET_BYTES = 20

/**
 * Time steps accepted either side of the current one. One step (30 seconds) absorbs a phone
 * whose clock is slightly off and a code typed just as it rolls over; more would only widen
 * the window a stolen code stays good for (RFC 6238 §5.2 recommends at most one).
 */
export const TOTP_DRIFT_STEPS = 1

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * Encode bytes as Base32 (RFC 4648), upper case, **without padding**: the form authenticator
 * apps read from an `otpauth://` URI and people type by hand.
 *
 * @param bytes - The bytes to encode.
 * @returns The Base32 text.
 *
 * @example
 * ```ts
 * base32Encode(new TextEncoder().encode('foobar')) // 'MZXW6YTBOI'
 * ```
 */
export function base32Encode(bytes: Uint8Array): string {
  let output = ''
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      output += BASE32_ALPHABET[(buffer >>> bits) & 31]
    }
    // Keep only the bits not yet written, so the accumulator never grows past 12 bits.
    buffer &= (1 << bits) - 1
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31]
  }
  return output
}

/**
 * Decode Base32 (RFC 4648). Case, spaces, dashes and `=` padding are ignored, as people type
 * secrets in groups.
 *
 * @param text - The Base32 text.
 * @returns The decoded bytes.
 * @throws RangeError when the text holds a character outside the Base32 alphabet.
 */
export function base32Decode(text: string): Uint8Array {
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const character of text.toUpperCase().replace(/[\s=-]/g, '')) {
    const value = BASE32_ALPHABET.indexOf(character)
    if (value < 0) {
      throw new RangeError('base32Decode: not a Base32 character')
    }
    buffer = (buffer << 5) | value
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >>> bits) & 255)
      buffer &= (1 << bits) - 1
    }
  }
  return Uint8Array.from(bytes)
}

/**
 * A new TOTP secret: {@link TOTP_SECRET_BYTES} bytes from the CSPRNG.
 *
 * @returns The secret bytes.
 */
export function generateSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(TOTP_SECRET_BYTES))
}

/**
 * An HOTP value (RFC 4226): HMAC-SHA-1 of the counter, dynamically truncated to `digits`.
 *
 * SHA-1 is what RFC 6238's default mode and every authenticator app use. HMAC-SHA-1 is not
 * affected by SHA-1's collision weakness: forging a code still needs the key.
 *
 * @param secret - The shared secret.
 * @param counter - The moving factor: for TOTP, the time step.
 * @param digits - Length of the code (default {@link TOTP_DIGITS}).
 * @returns The code, zero-padded.
 */
export function hotp(secret: Uint8Array, counter: number, digits: number = TOTP_DIGITS): string {
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', secret).update(message).digest()
  const offset = (digest[digest.length - 1] ?? 0) & 15
  const binary = digest.readUInt32BE(offset) & 0x7fffffff
  return String(binary % 10 ** digits).padStart(digits, '0')
}

/**
 * The RFC 6238 time step a moment falls in: whole {@link TOTP_PERIOD_SECONDS} since the epoch.
 *
 * @param at - The moment.
 * @returns The step number.
 */
export function totpStep(at: Date): number {
  return Math.floor(at.getTime() / 1000 / TOTP_PERIOD_SECONDS)
}

/**
 * The TOTP code for a secret at a moment (RFC 6238, HMAC-SHA-1, 6 digits, 30-second step).
 *
 * @param secret - The shared secret.
 * @param at - The moment.
 * @returns The 6-digit code.
 *
 * @example
 * ```ts
 * totp(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), new Date(59_000)) // '287082'
 * ```
 */
export function totp(secret: Uint8Array, at: Date): string {
  return hotp(secret, totpStep(at))
}

/**
 * The time step a submitted code is valid for: the current step, or one step either side
 * ({@link TOTP_DRIFT_STEPS}).
 *
 * Every candidate step is computed and compared in constant time whether or not an earlier one
 * matched, so the time taken says nothing about which step, if any, was close. When more than
 * one step matches (two neighbouring steps can share a code by chance) the latest is returned,
 * so the replay counter advances as far as the code allows.
 *
 * This only says the code is *right*. Whether it may still be *used* is the caller's
 * compare-and-set on the factor's last used step: a step is accepted once.
 *
 * @param secret - The shared secret.
 * @param code - The submitted code.
 * @param at - The current time.
 * @returns The matching step, or `null` when the code is wrong.
 */
export function matchStep(secret: Uint8Array, code: string, at: Date): number | null {
  const current = totpStep(at)
  let matched: number | null = null
  for (let step = current - TOTP_DRIFT_STEPS; step <= current + TOTP_DRIFT_STEPS; step++) {
    if (step >= 0 && timingSafeEqual(hotp(secret, step), code)) {
      matched = step
    }
  }
  return matched
}

/**
 * The `otpauth://` URI an authenticator app reads from a QR code (the "Key URI format").
 *
 * The label is `<issuer>:<account>` and the issuer is repeated as a parameter, as the format
 * asks; both are percent-encoded. A colon inside the issuer or the account would be read as the
 * separator, so it is dropped from the issuer and encoded in the account.
 *
 * @param input - `issuer`: the app's name (the environment's `app.name`). `account`: the
 *   user's email address. `secret`: the secret bytes.
 * @returns The URI. It contains the secret: show it once and keep it nowhere.
 *
 * @example
 * ```ts
 * otpauthUri({ issuer: 'Acme', account: 'maya@acme.test', secret })
 * // 'otpauth://totp/Acme:maya%40acme.test?secret=…&issuer=Acme&algorithm=SHA1&digits=6&period=30'
 * ```
 */
export function otpauthUri(input: { issuer: string; account: string; secret: Uint8Array }): string {
  const issuer = encodeURIComponent(input.issuer.replaceAll(':', '').trim())
  const account = encodeURIComponent(input.account)
  return (
    `otpauth://totp/${issuer}:${account}?secret=${base32Encode(input.secret)}` +
    `&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`
  )
}
