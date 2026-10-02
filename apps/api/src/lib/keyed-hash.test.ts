import { describe, expect, test } from 'bun:test'
import { createKeyedHash } from '~/lib/keyed-hash'

const KEY_A = 'ab'.repeat(32)
const KEY_B = 'cd'.repeat(32)

describe('createKeyedHash', () => {
  test('is deterministic and returns 64 hex characters', async () => {
    const hash = createKeyedHash(KEY_A)
    const first = await hash.hmac('verification-codes', 'token-1:123456')
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(await hash.hmac('verification-codes', 'token-1:123456')).toBe(first)
    expect(await createKeyedHash(KEY_A).hmac('verification-codes', 'token-1:123456')).toBe(first)
  })

  test('changes with the message, the purpose and the master key', async () => {
    const hash = createKeyedHash(KEY_A)
    const base = await hash.hmac('verification-codes', 'token-1:123456')
    expect(await hash.hmac('verification-codes', 'token-1:123457')).not.toBe(base)
    expect(await hash.hmac('verification-codes', 'token-2:123456')).not.toBe(base)
    expect(await hash.hmac('refresh-tokens', 'token-1:123456')).not.toBe(base)
    expect(await createKeyedHash(KEY_B).hmac('verification-codes', 'token-1:123456')).not.toBe(base)
  })

  test('is not a plain SHA-256 of the message', async () => {
    const message = 'token-1:123456'
    const plain = new Bun.CryptoHasher('sha256').update(message).digest('hex')
    expect(await createKeyedHash(KEY_A).hmac('verification-codes', message)).not.toBe(plain)
  })

  test.each(['', 'abc', 'zz'.repeat(32), 'ab'.repeat(31)])('rejects the master key %p', (key) => {
    expect(() => createKeyedHash(key)).toThrow('64 hex characters')
  })
})
