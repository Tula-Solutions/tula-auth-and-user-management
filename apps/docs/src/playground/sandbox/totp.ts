// RFC 6238 (SHA-1, six digits, thirty seconds) over WebCrypto, so the sandbox's authenticator
// app produces the codes a real authenticator app would for the same secret.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * Decode an unpadded Base32 string.
 *
 * @param text - The Base32 text.
 * @returns The bytes.
 * @throws TypeError for a character that is not Base32.
 */
export function base32Decode(text: string): Uint8Array {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of text.toUpperCase().replace(/=+$/, '')) {
    const index = ALPHABET.indexOf(char)
    if (index === -1) {
      throw new TypeError('not Base32')
    }
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

/**
 * Encode bytes as unpadded Base32.
 *
 * @param bytes - The bytes.
 * @returns The Base32 text.
 */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    out += ALPHABET[(value << (5 - bits)) & 31]
  }
  return out
}

/** The length of a time step, in milliseconds. */
export const TOTP_STEP_MS = 30_000

/**
 * The code for one time step.
 *
 * @param secret - The Base32 secret.
 * @param step - The step number (`Math.floor(time / 30000)`).
 * @returns Six digits.
 */
export async function totpAt(secret: string, step: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    base32Decode(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  )
  const counter = new Uint8Array(8)
  new DataView(counter.buffer).setBigUint64(0, BigInt(step))
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter))
  const offset = (mac[19] as number) & 0x0f
  const binary =
    (((mac[offset] as number) & 0x7f) << 24) |
    ((mac[offset + 1] as number) << 16) |
    ((mac[offset + 2] as number) << 8) |
    (mac[offset + 3] as number)
  return String(binary % 1_000_000).padStart(6, '0')
}

/**
 * The code an authenticator app shows now.
 *
 * @param secret - The Base32 secret.
 * @param now - Epoch milliseconds.
 * @returns Six digits.
 */
export function totpNow(secret: string, now: number): Promise<string> {
  return totpAt(secret, Math.floor(now / TOTP_STEP_MS))
}

/**
 * Whether a code is right for the current step or one either side of it (the real service's
 * window).
 *
 * @param secret - The Base32 secret.
 * @param code - What the user typed.
 * @param now - Epoch milliseconds.
 * @returns The matching step, or `null`.
 */
export async function matchTotp(secret: string, code: string, now: number): Promise<number | null> {
  const current = Math.floor(now / TOTP_STEP_MS)
  for (const step of [current - 1, current, current + 1]) {
    if ((await totpAt(secret, step)) === code) {
      return step
    }
  }
  return null
}
