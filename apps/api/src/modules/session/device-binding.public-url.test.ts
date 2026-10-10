import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { createDpopProof, type DeviceKey, DPOP_HEADER, jwkThumbprint } from '@tula/contract'
import { createTulaClient, memoryStorage } from '@tula/core'
import type { AuthError } from '~/exceptions'
import { verifyProof } from '~/lib/dpop'
import * as logger from '~/lib/logger'
import * as DeviceBinding from '~/modules/session/device-binding'
import { createTestDeps, TEST_CONFIG, TEST_TENANT } from '~/testing'
import { generateSoftwareDeviceKey } from '~/testing/proofs'

// Device binding and the deployment's own address (ADR 0043, "What a client signs").
//
// A proof names `PUBLIC_URL` + the route's path, and the server refuses every spelling of
// that but one. So the server's own address has to be one a client can spell: where it is
// not, no client could ever comply, and the deployment says binding is unavailable instead
// of refusing every proof as invalid. What must never happen is the third thing: a client
// that does what the documentation says, and a server that answers `device.proof_invalid`.

const START = '/v1/client/sign-ups'
const tenant = TEST_TENANT

let key: DeviceKey

beforeAll(async () => {
  key = await generateSoftwareDeviceKey()
})

const spies: { mockRestore: () => void }[] = []
afterEach(() => {
  for (const spy of spies.splice(0)) {
    spy.mockRestore()
  }
})

const depsAt = (publicUrl: string) => createTestDeps({ config: { ...TEST_CONFIG, publicUrl } })

/** What `@tula/core` sends when it starts a sign-up against a `baseUrl`: the URL and the proof. */
async function sentByCore(baseUrl: string): Promise<{ url: string; proof: string }> {
  let sent: { url: string; proof: string } | undefined
  const tula = createTulaClient({
    publishableKey: 'tula_pk_dev_publishable0000000000000000000',
    baseUrl,
    client: 'ios',
    storage: memoryStorage(),
    deviceKey: key,
    fetch: (request) => {
      sent = { url: request.url, proof: request.headers.get(DPOP_HEADER) ?? '' }
      return Promise.resolve(
        Response.json({ status: 500, code: 'internal', detail: 'stub' }, { status: 500 })
      )
    },
  })
  await tula.signUp.start({ email: 'maya@northline.app', password: 'x' }).catch(() => {})
  if (!sent) {
    throw new Error('the client sent nothing')
  }
  return sent
}

const htuOf = (proof: string) =>
  (JSON.parse(Buffer.from(proof.split('.')[1] ?? '', 'base64url').toString()) as { htu: string })
    .htu

describe('for every spelling of PUBLIC_URL, what @tula/core signs verifies or binding is unavailable', () => {
  // The third column is what the deployment says of itself. The claim under test is the
  // agreement of the two sides, row by row; the column pins which side each spelling is on.
  test.each<[string, string, boolean]>([
    ['as the tests have it', TEST_CONFIG.publicUrl, true],
    ['an upper-case scheme and host', 'HTTPS://AUTH.Example.COM', true],
    ['the default port of https written out', 'https://auth.example.com:443', true],
    ['the default port of http written out', 'http://auth.example.com:80', true],
    ['another port', 'https://auth.example.com:8443', true],
    ['a trailing slash', 'http://localhost:3003/', true],
    ['a path prefix', 'https://example.com/auth', true],
    ['a path prefix and a trailing slash', 'https://example.com/auth/', true],
    [
      'a path prefix with a dot segment, which the parser removes',
      'https://example.com/a/../auth',
      true,
    ],
    ['an underscore in the host (a Compose service name)', 'http://tula_api:3003', true],
    ['a host that ends in a dot', 'https://auth.example.com.', true],
    ['an IPv4 address', 'http://127.0.0.1:3003', true],
    ['the IPv6 loopback', 'http://[::1]:3003', true],
    ['the IPv6 loopback written long', 'http://[0:0:0:0:0:0:0:1]:3003', true],
    ['an IPv6 address in upper case', 'http://[2001:DB8::1]:3003', true],
    ['an internationalised host', 'https://b\u{fc}cher.example', true],
    ['a path with a space', 'https://example.com/my api', false],
    ['a path with a percent-encoded space', 'https://example.com/my%20api', false],
    ['a path with a letter outside ASCII', 'https://example.com/caf\u{e9}', false],
  ])('%s', async (_name, publicUrl, available) => {
    const now = new Date()
    const deps = depsAt(publicUrl)
    const sent = await sentByCore(publicUrl)
    // The client calls the address it signs: there is one address, not two.
    expect(sent.url).toBe(htuOf(sent.proof))
    const verdict = await verifyProof(sent.proof, {
      method: 'POST',
      url: `${publicUrl.replace(/\/+$/, '')}${START}`,
      now,
    })
    expect(DeviceBinding.available(deps.config)).toBe(available)
    // Never a mismatch: a proof the server would refuse for its address, on a deployment
    // that says it can bind.
    expect(verdict.ok).toBe(available)
    if (!verdict.ok) {
      expect(verdict.reason).toBe('address')
    }
  })
})

