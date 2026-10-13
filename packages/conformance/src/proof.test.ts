import { describe, expect, test } from 'bun:test'
import { type DevicePublicJwk, jwkThumbprint } from '@tula/contract'
import { runScenario, type Target } from './runner'
import { type Scenario, ScenarioSchema } from './scenario'

// The `proof` of a request (device binding): a DPoP proof the runner makes with a software
// key that lives for one run.

type Headers = Record<string, string>

function fakeTarget(overrides: Partial<Target> = {}) {
  const seen: { path: string; headers: Headers }[] = []
  const target: Target = {
    baseUrl: 'http://tula.test',
    publishableKey: 'tula_pk_test',
    fetch: async (request) => {
      seen.push({
        path: request.url.replace(/^https?:\/\/[^/]+/, ''),
        headers: Object.fromEntries(request.headers),
      })
      return new Response('{}', { status: 200, headers: { 'DPoP-Nonce': 'server-nonce' } })
    },
    emailCode: async () => '123459',
    wait: async () => {},
    ...overrides,
  }
  return { target, seen }
}

const scenario = (steps: unknown[]): Scenario =>
  ScenarioSchema.parse({ name: 'test', description: 'A test scenario.', steps })

const refresh = (extra: object = {}, name = 'refresh') => ({
  name,
  request: { method: 'POST', path: '/v1/client/sessions/refresh', body: {}, ...extra },
  expect: { status: 200 },
})

interface Read {
  header: { typ?: string; alg?: string; jwk: DevicePublicJwk }
  payload: Record<string, unknown>
  /** Whether the signature is the carried key's. */
  verified: boolean
}

function bytes(segment: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(Buffer.from(segment, 'base64url'))
}

/** A proof, decoded and checked the way a server would. */
async function read(proof: string | undefined): Promise<Read> {
  const [head = '', body = '', signature = ''] = (proof ?? '').split('.')
  const header = JSON.parse(Buffer.from(head, 'base64url').toString()) as Read['header']
  const key = await crypto.subtle.importKey(
    'jwk',
    header.jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  )
  return {
    header,
    payload: JSON.parse(Buffer.from(body, 'base64url').toString()),
    verified: await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      bytes(signature),
      new TextEncoder().encode(`${head}.${body}`)
    ),
  }
}

