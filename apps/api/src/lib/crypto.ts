import { timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto'

/**
 * Generate a URL-safe random token from the CSPRNG.
 *
 * @param bytes - Entropy in bytes (default 32 = 256 bits).
 * @returns The token, base64url-encoded without padding.
 * @throws RangeError when `bytes` is not an integer from 16 to 1024.
 *
 * @example
 * ```ts
 * const secret = randomToken() // 43 characters
 * ```
 */
export function randomToken(bytes = 32): string {
  // Below 128 bits a token is guessable offline; the cap stops accidental huge allocations.
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 1024) {
    throw new RangeError('randomToken: bytes must be an integer from 16 to 1024')
  }
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url')
}

/**
 * SHA-256 of a UTF-8 string, hex-encoded.
 *
 * Only for **high-entropy** secrets (API keys, refresh tokens): a plain hash of a guessable value
 * such as a 6-digit code is reversible by brute force and needs a keyed HMAC instead.
 *
 * @param value - The secret to hash.
 * @returns 64 lowercase hex characters.
 */
export function sha256Hex(value: string): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex')
}

/**
 * Compare two secrets in constant time.
 *
 * A length mismatch returns `false` immediately. That reveals only the length, which is fixed for
 * the hashes and tokens this is used on.
 *
 * @param a - First value.
 * @param b - Second value.
 * @returns Whether they are byte-for-byte equal.
 */
export function timingSafeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const left = typeof a === 'string' ? Buffer.from(a) : a
  const right = typeof b === 'string' ? Buffer.from(b) : b
  if (left.byteLength !== right.byteLength) {
    return false
  }
  return nodeTimingSafeEqual(left, right)
}

/**
 * Generate a numeric code from the CSPRNG, e.g. a 6-digit email verification code.
 *
 * Uses rejection sampling so every digit is uniformly distributed (a plain `% 10` on a byte
 * would favour 0–5). Such codes are low-entropy: store them with a keyed hash and cap attempts.
 *
 * @param length - Number of digits, 4 to 12.
 * @returns The code, zero-padded (leading zeros are valid).
 * @throws RangeError when `length` is not an integer from 4 to 12.
 *
 * @example
 * ```ts
 * const code = randomDigits(6) // '049213'
 * ```
 */
export function randomDigits(length: number): string {
  if (!Number.isInteger(length) || length < 4 || length > 12) {
    throw new RangeError('randomDigits: length must be an integer from 4 to 12')
  }
  let digits = ''
  while (digits.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      // 250 is the largest multiple of 10 that fits in a byte; larger values would bias the result.
      if (byte < 250 && digits.length < length) {
        digits += String(byte % 10)
      }
    }
  }
  return digits
}
