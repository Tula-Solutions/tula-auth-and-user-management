import { beforeAll, describe, expect, spyOn, test } from 'bun:test'
import {
  createDpopProof,
  type DeviceKey,
  jwkThumbprint,
  MAX_DPOP_PROOF_LENGTH,
} from '@tula/contract'
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { DPOP_IAT_TOLERANCE_MS, verifyProof } from '~/lib/dpop'
import * as logger from '~/lib/logger'
import { addressOf, craftProof, generateSoftwareDeviceKey, REFRESH_PATH } from '~/testing/proofs'

const NOW = new Date('2026-10-08T09:30:00.000Z')
const expected = { method: 'POST', url: addressOf(REFRESH_PATH), now: NOW }
let key: DeviceKey
let other: DeviceKey

beforeAll(async () => {
  key = await generateSoftwareDeviceKey()
  other = await generateSoftwareDeviceKey()
})

const craft = (wrong: Parameters<typeof craftProof>[2] = {}, nonce?: string) =>
  craftProof(key, { now: NOW, nonce }, wrong)

async function reason(proof: string, against = expected): Promise<string> {
  const verdict = await verifyProof(proof, against)
  return verdict.ok ? 'accepted' : verdict.reason
}

describe('a valid proof', () => {
  test('is accepted, and says which key signed it, its id and its nonce', async () => {
    const proof = await craft({ payload: { jti: 'a-unique-id-of-16' } }, 'server-nonce')
    expect(await verifyProof(proof, expected)).toEqual({
      ok: true,
      proof: {
        thumbprint: await jwkThumbprint(key.publicJwk),
        jti: 'a-unique-id-of-16',
        nonce: 'server-nonce',
      },
    })
  })

  test('the thumbprint is RFC 7638’s, as another implementation computes it', async () => {
    const verdict = await verifyProof(await craft(), expected)
    expect(verdict.ok && verdict.proof.thumbprint).toBe(
      await calculateJwkThumbprint(key.publicJwk, 'sha256')
    )
  })

  test('one made the way a client makes it is accepted, with no nonce at all', async () => {
    const proof = await createDpopProof(key, {
      method: 'POST',
      url: expected.url,
      now: NOW.getTime(),
    })
    const verdict = await verifyProof(proof, expected)
    expect(verdict.ok && verdict.proof.nonce).toBeNull()
  })

  test('a proof another library signed with the same key is accepted', async () => {
    const pair = await generateKeyPair('ES256', { extractable: true })
    const { kty, crv, x, y } = await exportJWK(pair.publicKey)
    const proof = await new SignJWT({ htm: 'POST', htu: expected.url, jti: Bun.randomUUIDv7() })
      .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: { kty, crv, x, y } })
      .setIssuedAt(Math.floor(NOW.getTime() / 1000))
      .sign(pair.privateKey)
    expect(await reason(proof)).toBe('accepted')
  })

  test('the address is compared as the URL parser reads it: case of the host, a default port', async () => {
    const url = 'https://Auth.Example.com:443/v1/client/sessions/refresh'
    const proof = await craft({ payload: { htu: url } })
    expect(
      await reason(proof, {
        ...expected,
        url: 'https://auth.example.com/v1/client/sessions/refresh',
      })
    ).toBe('accepted')
  })
})