describe('a request with a proof', () => {
  test('carries a DPoP header: a signed dpop+jwt for its method and its path under the base URL', async () => {
    const { target, seen } = fakeTarget({ now: () => 1_790_000_000_000 })
    const result = await runScenario(
      scenario([refresh({ proof: { key: 'device', nonce: 'n1' } })]),
      target
    )
    expect(result.status).toBe('passed')
    const proof = seen[0]?.headers.dpop
    const { header, payload, verified } = await read(proof)
    expect(header).toMatchObject({ typ: 'dpop+jwt', alg: 'ES256' })
    expect(Object.keys(header.jwk ?? {}).sort()).toEqual(['crv', 'kty', 'x', 'y'])
    expect(payload).toMatchObject({
      htm: 'POST',
      htu: 'http://tula.test/v1/client/sessions/refresh',
      iat: 1_790_000_000,
      nonce: 'n1',
    })
    expect(payload.jti).toBeString()
    expect(verified).toBe(true)
  })

  test('names the target’s public URL when it has one, on either instance, without the query', async () => {
    const { target, seen } = fakeTarget({
      publicUrl: 'https://auth.example.com',
      second: {
        baseUrl: 'http://second.tula.test',
        fetch: async (request) => {
          seen.push({ path: 'second', headers: Object.fromEntries(request.headers) })
          return new Response('{}', { status: 200 })
        },
      },
    })
    await runScenario(
      scenario([
        refresh({ proof: { key: 'device' }, path: '/v1/client/sign-ins?x=1' }),
        refresh({ proof: { key: 'device' }, instance: 'second' }, 'second'),
      ]),
      target
    )
    expect((await read(seen[0]?.headers.dpop)).payload.htu).toBe(
      'https://auth.example.com/v1/client/sign-ins'
    )
    expect(seen[1]?.path).toBe('second')
    expect((await read(seen[1]?.headers.dpop)).payload.htu).toBe(
      'https://auth.example.com/v1/client/sessions/refresh'
    )
  })

  test('a name is one key for the run, two names are two keys, and a new run has new keys', async () => {
    const { target, seen } = fakeTarget()
    const steps = scenario([
      refresh({ proof: { key: 'device' } }, 'a'),
      refresh({ proof: { key: 'device' } }, 'b'),
      refresh({ proof: { key: 'other' } }, 'c'),
    ])
    await runScenario(steps, target)
    await runScenario(steps, target)
    const thumbprints = []
    for (const request of seen) {
      const { header, verified } = await read(request.headers.dpop)
      expect(verified).toBe(true)
      thumbprints.push(await jwkThumbprint(header.jwk))
    }
    const [a, b, c, a2, b2, c2] = thumbprints
    expect(a).toBe(b)
    expect(c).not.toBe(a)
    expect(a2).toBe(b2)
    expect(a2).not.toBe(a)
    expect(c2).not.toBe(c)
  })

  test('every request gets a new proof, also under `times`', async () => {
    const { target, seen } = fakeTarget()
    await runScenario(scenario([{ ...refresh({ proof: { key: 'device' } }), times: 3 }]), target)
    const proofs = seen.map((request) => request.headers.dpop)
    expect(new Set(proofs).size).toBe(3)
    const ids = await Promise.all(proofs.map(async (proof) => (await read(proof)).payload.jti))
    expect(new Set(ids).size).toBe(3)
  })

  test('the nonce is filled from a captured header, and left out when not given', async () => {
    const { target, seen } = fakeTarget()
    await runScenario(
      scenario([
        { ...refresh({ proof: { key: 'device' } }), captureHeaders: { nonce: 'DPoP-Nonce' } },
        refresh({ proof: { key: 'device', nonce: '{{nonce}}' } }, 'again'),
      ]),
      target
    )
    expect((await read(seen[0]?.headers.dpop)).payload).not.toHaveProperty('nonce')
    expect((await read(seen[1]?.headers.dpop)).payload.nonce).toBe('server-nonce')
  })

  test('a captured proof can be sent again as a header: the very same one', async () => {
    const { target, seen } = fakeTarget()
    const result = await runScenario(
      scenario([
        refresh({ proof: { key: 'device', capture: 'used' } }),
        refresh({ headers: { DPoP: '{{used}}' } }, 'replay'),
      ]),
      target
    )
    expect(result.status).toBe('passed')
    expect(seen[1]?.headers.dpop).toBe(seen[0]?.headers.dpop as string)
  })

  test('a request without one carries no DPoP header', async () => {
    const { target, seen } = fakeTarget()
    await runScenario(scenario([refresh()]), target)
    expect(seen[0]?.headers).not.toHaveProperty('dpop')
  })
})

describe('the scenario format', () => {
  const parse = (request: object) =>
    ScenarioSchema.safeParse({
      name: 'test',
      description: 'A test scenario.',
      steps: [
        { name: 's', request: { method: 'POST', path: '/x', ...request }, expect: { status: 200 } },
      ],
    })

  test('refuses a proof together with a DPoP header, whatever its case', () => {
    for (const name of ['DPoP', 'dpop', 'DPOP']) {
      expect(parse({ proof: { key: 'device' }, headers: { [name]: 'x' } }).success).toBe(false)
    }
    expect(parse({ headers: { DPoP: 'x' } }).success).toBe(true)
    expect(parse({ proof: { key: 'device' }, headers: { Origin: 'https://a.test' } }).success).toBe(
      true
    )
  })

  test.each([
    ['no key name', {}],
    ['a key name that is not a name', { key: 'my key' }],
    ['a key in the file', { key: 'device', jwk: { kty: 'EC' } }],
    ['a private key in the file', { key: 'device', privateKey: 'x' }],
    ['an empty capture', { key: 'device', capture: '' }],
  ])('refuses %s', (_name, proof) => {
    expect(parse({ proof }).success).toBe(false)
  })
})
