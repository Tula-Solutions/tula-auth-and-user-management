import { beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  type DeviceKey,
  DPOP_HEADER,
  DPOP_NONCE_HEADER,
  jwkThumbprint,
  type HybridSessionTokens as SessionTokens,
} from '@tula/contract'
import { decodeJwt } from 'jose'
import { createApp } from '~/index'
import * as Audit from '~/modules/audit/service'
import * as DeviceBinding from '~/modules/session/device-binding'
import * as Sessions from '~/modules/session/service'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'
import { generateSoftwareDeviceKey, proofFor, REFRESH_PATH } from '~/testing/proofs'

// Device binding (ADR 0043) beside a texted code as the second factor (ADR 0025, TULA-46).
//
// The two were written apart. What must hold where they meet: a route that only needs the
// session (enrolling a texted code, asking for one to step up with, removing it) asks a bound
// session for no proof; a step-up by texted code moves `amr` and nothing of the binding, and
// its new access token still says which key the session is bound to; and the refresh of that
// session needs a proof exactly as before.

const PK = 'tula_pk_dev_publishable0000000000000000000'
const SCOPE = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }
const USER = '0198c0de-0000-7000-8000-00000000d019'
const NUMBER = '+14155550142'

let deps: TestDeps
let app: ReturnType<typeof createApp>
let key: DeviceKey
let jkt: string

beforeAll(async () => {
  key = await generateSoftwareDeviceKey()
  jkt = await jwkThumbprint(key.publicJwk)
})