describe('a PUBLIC_URL with an underscore in its host', () => {
  const PUBLIC_URL = 'http://tula_api:3003'

  test('binds: a proof the contract makes for it is accepted at a start', async () => {
    const deps = depsAt(PUBLIC_URL)
    const proof = await createDpopProof(key, {
      method: 'POST',
      url: `${PUBLIC_URL}${START}`,
      nonce: await DeviceBinding.nonce(deps, tenant),
      now: deps.clock.now().getTime(),
    })
    expect(
      await DeviceBinding.atStart(deps, tenant, {
        proof,
        method: 'POST',
        path: START,
        client: 'ios',
      })
    ).toEqual({
      thumbprint: await jwkThumbprint(key.publicJwk),
      nonce: await DeviceBinding.nonce(deps, tenant),
    })
  })
})

describe('a deployment whose own address no proof can name', () => {
  const PUBLIC_URL = 'https://example.com/my api'
  const start = (deps: ReturnType<typeof depsAt>, proof: string | undefined) =>
    DeviceBinding.atStart(deps, tenant, { proof, method: 'POST', path: START, client: 'ios' })
  const refused = async (promise: Promise<unknown>) =>
    (await promise.then(
      () => {
        throw new Error('expected a refusal')
      },
      (error: unknown) => error
    )) as AuthError

  test('a start with a proof is device.binding_not_supported, whatever the proof: never proof_invalid, never a nonce', async () => {
    const deps = depsAt(PUBLIC_URL)
    const remember = spyOn(deps.proofReplay, 'remember')
    spies.push(remember)
    const asTheParserWritesIt = await createDpopProof(key, {
      method: 'POST',
      url: `https://example.com/my%20api${START}`,
      nonce: await DeviceBinding.nonce(deps, tenant),
      now: deps.clock.now().getTime(),
    })
    const asTyped = await createDpopProof(key, {
      method: 'POST',
      url: `${PUBLIC_URL}${START}`,
      now: deps.clock.now().getTime(),
    })
    for (const proof of [asTheParserWritesIt, asTyped, 'not.a.proof', '']) {
      const error = await refused(start(deps, proof))
      expect(error.code).toBe('device.binding_not_supported')
      expect(error.status).toBe(400)
    }
    expect(remember).not.toHaveBeenCalled()
  })

  test('a start without a proof starts as before: the session is simply not bound', async () => {
    expect(await start(depsAt(PUBLIC_URL), undefined)).toBeNull()
  })

  test('the boot says so once, in fixed words that name the variable and never its value', () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    spies.push(warn)
    DeviceBinding.warnIfUnavailable(depsAt('https://secret-host.example/my api').config)
    expect(warn.mock.calls).toEqual([
      [
        'PUBLIC_URL cannot be named by a device-binding proof (its path holds a character a proof may not carry): device binding is unavailable on this deployment, and a start that brings a proof is refused.',
      ],
    ])
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-host')
  })

  test('and says nothing where binding is available', () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    spies.push(warn)
    DeviceBinding.warnIfUnavailable(depsAt('http://tula_api:3003').config)
    DeviceBinding.warnIfUnavailable(TEST_CONFIG)
    expect(warn).not.toHaveBeenCalled()
  })
})
