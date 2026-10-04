import { describe, expect, test } from 'bun:test'
import { isEcP256PrivateKey, pkcs8FromPem } from '~/lib/pkcs8'

type KeyAlgorithm = { name: string } & Record<string, unknown>

async function pem(algorithm: KeyAlgorithm): Promise<string> {
  const pair = (await crypto.subtle.generateKey(algorithm as never, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString(
    'base64'
  )
  return `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)?.join('\n')}\n-----END PRIVATE KEY-----\n`
}

describe('pkcs8', () => {
  test('reads the DER bytes of a PEM, whatever its line breaks', async () => {
    const key = await pem({ name: 'ECDSA', namedCurve: 'P-256' })
    const bytes = pkcs8FromPem(key)
    expect(bytes[0]).toBe(0x30)
    expect(pkcs8FromPem(key.replace(/\n/g, '\r\n'))).toEqual(bytes)
    expect(await isEcP256PrivateKey(key)).toBe(true)
  })

  test.each([
    ['empty text', ''],
    [
      'an encrypted key',
      '-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----',
    ],
    ['a SEC1 key', '-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----'],
    ['text around a key', 'x -----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY----- y'],
  ] as [string, string][])('refuses %s without quoting it', async (_name, text) => {
    expect(() => pkcs8FromPem(text)).toThrow('pkcs8: not a PKCS#8 PEM private key')
    expect(await isEcP256PrivateKey(text)).toBe(false)
  })

  test('a key of another kind or curve is not a P-256 key', async () => {
    expect(await isEcP256PrivateKey(await pem({ name: 'ECDSA', namedCurve: 'P-384' }))).toBe(false)
    expect(
      await isEcP256PrivateKey(
        await pem({
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        })
      )
    ).toBe(false)
    expect(
      await isEcP256PrivateKey('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----')
    ).toBe(false)
  })
})