beforeEach(async () => {
  deps = createTestDeps()
  deps.clock.set(new Date('2026-10-09T09:00:00.000Z'))
  deps.environments.add({
    id: SCOPE.environmentId,
    projectId: SCOPE.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  await seedApiKey(deps, PK)
  deps.environmentSettings.seed(SCOPE.environmentId, {
    revision: 1,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      mfa: { policy: 'optional', smsCode: { enabled: true } },
      sms: { enabled: true, allowedCountries: ['US'], dailyMessageLimit: 500, templates: {} },
    },
  })
  const now = deps.clock.now()
  await deps.users.create(
    {
      id: USER,
      ...SCOPE,
      email: 'maya@northline.app',
      emailNormalized: 'maya@northline.app',
      emailVerifiedAt: now,
      firstName: null,
      lastName: null,
      createdAt: now,
      identityId: `${USER}-identity`,
      credentialId: `${USER}-credential`,
      passwordHash: await Bun.password.hash('correct horse battery staple', {
        algorithm: 'argon2id',
        memoryCost: 8,
        timeCost: 1,
      }),
    } as Parameters<typeof deps.users.create>[0],
    Audit.none('fixture')
  )
  await deps.users.setPhoneNumber(
    SCOPE.environmentId,
    USER,
    NUMBER,
    now,
    Audit.none('fixture'),
    Audit.none('fixture')
  )
  app = createApp(deps)
})

interface Sent {
  token?: string
  proof?: string
}

function call(method: string, path: string, body: unknown, sent: Sent = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-tula-client': 'ios',
    'x-tula-publishable-key': PK,
  }
  if (sent.token) {
    headers.authorization = `Bearer ${sent.token}`
  }
  if (sent.proof) {
    headers[DPOP_HEADER] = sent.proof
  }
  return app.request(`/v1/client${path}`, {
    method,
    headers,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
}

const post = (path: string, body: unknown, sent?: Sent) => call('POST', path, body, sent)
const codeOf = async (res: Response) => ((await res.json()) as { code: string }).code
const textedCode = () =>
  /code is (\d{6})\./.exec(deps.sms.messages(NUMBER).at(-1)?.text ?? '')?.[1] ?? ''
const stored = (sessionId: string) => deps.sessions.findById(SCOPE.environmentId, sessionId)
const refreshProof = async () =>
  proofFor(key, {
    now: deps.clock.now(),
    path: REFRESH_PATH,
    nonce: await DeviceBinding.nonce(deps, SCOPE),
  })

/** A session bound to the device key, as a sign-in with a password would have made it. */
function boundSession(): Promise<SessionTokens> {
  return Sessions.create(deps, SCOPE, {
    userId: USER,
    client: 'ios',
    userAgent: 'App/1.0',
    authMethods: ['pwd'],
    deviceThumbprint: jkt,
  }) as Promise<SessionTokens>
}

describe('a bound session and a texted code as the second factor', () => {
  test('enrolling, stepping up and removing ask for no proof; the binding and `cnf` stay; the refresh still needs one', async () => {
    const first = await boundSession()
    expect(decodeJwt(first.accessToken).cnf).toEqual({ jkt })

    // Enrolment: two routes that need the session only. No `DPoP` header is sent.
    const started = await post('/me/factors/sms', {}, { token: first.accessToken })
    expect(started.status).toBe(200)
    expect(started.headers.get(DPOP_NONCE_HEADER)).toBeNull()
    const confirmed = await post(
      '/me/factors/sms/confirm',
      { code: textedCode() },
      { token: first.accessToken }
    )
    expect(confirmed.status).toBe(200)
    const enrolled = await stored(first.sessionId)
    expect(enrolled?.deviceThumbprint).toBe(jkt)
    expect([...(enrolled?.authMethods ?? [])].sort()).toEqual(['pwd', 'sms'])

    // Past the send limit's minute and the access token's life: the refresh is the one
    // route that asks for the key, exactly as before the factor was there.
    deps.clock.advance('2m')
    const bare = await post('/sessions/refresh', { refreshToken: first.refreshToken })
    expect(bare.status).toBe(401)
    expect(await codeOf(bare)).toBe('device.proof_invalid')
    const refreshed = await post(
      '/sessions/refresh',
      { refreshToken: first.refreshToken },
      { proof: await refreshProof() }
    )
    expect(refreshed.status).toBe(200)
    const second = (await refreshed.json()) as SessionTokens
    expect(decodeJwt(second.accessToken)).toMatchObject({ cnf: { jkt }, sid: first.sessionId })
    expect([...(decodeJwt(second.accessToken).amr as string[])].sort()).toEqual(['pwd', 'sms'])

    // The step-up by texted code: asked for and proven with the access token alone.
    const asked = await post('/sessions/step-up/sms-code', {}, { token: second.accessToken })
    expect(asked.status).toBe(200)
    const before = decodeJwt(second.accessToken).auth_time as number
    deps.clock.advance('30s')
    const steppedUp = await post(
      '/sessions/step-up',
      { method: 'sms_code', code: textedCode() },
      { token: second.accessToken }
    )
    expect(steppedUp.status).toBe(200)
    const third = (await steppedUp.json()) as { accessToken: string }
    const claims = decodeJwt(third.accessToken)
    // `recordAuthentication` moved the time and left the key the session is bound to.
    expect(claims.cnf).toEqual({ jkt })
    expect(claims.auth_time as number).toBeGreaterThan(before)
    expect([...(claims.amr as string[])].sort()).toEqual(['pwd', 'sms'])
    expect((await stored(first.sessionId))?.deviceThumbprint).toBe(jkt)
    expect(deps.activityLog.ofType('session.refresh_proof_refused')).toHaveLength(1)

    // Removing the factor, with the stepped-up token and no proof.
    const removed = await call('DELETE', '/me/factors/sms', undefined, {
      token: third.accessToken,
    })
    expect(removed.status).toBeLessThan(300)
    const after = await stored(first.sessionId)
    expect(after?.deviceThumbprint).toBe(jkt)
    expect(after?.revokedAt).toBeNull()

    // And the refresh is where it was: refused without the key, rotated with it.
    const again = await post('/sessions/refresh', { refreshToken: second.refreshToken })
    expect(await codeOf(again)).toBe('device.proof_invalid')
    const last = await post(
      '/sessions/refresh',
      { refreshToken: second.refreshToken },
      { proof: await refreshProof() }
    )
    expect(last.status).toBe(200)
    expect(decodeJwt(((await last.json()) as SessionTokens).accessToken).cnf).toEqual({ jkt })
  })

  test('a proof sent to a route that reads none changes nothing about it', async () => {
    const first = await boundSession()
    // Garbage where a proof would go: these routes never look.
    const started = await post(
      '/me/factors/sms',
      {},
      { token: first.accessToken, proof: 'not.a.proof' }
    )
    expect(started.status).toBe(200)
    expect(started.headers.get(DPOP_NONCE_HEADER)).toBeNull()
    expect(deps.activityLog.ofType('session.refresh_proof_refused')).toEqual([])
  })
})
