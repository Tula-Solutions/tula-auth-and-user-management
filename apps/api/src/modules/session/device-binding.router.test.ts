import { beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  createDpopProof,
  type DeviceKey,
  FLOW_ATTEMPT_HEADER,
  type FlowAttempt,
  jwkThumbprint,
} from '@tula/contract'
import { decodeJwt } from 'jose'
import { createApp } from '~/index'
import * as DeviceBinding from '~/modules/session/device-binding'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'
import {
  DPOP_HEADER,
  DPOP_NONCE_HEADER,
  generateSoftwareDeviceKey,
  proofFor,
  REFRESH_PATH,
} from '~/testing/proofs'

// Device binding over HTTP (ADR 0043): the headers, the challenge, the starts that bind and
// the refresh route. The rules themselves are tested in `device-binding.test.ts`.

const PK = 'tula_pk_dev_publishable0000000000000000000'
const EMAIL = 'maya@northline.app'
const PASSWORD = 'correct horse battery staple'
const NEW_PASSWORD = 'an entirely different passphrase'
const ORIGIN = 'http://localhost:5173'
let deps: TestDeps
let app: ReturnType<typeof createApp>
let secrets: Map<string, string>
let key: DeviceKey
let otherKey: DeviceKey
let jkt: string

beforeAll(async () => {
  key = await generateSoftwareDeviceKey()
  otherKey = await generateSoftwareDeviceKey()
  jkt = await jwkThumbprint(key.publicJwk)
})

beforeEach(async () => {
  secrets = new Map()
  deps = createTestDeps()
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  await seedApiKey(deps, PK)
  app = createApp(deps)
})

interface Options {
  client?: string
  /** The `DPoP` header. */
  proof?: string
  origin?: string
  cookie?: string
}

const ATTEMPT_PATH = /^\/(?:sign-ups|sign-ins|password-resets)\/([^/]+)\//

