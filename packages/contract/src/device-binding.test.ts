import { describe, expect, test } from 'bun:test'
import {
  createDpopProof,
  type DevicePublicJwk,
  DPOP_ALGORITHMS,
  DPOP_HEADER,
  DPOP_NONCE_HEADER,
  DPOP_PROOF_TYPE,
  generateSoftwareDeviceKey,
  isDevicePublicJwk,
  isKeyThumbprint,
  jwkThumbprint,
  MAX_DPOP_PROOF_LENGTH,
} from './device-binding'

// The key of RFC 9449's examples, and the thumbprint the RFC gives for it (section 6.1).
const RFC_9449_KEY: DevicePublicJwk = {
  kty: 'EC',
  crv: 'P-256',
  x: 'l8tFrhx-34tV3hRICRDY9zCkDlpBhF42UQUfWVAWBFs',
  y: '9VE4jf_Ok_o64zbTTlcuNJajHmt6v9TDVrU0CdvGRDA',
}
const RFC_9449_THUMBPRINT = '0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I'

function decode(part: string | undefined): Record<string, unknown> {
  return JSON.parse(Buffer.from(part ?? '', 'base64url').toString())
}

function bytes(part: string | undefined): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(part ?? '', 'base64url'))
}

async function verified(proof: string, jwk: DevicePublicJwk): Promise<boolean> {
  const [head, body, signature] = proof.split('.')
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  )
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    bytes(signature),
    new TextEncoder().encode(`${head}.${body}`)
  )
}

describe('the names and the limits of a proof', () => {
  test('are RFC 9449’s: the two headers, the type, and ES256 alone', () => {
    expect(DPOP_HEADER).toBe('DPoP')
    expect(DPOP_NONCE_HEADER).toBe('DPoP-Nonce')
    expect(DPOP_PROOF_TYPE).toBe('dpop+jwt')
    expect([...DPOP_ALGORITHMS]).toEqual(['ES256'])
  })

  test('a proof the package makes is well under the longest one a server reads', async () => {
    const key = await generateSoftwareDeviceKey()
    const proof = await createDpopProof(key, {
      method: 'POST',
      url: 'https://auth.example.com/v1/client/sessions/refresh',
      nonce: 'n'.repeat(128),
    })
    expect(proof.length).toBeLessThan(MAX_DPOP_PROOF_LENGTH / 2)
  })
})

describe('isDevicePublicJwk', () => {
  test('accepts a public P-256 key and nothing else', () => {
    expect(isDevicePublicJwk(RFC_9449_KEY)).toBe(true)
  })

  test.each([
    ['a private member', { ...RFC_9449_KEY, d: RFC_9449_KEY.x }],
    ['a key id', { ...RFC_9449_KEY, kid: 'k1' }],
    ['another curve', { ...RFC_9449_KEY, crv: 'P-384' }],
    ['another key type', { ...RFC_9449_KEY, kty: 'RSA' }],
    ['a short coordinate', { ...RFC_9449_KEY, x: RFC_9449_KEY.x.slice(1) }],
    ['a long coordinate', { ...RFC_9449_KEY, y: `${RFC_9449_KEY.y}A` }],
    ['a padded coordinate', { ...RFC_9449_KEY, x: `${RFC_9449_KEY.x.slice(0, 42)}=` }],
    ['a coordinate that is not a string', { ...RFC_9449_KEY, x: 1 }],
    ['a second coordinate that is not a string', { ...RFC_9449_KEY, y: null }],
    ['a missing coordinate', { kty: 'EC', crv: 'P-256', x: RFC_9449_KEY.x }],
    ['a list', [RFC_9449_KEY]],
    ['a string', JSON.stringify(RFC_9449_KEY)],
    ['null', null],
    ['nothing', undefined],
  ])('refuses %s', (_name, value) => {
    expect(isDevicePublicJwk(value)).toBe(false)
  })
})

