import { describe, expect, test } from 'bun:test'
import { createSecretBox } from '~/lib/secret-box'

const box = createSecretBox('11'.repeat(32))
const secret = new TextEncoder().encode('private key bytes')

describe('createSecretBox', () => {
  test('round-trips a secret', async () => {
    const sealed = await box.seal('signing-keys', secret, 'key-1|env-1')
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/)
    expect(await box.open('signing-keys', sealed, 'key-1|env-1')).toEqual(secret)
  })

  test('uses a fresh IV every time', async () => {
    const a = await box.seal('p', secret, 'aad')
    const b = await box.seal('p', secret, 'aad')
    expect(a).not.toBe(b)
  })

  test('never contains the plaintext', async () => {
    const sealed = await box.seal('p', secret, 'aad')
    expect(Buffer.from(sealed.split('.')[2] ?? '', 'base64url').toString()).not.toContain('private')
  })

  test.each<[string, (sealed: string) => Promise<Uint8Array>]>([
    [
      'different associated data (ciphertext moved to another row)',
      (s) => box.open('p', s, 'key-2|env-1'),
    ],
    ['a different purpose', (s) => box.open('other', s, 'key-1|env-1')],
    ['a different master key', (s) => createSecretBox('22'.repeat(32)).open('p', s, 'key-1|env-1')],
    [
      'a flipped ciphertext bit',
      (s) => {
        const [v, iv, ct = ''] = s.split('.')
        const bytes = Buffer.from(ct, 'base64url')
        bytes[0] = (bytes[0] ?? 0) ^ 1
        return box.open('p', `${v}.${iv}.${bytes.toString('base64url')}`, 'key-1|env-1')
      },
    ],
    ['an unknown version', (s) => box.open('p', s.replace(/^v1\./, 'v2.'), 'key-1|env-1')],
    ['a truncated value', () => box.open('p', 'v1.abc', 'key-1|env-1')],
    ['extra segments', (s) => box.open('p', `${s}.x`, 'key-1|env-1')],
  ])('refuses to open with %s', async (_, open) => {
    const sealed = await box.seal('p', secret, 'key-1|env-1')
    await expect(open(sealed)).rejects.toThrow()
  })

  test.each(['', 'zz'.repeat(32), 'ab'.repeat(16)])('rejects master key %p', (key) => {
    expect(() => createSecretBox(key)).toThrow('64 hex characters')
  })
})