describe('what is not a proof', () => {
  test.each([
    ['an empty string', ''],
    ['one segment', 'abc'],
    ['two segments', 'abc.def'],
    ['four segments', 'a.b.c.d'],
    ['a header that is not base64url JSON', '!!!.e30.sig'],
    ['two proofs in one header, as a proxy joins them', 'a.b.c, d.e.f'],
  ])('%s is malformed', async (_name, value) => {
    expect(await reason(value)).toBe('malformed')
  })

  test('a proof one character over the cap is refused unread', async () => {
    const proof = await craft({ payload: { pad: 'x'.repeat(MAX_DPOP_PROOF_LENGTH) } })
    expect(proof.length).toBeGreaterThan(MAX_DPOP_PROOF_LENGTH)
    expect(await reason(proof)).toBe('malformed')
    // The same content under the cap is read: the cap is what refused it.
    expect(await reason(await craft({ payload: { pad: 'x'.repeat(100) } }))).toBe('accepted')
  })

  test.each([
    ['a JWT', 'JWT'],
    ['an access token type', 'at+jwt'],
    ['another case', 'DPoP+JWT'],
    ['none', undefined],
  ])('a token of type %s is not a proof', async (_name, typ) => {
    expect(await reason(await craft({ header: { typ } }))).toBe('type')
  })

  test.each([
    ['none', 'none'],
    ['a symmetric algorithm', 'HS256'],
    ['EdDSA, which signs access tokens', 'EdDSA'],
    ['RS256', 'RS256'],
    ['ES384', 'ES384'],
    ['ES256K', 'ES256K'],
    ['a missing one', undefined],
    ['a list', ['ES256']],
  ])('an alg off the list is refused: %s', async (_name, alg) => {
    expect(await reason(await craft({ header: { alg } }))).toBe('algorithm')
  })

  test('a jwk with a private member is refused', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
    ])
    const { kty, crv, x, y, d } = await crypto.subtle.exportKey('jwk', pair.privateKey)
    expect(typeof d).toBe('string')
    const exposed: DeviceKey = {
      publicJwk: { kty, crv, x, y } as DeviceKey['publicJwk'],
      async sign(data) {
        return new Uint8Array(
          await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            pair.privateKey,
            new Uint8Array(data)
          )
        )
      },
    }
    // The signature is right and the public half is right: the private member alone refuses it.
    expect(
      await reason(
        await craftProof(exposed, { now: NOW }, { header: { jwk: { kty, crv, x, y, d } } })
      )
    ).toBe('key')
    expect(await reason(await craftProof(exposed, { now: NOW }))).toBe('accepted')
  })

  test.each([
    ['no jwk', undefined],
    ['a string', 'key'],
    ['a list', [1]],
    ['null', null],
    [
      'an extra member',
      { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'A'.repeat(43), kid: '1' },
    ],
    ['another curve', { kty: 'EC', crv: 'P-384', x: 'A'.repeat(43), y: 'A'.repeat(43) }],
    ['another key type', { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43), y: 'A'.repeat(43) }],
    ['a short coordinate', { kty: 'EC', crv: 'P-256', x: 'A'.repeat(42), y: 'A'.repeat(43) }],
    ['a symmetric key', { kty: 'oct', k: 'A'.repeat(43) }],
    [
      'coordinates that are no point on the curve',
      { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'A'.repeat(43) },
    ],
  ])('a header with %s for a key is refused', async (_name, jwk) => {
    expect(await reason(await craft({ header: { jwk } }))).toBe('key')
  })

  test('a proof signed by another key than the one it carries is refused', async () => {
    expect(await reason(await craft({ signWith: other }))).toBe('signature')
  })

  test('a changed payload under the old signature is refused', async () => {
    const proof = await craft()
    const [header, , signature] = proof.split('.')
    const forged = Buffer.from(
      JSON.stringify({ htm: 'POST', htu: expected.url, iat: 1, jti: 'x'.repeat(16) })
    ).toString('base64url')
    expect(await reason(`${header}.${forged}.${signature}`)).toBe('signature')
  })

  test.each([
    ['an empty signature', ''],
    ['a signature of the wrong length', 'AAAA'],
    ['zeros', Buffer.alloc(64).toString('base64url')],
  ])('%s is refused', async (_name, signature) => {
    expect(await reason(await craft({ signature }))).not.toBe('accepted')
  })

  test('a payload that is not an object is refused', async () => {
    const signed = `${Buffer.from(
      JSON.stringify({ typ: 'dpop+jwt', alg: 'ES256', jwk: key.publicJwk })
    ).toString('base64url')}.${Buffer.from('[1,2]').toString('base64url')}`
    const signature = Buffer.from(await key.sign(new TextEncoder().encode(signed))).toString(
      'base64url'
    )
    expect(await reason(`${signed}.${signature}`)).toBe('malformed')
  })
})

