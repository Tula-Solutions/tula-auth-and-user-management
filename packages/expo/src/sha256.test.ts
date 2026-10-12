import { describe, expect, test } from 'bun:test'
import { appleNonceClaim } from '../../../apps/api/src/adapters/oauth/apple'
import { base64Bytes, base64url, utf8Bytes } from './bytes'
import { sha256Hex } from './sha256'

// The hash an app hands Apple's sheet, and the byte helpers, written out because a React
// Native engine may have no `crypto.subtle`, `TextEncoder` or `atob`. Each is held to the
// runtime's own here, where the runtime has them.

async function webCryptoHex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const TEXTS = [
  '',
  'abc',
  // One block exactly needs a second for the padding (55, 56, 63, 64 and 65 bytes).
  'a'.repeat(55),
  'a'.repeat(56),
  'a'.repeat(63),
  'a'.repeat(64),
  'a'.repeat(65),
  'a'.repeat(1000),
  // A nonce as the server makes one: 32 bytes as base64url.
  'q0tJ8lHk0f2oZ4b1n3mXyW7vUeC5sRaD9gPpLhTiKjM',
  'żółć and 日本語 and 🙂',
  '\ud800 alone',
]

describe('sha256Hex', () => {
  test('the standard vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
    )
  })

  test.each(TEXTS)('agrees with WebCrypto for %j', async (text) => {
    expect(sha256Hex(text)).toBe(await webCryptoHex(text))
  })

  test('is what the server compares an Apple token’s nonce with', async () => {
    for (const nonce of ['q0tJ8lHk0f2oZ4b1n3mXyW7vUeC5sRaD9gPpLhTiKjM', 'n']) {
      expect(sha256Hex(nonce)).toBe(await appleNonceClaim(nonce))
    }
  })
})

describe('the byte helpers', () => {
  test.each(TEXTS)('utf8Bytes agrees with TextEncoder for %j', (text) => {
    expect(utf8Bytes(text)).toEqual([...new TextEncoder().encode(text)])
  })

  test('base64url agrees with the runtime’s, for every length of tail', () => {
    for (let length = 0; length < 40; length += 1) {
      const bytes = Uint8Array.from({ length }, (_, at) => (at * 37 + 250) & 0xff)
      const expected = Buffer.from(bytes).toString('base64url')
      expect(base64url(bytes)).toBe(expected)
      expect(base64Bytes(expected)).toEqual(bytes)
      // Padded, and in the alphabet that is not URL-safe.
      expect(base64Bytes(Buffer.from(bytes).toString('base64'))).toEqual(bytes)
    }
  })

  test('base64Bytes refuses what is not base64', () => {
    for (const text of ['a', 'ab*d', 'ab cd', 'abcde', 'é===']) {
      expect(base64Bytes(text), text).toBeNull()
    }
  })
})