async function post(path: string, body: unknown = {}, options: Options = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-tula-publishable-key': PK,
    'x-tula-client': options.client ?? 'ios',
  }
  if (options.proof !== undefined) {
    headers[DPOP_HEADER] = options.proof
  }
  if (options.origin) {
    headers.origin = options.origin
  }
  if (options.cookie) {
    headers.cookie = options.cookie
  }
  const secret = secrets.get(ATTEMPT_PATH.exec(path)?.[1] ?? '')
  if (secret) {
    headers[FLOW_ATTEMPT_HEADER] = secret
  }
  const res = await app.request(`/v1/client${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const started = (await res
    .clone()
    .json()
    .catch(() => null)) as Partial<FlowAttempt> | null
  if (started?.id && started.attemptSecret) {
    secrets.set(started.id, started.attemptSecret)
  }
  return res
}

const json = async <T>(res: Response) => (await res.json()) as T
const code = async (res: Response) => (await json<{ code: string }>(res)).code
const sentCode = () => /\b(\d{6})\b/.exec(deps.mailer.last().text)?.[1] ?? ''
const serverNonce = () => DeviceBinding.nonce(deps, TEST_TENANT)
const proof = async (path: string, signer: DeviceKey = key, nonce?: string | null) =>
  proofFor(signer, {
    now: deps.clock.now(),
    path: `/v1/client${path}`,
    nonce: nonce === null ? undefined : (nonce ?? (await serverNonce())),
  })

/** A start that binds, the way a client does it: once without a nonce, then with the one given. */
async function boundStart(path: string, body: unknown, signer: DeviceKey = key) {
  const challenged = await post(path, body, { proof: await proof(path, signer, null) })
  expect(challenged.status).toBe(400)
  expect(await code(challenged)).toBe('device.nonce_required')
  const nonce = challenged.headers.get(DPOP_NONCE_HEADER)
  expect(nonce).toBe(await serverNonce())
  expect(challenged.headers.get('cache-control')).toBe('no-store')
  const started = await post(path, body, { proof: await proof(path, signer, nonce) })
  expect(started.status).toBe(200)
  expect(started.headers.get(DPOP_NONCE_HEADER)).toBe(await serverNonce())
  return json<FlowAttempt>(started)
}

async function signUp(signer?: DeviceKey) {
  const body = { email: EMAIL, password: PASSWORD, firstName: 'Maya' }
  const attempt = signer
    ? await boundStart('/sign-ups', body, signer)
    : await json<FlowAttempt>(await post('/sign-ups', body))
  return post(`/sign-ups/${attempt.id}/verify-email`, { code: sentCode() })
}

type Done = FlowAttempt & { session: NonNullable<FlowAttempt['session']> }

async function completed(res: Response): Promise<Done> {
  expect(res.status).toBe(200)
  const done = await json<FlowAttempt>(res)
  expect(done.step.status).toBe('complete')
  return done as Done
}

const stored = (sessionId: string) => deps.sessions.findById(TEST_TENANT.environmentId, sessionId)

const refresh = (refreshToken: string | undefined, dpop?: string) =>
  post('/sessions/refresh', { refreshToken }, { proof: dpop })

describe('a start that brings a proof binds the session the attempt ends in', () => {
  test('a sign-up', async () => {
    const res = await signUp(key)
    const done = await completed(res)
    expect((await stored(done.session.sessionId))?.deviceThumbprint).toBe(jkt)
    expect(decodeJwt(done.session.accessToken as string).cnf).toEqual({ jkt })
    // The completion hands the client a nonce for its first refresh, and never in the body.
    expect(res.headers.get(DPOP_NONCE_HEADER)).toBe(await serverNonce())
    expect(done.session).not.toHaveProperty('proofNonce')
    expect(JSON.stringify(done)).not.toContain('proofNonce')
  })

  test('a sign-in with a password', async () => {
    await signUp()
    const attempt = await boundStart('/sign-ins', { identifier: EMAIL })
    const done = await completed(
      await post(`/sign-ins/${attempt.id}/password`, { password: PASSWORD })
    )
    expect((await stored(done.session.sessionId))?.deviceThumbprint).toBe(jkt)
  })

  test('a password reset that signs in', async () => {
    await signUp()
    deps.clock.advance('1m')
    const attempt = await boundStart('/password-resets', { email: EMAIL })
    const done = await completed(
      await post(`/password-resets/${attempt.id}/password`, {
        code: sentCode(),
        password: NEW_PASSWORD,
      })
    )
    expect((await stored(done.session.sessionId))?.deviceThumbprint).toBe(jkt)
  })

  test('the key is fixed at the start: a later step’s DPoP header adds, changes and removes nothing', async () => {
    await signUp()
    // Started unbound: a proof on the step that completes does not bind.
    const plain = await json<FlowAttempt>(await post('/sign-ins', { identifier: EMAIL }))
    const path = `/sign-ins/${plain.id}/password`
    const unbound = await completed(
      await post(path, { password: PASSWORD }, { proof: await proof(path) })
    )
    expect((await stored(unbound.session.sessionId))?.deviceThumbprint).toBeNull()
    // Started bound to one key: another key's proof, or rubbish, on the last step changes nothing.
    for (const later of [await proof('/sign-ins', otherKey), 'not.a.proof']) {
      const attempt = await boundStart('/sign-ins', { identifier: EMAIL })
      const done = await completed(
        await post(`/sign-ins/${attempt.id}/password`, { password: PASSWORD }, { proof: later })
      )
      expect((await stored(done.session.sessionId))?.deviceThumbprint).toBe(jkt)
    }
  })

  test('without a proof the session is unbound, as before, and no nonce is handed out', async () => {
    const res = await signUp()
    const done = await completed(res)
    expect((await stored(done.session.sessionId))?.deviceThumbprint).toBeNull()
    expect(res.headers.get(DPOP_NONCE_HEADER)).toBeNull()
    expect(decodeJwt(done.session.accessToken as string).cnf).toBeUndefined()
  })
})

describe('a start whose proof is not accepted starts nothing', () => {
  const STARTS: [string, unknown][] = [
    ['/sign-ups', { email: EMAIL, password: PASSWORD }],
    ['/sign-ins', { identifier: EMAIL }],
    ['/password-resets', { email: EMAIL }],
    ['/sign-ins/passkey', {}],
    ['/sign-ins/oauth', { provider: 'google', redirectUrl: 'https://app.northline.test/cb' }],
  ]

  describe.each(STARTS)('%s', (path, body) => {
    let created: ReturnType<typeof spyOn>
    beforeEach(() => {
      created = spyOn(deps.flowAttempts, 'create')
    })
    async function nothingStarted() {
      expect(created).not.toHaveBeenCalled()
      expect(deps.mailer.outbox).toEqual([])
    }

    test('an invalid proof is refused, never read as "not bound"', async () => {
      for (const bad of ['not.a.proof', '', await proof('/sessions/refresh')]) {
        const res = await post(path, body, { proof: bad })
        expect(res.status).toBe(401)
        expect(await code(res)).toBe('device.proof_invalid')
        expect(res.headers.get(DPOP_NONCE_HEADER)).toBeNull()
      }
      await nothingStarted()
    })

    test('a valid proof without the nonce is the challenge', async () => {
      const res = await post(path, body, { proof: await proof(path, key, null) })
      expect(res.status).toBe(400)
      expect(await code(res)).toBe('device.nonce_required')
      expect(res.headers.get(DPOP_NONCE_HEADER)).toBe(await serverNonce())
      await nothingStarted()
    })

    test('a browser’s proof is refused, valid or not', async () => {
      for (const sent of [await proof(path), 'not.a.proof']) {
        const res = await post(path, body, { client: 'web', proof: sent, origin: ORIGIN })
        expect(res.status).toBe(400)
        expect(await code(res)).toBe('device.binding_not_supported')
      }
      await nothingStarted()
    })

    test('a proof is good for one start', async () => {
      const once = await proof(path)
      await post(path, body, { proof: once })
      const again = await post(path, body, { proof: once })
      expect(await code(again)).toBe('device.proof_invalid')
    })
  })
})

describe('POST /v1/client/sessions/refresh for a bound session', () => {
  async function session() {
    return (await completed(await signUp(key))).session
  }
  const refreshProof = (signer: DeviceKey = key, nonce?: string | null) =>
    proof('/sessions/refresh', signer, nonce)

  test('the path a proof names is the route’s own', () => {
    expect(`/v1/client/sessions/refresh`).toBe(REFRESH_PATH)
  })

  test('with a proof: 200, rotated, cnf kept, a nonce in DPoP-Nonce and nothing of it in the body', async () => {
    const first = await session()
    const res = await refresh(first.refreshToken, await refreshProof())
    expect(res.status).toBe(200)
    expect(res.headers.get(DPOP_NONCE_HEADER)).toBe(await serverNonce())
    const next = await json<{ accessToken: string; refreshToken: string }>(res)
    expect(next.refreshToken).not.toBe(first.refreshToken)
    expect(decodeJwt(next.accessToken).cnf).toEqual({ jkt })
    expect(next).not.toHaveProperty('proofNonce')
  })

  test('without one: 401 device.proof_invalid, then the SAME refresh token works with a proof', async () => {
    const first = await session()
    const refused = await refresh(first.refreshToken)
    expect(refused.status).toBe(401)
    expect(await code(refused)).toBe('device.proof_invalid')
    expect(refused.headers.get(DPOP_NONCE_HEADER)).toBeNull()
    expect((await stored(first.sessionId))?.revokedAt).toBeNull()
    expect((await refresh(first.refreshToken, await refreshProof())).status).toBe(200)
  })

  test('a wrong key: 401 and no nonce, with or without one of its own', async () => {
    const first = await session()
    for (const nonce of [undefined, null]) {
      const res = await refresh(first.refreshToken, await refreshProof(otherKey, nonce))
      expect(res.status).toBe(401)
      expect(await code(res)).toBe('device.proof_invalid')
      expect(res.headers.get(DPOP_NONCE_HEADER)).toBeNull()
    }
  })

  test('a replayed proof: 401, the session alive', async () => {
    const first = await session()
    const once = await refreshProof()
    const next = await json<{ refreshToken: string }>(await refresh(first.refreshToken, once))
    const res = await refresh(next.refreshToken, once)
    expect(res.status).toBe(401)
    expect(await code(res)).toBe('device.proof_invalid')
    expect((await refresh(next.refreshToken, await refreshProof())).status).toBe(200)
  })

  test('a stale nonce: 400 device.nonce_required with a fresh one, and the retry works', async () => {
    const first = await session()
    const stale = await serverNonce()
    deps.clock.advance(2 * DeviceBinding.DPOP_NONCE_PERIOD_MS)
    const res = await refresh(first.refreshToken, await refreshProof(key, stale))
    expect(res.status).toBe(400)
    expect(await code(res)).toBe('device.nonce_required')
    const fresh = res.headers.get(DPOP_NONCE_HEADER)
    expect(fresh).toBe(await serverNonce())
    expect(fresh).not.toBe(stale)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect((await refresh(first.refreshToken, await refreshProof(key, fresh))).status).toBe(200)
  })

  test('a proof for the address a proxy or the Host header names is not for this API', async () => {
    const first = await session()
    const elsewhere = await proofFor(key, { now: deps.clock.now(), nonce: await serverNonce() })
    const res = await app.request('http://evil.example/v1/client/sessions/refresh', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tula-publishable-key': PK,
        host: 'evil.example',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
        [DPOP_HEADER]: elsewhere,
      },
      body: JSON.stringify({ refreshToken: first.refreshToken }),
    })
    // Named for PUBLIC_URL, it is accepted whatever host the request claims to be for.
    expect(res.status).toBe(200)
    const forHost = createDpopProof(key, {
      method: 'POST',
      url: 'https://evil.example/v1/client/sessions/refresh',
      nonce: await serverNonce(),
      now: deps.clock.now().getTime(),
    })
    const next = await json<{ refreshToken: string }>(res)
    const refused = await app.request('http://evil.example/v1/client/sessions/refresh', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tula-publishable-key': PK,
        host: 'evil.example',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
        [DPOP_HEADER]: await forHost,
      },
      body: JSON.stringify({ refreshToken: next.refreshToken }),
    })
    expect(refused.status).toBe(401)
  })

  test('past the limit of refused proofs: 429 with Retry-After, the session alive', async () => {
    const first = await session()
    for (let i = 0; i < DeviceBinding.PROOF_REFUSALS_PER_MINUTE; i++) {
      await refresh(first.refreshToken)
    }
    const res = await refresh(first.refreshToken)
    expect(res.status).toBe(429)
    expect(await code(res)).toBe('rate_limited')
    expect((await stored(first.sessionId))?.revokedAt).toBeNull()
  })

  test('an unbound session’s refresh ignores a DPoP header and hands out no nonce', async () => {
    const first = (await completed(await signUp())).session
    const res = await refresh(first.refreshToken, 'not.a.proof')
    expect(res.status).toBe(200)
    expect(res.headers.get(DPOP_NONCE_HEADER)).toBeNull()
  })
})

describe('CORS', () => {
  test('a preflight may send DPoP, and a page may read DPoP-Nonce', async () => {
    const preflight = await app.request('/v1/client/sessions/refresh', {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'dpop',
      },
    })
    expect(preflight.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('dpop')
    const res = await post('/sign-ins', { identifier: EMAIL }, { origin: ORIGIN })
    expect(res.headers.get('access-control-expose-headers')).toContain(DPOP_NONCE_HEADER)
  })
})
