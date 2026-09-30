import { describe, expect, test } from 'bun:test'
import { ACCESS_TOKEN_VERSION, type Jwk } from '@tula/contract'
import { Hono } from 'hono'
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose'
import type { AppEnv } from '~/dependencies'
import { onError } from '~/handlers'
import { createApp } from '~/index'
import { sha256Hex } from '~/lib/crypto'
import { PUBLISHABLE_KEY_HEADER, publishableKey } from '~/middleware/publishable-key'
import { sessionAuth } from '~/middleware/session-auth'
import { RETIRED_KEY_RETENTION_MS } from '~/ports/signing-key-store'
import { createTestDeps, TEST_CONFIG } from '~/testing'

const PK = 'tula_pk_dev_publishable0000000000000000000'
const TENANT = { projectId: 'p1', environmentId: 'e1' }

async function signingKey(kid: string) {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' })
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'EdDSA', use: 'sig' } as Jwk
  return { jwk, privateKey }
}

const active = await signingKey('kid-active')
const stranger = await signingKey('kid-stranger')

function claims(deps: ReturnType<typeof createTestDeps>, overrides: JWTPayload = {}): JWTPayload {
  const iat = Math.floor(deps.clock.now().getTime() / 1000)
  return {
    iss: TEST_CONFIG.publicUrl,
    sub: 'user-1',
    aud: TENANT.environmentId,
    sid: 'session-1',
    pid: TENANT.projectId,
    eid: TENANT.environmentId,
    iat,
    exp: iat + 60,
    v: ACCESS_TOKEN_VERSION,
    ...overrides,
  }
}

function sign(
  payload: JWTPayload,
  key: CryptoKey = active.privateKey,
  header: Record<string, unknown> = { alg: 'EdDSA', kid: 'kid-active' }
) {
  return new SignJWT(payload).setProtectedHeader(header as { alg: string }).sign(key)
}

function setup() {
  const deps = createTestDeps()
  deps.apiKeys.insert(sha256Hex(PK), { id: 'pk1', kind: 'publishable', ...TENANT, revokedAt: null })
  deps.signingKeys.add({ environmentId: TENANT.environmentId, jwk: active.jwk, status: 'active' })
  const app = createApp(deps)
  app.get('/test/me', publishableKey(), sessionAuth(), (c) => c.json(c.get('session')))
  const call = (token?: string) =>
    app.request('/test/me', {
      headers: {
        [PUBLISHABLE_KEY_HEADER]: PK,
        ...(token !== undefined && { authorization: `Bearer ${token}` }),
      },
    })
  return { deps, call }
}

async function expectCode(res: Response, code: string) {
  const body = (await res.json()) as { code: string }
  expect({ status: res.status, code: body.code }).toEqual({ status: 401, code })
}

function b64(value: object) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

describe('sessionAuth', () => {
  test('accepts a valid token and exposes its claims', async () => {
    const { deps, call } = setup()
    const res = await call(await sign(claims(deps)))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ sub: 'user-1', sid: 'session-1' })
  })

  test('requires a token', async () => {
    const { call } = setup()
    await expectCode(await call(), 'auth.unauthenticated')
  })

  test('reports an expired token as session.expired', async () => {
    const { deps, call } = setup()
    const token = await sign(claims(deps))
    deps.clock.advance('61s')
    await expectCode(await call(token), 'session.expired')
  })

  test('accepts a token signed by a key retired within the retention window', async () => {
    const deps = createTestDeps()
    deps.apiKeys.insert(sha256Hex(PK), {
      id: 'pk1',
      kind: 'publishable',
      ...TENANT,
      revokedAt: null,
    })
    deps.signingKeys.add({
      environmentId: TENANT.environmentId,
      jwk: active.jwk,
      status: 'retired',
      retiredAt: deps.clock.now(),
    })
    const app = createApp(deps)
    app.get('/test/me', publishableKey(), sessionAuth(), (c) => c.json(c.get('session')))
    const request = async () =>
      app.request('/test/me', {
        headers: {
          [PUBLISHABLE_KEY_HEADER]: PK,
          authorization: `Bearer ${await sign(claims(deps))}`,
        },
      })
    expect((await request()).status).toBe(200)
    deps.clock.advance(RETIRED_KEY_RETENTION_MS)
    await expectCode(await request(), 'session.invalid_token')
  })

  test.each<[string, (deps: ReturnType<typeof createTestDeps>) => Promise<string>]>([
    ['a forged signature', (deps) => sign(claims(deps), stranger.privateKey)],
    [
      'an unknown kid',
      (deps) => sign(claims(deps), stranger.privateKey, { alg: 'EdDSA', kid: 'kid-stranger' }),
    ],
    ['a missing kid', (deps) => sign(claims(deps), active.privateKey, { alg: 'EdDSA' })],
    ['another issuer', (deps) => sign(claims(deps, { iss: 'https://evil.test' }))],
    ['another audience', (deps) => sign(claims(deps, { aud: 'e2' }))],
    ['another environment', (deps) => sign(claims(deps, { eid: 'e2' }))],
    ['another project', (deps) => sign(claims(deps, { pid: 'p2' }))],
    ['a missing session id', (deps) => sign(claims(deps, { sid: undefined }))],
    ['a future claim layout', (deps) => sign(claims(deps, { v: 2 }))],
    [
      'alg none',
      async (deps) => `${b64({ alg: 'none', kid: 'kid-active' })}.${b64(claims(deps))}.`,
    ],
    [
      'HS256 keyed with the public key (algorithm confusion)',
      async (deps) =>
        new SignJWT(claims(deps))
          .setProtectedHeader({ alg: 'HS256', kid: 'kid-active' })
          .sign(new TextEncoder().encode(active.jwk.x)),
    ],
    ['garbage', async () => 'not.a.jwt'],
    ['a non-JSON header', async () => 'e30.e30.e30x'],
  ])('rejects %s as session.invalid_token', async (_, makeToken) => {
    const { deps, call } = setup()
    await expectCode(await call(await makeToken(deps)), 'session.invalid_token')
  })

  test('surfaces key-store outages as a 500, not an auth failure', async () => {
    const { deps, call } = setup()
    const token = await sign(claims(deps))
    deps.signingKeys.verificationKeys = async () => {
      throw new Error('database down')
    }
    const res = await call(token)
    expect(res.status).toBe(500)
    expect(((await res.json()) as { code: string }).code).toBe('internal')
  })

  test('fails closed when mounted without publishableKey', async () => {
    const app = new Hono<AppEnv>()
    app.use(async (c, next) => {
      c.set('deps', createTestDeps())
      await next()
    })
    app.onError(onError)
    app.get('/misconfigured', sessionAuth(), (c) => c.text('reached'))
    const res = await app.request('/misconfigured', { headers: { authorization: 'Bearer x' } })
    expect(res.status).toBe(500)
  })
})