describe('a proof for another request', () => {
  test.each([
    ['GET', 'GET'],
    ['lower case', 'post'],
    ['missing', undefined],
    ['a list', ['POST']],
  ])('another method is refused: %s', async (_name, htm) => {
    expect(await reason(await craft({ payload: { htm } }))).toBe('method')
  })

  test.each([
    ['another route', addressOf('/v1/client/sign-ins')],
    ['another host', 'https://evil.example/v1/client/sessions/refresh'],
    ['another scheme', addressOf(REFRESH_PATH).replace('http://', 'https://')],
    ['another port', addressOf(REFRESH_PATH).replace(':3003', ':3004')],
    ['a longer path', `${addressOf(REFRESH_PATH)}/x`],
    ['a trailing slash', `${addressOf(REFRESH_PATH)}/`],
    ['a query', `${addressOf(REFRESH_PATH)}?a=1`],
    ['an empty query', `${addressOf(REFRESH_PATH)}?`],
    ['a fragment', `${addressOf(REFRESH_PATH)}#a`],
    ['credentials in front of the host', addressOf(REFRESH_PATH).replace('://', '://user@')],
    ['a path only', REFRESH_PATH],
    ['not a URL', 'refresh'],
    ['missing', undefined],
    ['a number', 7],
  ])('another address is refused: %s', async (_name, htu) => {
    expect(await reason(await craft({ payload: { htu } }))).toBe('address')
  })
})

describe('when a proof was made', () => {
  const at = (ms: number) => ({ payload: { iat: Math.floor((NOW.getTime() + ms) / 1000) } })

  test('the edge of the window is accepted, a second past it refused, both ways', async () => {
    expect(await reason(await craft(at(DPOP_IAT_TOLERANCE_MS)))).toBe('accepted')
    expect(await reason(await craft(at(DPOP_IAT_TOLERANCE_MS + 1000)))).toBe('issued_at')
    expect(await reason(await craft(at(-DPOP_IAT_TOLERANCE_MS)))).toBe('accepted')
    expect(await reason(await craft(at(-DPOP_IAT_TOLERANCE_MS - 1000)))).toBe('issued_at')
  })

  test.each([
    ['missing', undefined],
    ['a string', '1790000000'],
    ['a fraction', 1790000000.5],
    ['milliseconds', NOW.getTime()],
    ['zero', 0],
    ['beyond what a number holds', 1e300],
  ])('an iat that is %s is refused', async (_name, iat) => {
    expect(await reason(await craft({ payload: { iat } }))).toBe('issued_at')
  })
})

describe('a proof’s id and nonce', () => {
  test.each([
    ['missing', undefined],
    ['too short', 'x'.repeat(15)],
    ['too long', 'x'.repeat(129)],
    ['with a space', 'a unique id of 16 chars'],
    ['with a colon', 'environment:thumbprint:jti'],
    ['a number', 1234567890123456],
  ])('a jti that is %s is refused', async (_name, jti) => {
    expect(await reason(await craft({ payload: { jti } }))).toBe('id')
  })

  test('16 and 128 characters are both accepted', async () => {
    expect(await reason(await craft({ payload: { jti: 'x'.repeat(16) } }))).toBe('accepted')
    expect(await reason(await craft({ payload: { jti: 'x'.repeat(128) } }))).toBe('accepted')
  })

  test.each([
    ['a number', 7],
    ['an object', {}],
    ['longer than a nonce is', 'n'.repeat(129)],
  ])('a nonce that is %s is refused', async (_name, nonce) => {
    expect(await reason(await craft({ payload: { nonce } }))).toBe('nonce')
  })
})

test('nothing of a proof is logged, accepted or refused', async () => {
  const spies = (['debug', 'info', 'warn', 'error'] as const).map((level) =>
    spyOn(logger, level).mockImplementation(() => {})
  )
  try {
    await verifyProof(await craft(), expected)
    await verifyProof(await craft({ signWith: other }), expected)
    await verifyProof('not.a.proof', expected)
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled()
    }
  } finally {
    for (const spy of spies) {
      spy.mockRestore()
    }
  }
})