describe('jwkThumbprint', () => {
  test('is RFC 7638’s: the thumbprint RFC 9449 gives for its example key', async () => {
    expect(await jwkThumbprint(RFC_9449_KEY)).toBe(RFC_9449_THUMBPRINT)
  })

  test('does not depend on the order the members were written in', async () => {
    const reordered = { y: RFC_9449_KEY.y, x: RFC_9449_KEY.x, crv: 'P-256', kty: 'EC' } as const
    expect(await jwkThumbprint(reordered)).toBe(RFC_9449_THUMBPRINT)
  })

  test('differs for another key, and has the shape isKeyThumbprint accepts', async () => {
    const one = await jwkThumbprint((await generateSoftwareDeviceKey()).publicJwk)
    const two = await jwkThumbprint((await generateSoftwareDeviceKey()).publicJwk)
    expect(one).not.toBe(two)
    expect(isKeyThumbprint(one)).toBe(true)
    expect(isKeyThumbprint(two)).toBe(true)
  })
})

describe('isKeyThumbprint', () => {
  test.each([
    ['too short', RFC_9449_THUMBPRINT.slice(1)],
    ['too long', `${RFC_9449_THUMBPRINT}A`],
    ['padded', `${RFC_9449_THUMBPRINT.slice(0, 42)}=`],
    ['base64, not base64url', `${RFC_9449_THUMBPRINT.slice(0, 42)}+`],
    ['not a string', 43],
    ['nothing', undefined],
  ])('refuses one that is %s', (_name, value) => {
    expect(isKeyThumbprint(value)).toBe(false)
  })
})

describe('createDpopProof', () => {
  test('is a signed dpop+jwt with the public key in its header and the five claims', async () => {
    const key = await generateSoftwareDeviceKey()
    const proof = await createDpopProof(key, {
      method: 'POST',
      url: 'https://auth.example.com/v1/client/sessions/refresh',
      nonce: 'server-nonce',
      jti: 'one',
      now: 1_790_000_000_999,
    })
    const [head, body] = proof.split('.')
    expect(proof.split('.')).toHaveLength(3)
    expect(decode(head)).toEqual({ typ: 'dpop+jwt', alg: 'ES256', jwk: key.publicJwk })
    expect(decode(body)).toEqual({
      htm: 'POST',
      htu: 'https://auth.example.com/v1/client/sessions/refresh',
      iat: 1_790_000_000,
      jti: 'one',
      nonce: 'server-nonce',
    })
    expect(await verified(proof, key.publicJwk)).toBe(true)
  })

  test('without a nonce has no nonce claim, and takes the time and a random id itself', async () => {
    const key = await generateSoftwareDeviceKey()
    const before = Math.floor(Date.now() / 1000)
    const input = { method: 'POST', url: 'https://auth.example.com/v1/client/sign-ins' }
    const first = decode((await createDpopProof(key, input)).split('.')[1])
    const second = decode((await createDpopProof(key, input)).split('.')[1])
    expect(first).not.toHaveProperty('nonce')
    expect(first.iat).toBeGreaterThanOrEqual(before)
    expect(first.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000))
    expect(first.jti).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(second.jti).not.toBe(first.jti)
  })

  test('signs with whatever key it is given: a key of the caller’s own is asked once', async () => {
    const software = await generateSoftwareDeviceKey()
    const signedData: Uint8Array[] = []
    const proof = await createDpopProof(
      {
        publicJwk: software.publicJwk,
        sign(data) {
          signedData.push(data)
          return software.sign(data)
        },
      },
      { method: 'POST', url: 'https://auth.example.com/v1/client/sign-ins' }
    )
    expect(signedData).toHaveLength(1)
    expect(new TextDecoder().decode(signedData[0])).toBe(proof.slice(0, proof.lastIndexOf('.')))
  })
})

describe('generateSoftwareDeviceKey', () => {
  test('gives a public P-256 key and a 64-byte signature, and a new key every time', async () => {
    const key = await generateSoftwareDeviceKey()
    const other = await generateSoftwareDeviceKey()
    expect(isDevicePublicJwk(key.publicJwk)).toBe(true)
    expect(key.publicJwk).not.toEqual(other.publicJwk)
    expect(await key.sign(new TextEncoder().encode('data'))).toHaveLength(64)
  })

  test('hands out nothing of the private half', async () => {
    const key = await generateSoftwareDeviceKey()
    expect(Object.keys(key).sort()).toEqual(['publicJwk', 'sign'])
    expect(JSON.stringify(key)).not.toContain('"d"')
  })

  test('a proof signed by one key does not verify under another', async () => {
    const key = await generateSoftwareDeviceKey()
    const other = await generateSoftwareDeviceKey()
    const proof = await createDpopProof(key, { method: 'POST', url: 'https://a.example/x' })
    expect(await verified(proof, other.publicJwk)).toBe(false)
  })
})
