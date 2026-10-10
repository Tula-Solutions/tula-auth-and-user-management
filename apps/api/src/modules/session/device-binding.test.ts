import { beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  DEFAULT_MOBILE_SESSION_PROFILE,
  type DeviceKey,
  durationToMs,
  jwkThumbprint,
  type SessionTokens,
} from '@tula/contract'
import { decodeJwt } from 'jose'
import type { Tenant } from '~/dependencies'
import { NonceRequiredError, ServiceException, ServiceUnavailableError } from '~/exceptions'
import { sha256Hex } from '~/lib/crypto'
import * as logger from '~/lib/logger'
import * as Audit from '~/modules/audit/service'
import * as DeviceBinding from '~/modules/session/device-binding'
import * as Sessions from '~/modules/session/service'
import { createTestDeps, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'
import { craftProof, generateSoftwareDeviceKey, proofFor, REFRESH_PATH } from '~/testing/proofs'

const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const otherTenant: Tenant = { ...tenant, environmentId: TEST_TENANT.productionEnvironmentId }
const USER = '00000000-0000-7000-8000-0000000000a1'
const GRACE = durationToMs(DEFAULT_MOBILE_SESSION_PROFILE.refresh.reuseGracePeriod as string)
const ORIGIN = { ipAddress: '198.51.100.9', userAgent: 'thief/1.0' }
let deps: TestDeps
let key: DeviceKey
let otherKey: DeviceKey

beforeAll(async () => {
  key = await generateSoftwareDeviceKey()
  otherKey = await generateSoftwareDeviceKey()
})

beforeEach(() => {
  deps = createTestDeps()
  for (const [id, kind] of [
    [TEST_TENANT.environmentId, 'development'],
    [TEST_TENANT.productionEnvironmentId, 'production'],
  ] as const) {
    deps.environments.add({
      id,
      projectId: TEST_TENANT.projectId,
      kind,
      createdAt: deps.clock.now(),
    })
  }
})

async function bound(with_: DeviceKey = key, scope: Tenant = tenant): Promise<SessionTokens> {
  return Sessions.create(deps, scope, {
    userId: USER,
    client: 'ios',
    userAgent: 'App/1.0',
    ipAddress: '203.0.113.7',
    deviceThumbprint: await jwkThumbprint(with_.publicJwk),
  })
}

function rt(tokens: SessionTokens): string {
  if (!tokens.refreshToken) {
    throw new Error('expected a refresh token')
  }
  return tokens.refreshToken
}

const serverNonce = (scope: Tenant = tenant) => DeviceBinding.nonce(deps, scope)

/** A proof of `signer` for the refresh route, with the server's nonce unless told otherwise. */
async function prove(
  signer: DeviceKey = key,
  options: { nonce?: string | null; jti?: string } = {}
): Promise<DeviceBinding.ProofRequest> {
  const nonce = options.nonce === null ? undefined : (options.nonce ?? (await serverNonce()))
  return {
    proof: await proofFor(signer, { now: deps.clock.now(), nonce, jti: options.jti }),
    method: 'POST',
    path: REFRESH_PATH,
  }
}

const header = (proof: string | undefined): DeviceBinding.ProofRequest => ({
  proof,
  method: 'POST',
  path: REFRESH_PATH,
})

const refresh = (token: string, proof?: DeviceBinding.ProofRequest, scope: Tenant = tenant) =>
  Sessions.refresh(deps, scope, token, ORIGIN, proof)

async function rejection(promise: Promise<unknown>): Promise<ServiceException> {
  try {
    await promise
  } catch (err) {
    if (err instanceof ServiceException) {
      return err
    }
    throw err
  }
  throw new Error('expected a rejection')
}

/** Everything a refused refresh must leave as it was. */
async function stateOf(token: string) {
  const found = await deps.sessions.findToken(tenant.environmentId, sha256Hex(token))
  if (!found) {
    throw new Error('expected the token to exist')
  }
  return {
    usedAt: found.token.usedAt,
    replacedById: found.token.replacedById,
    revokedAt: found.session.revokedAt,
    revokeReason: found.session.revokeReason,
    lastActiveAt: found.session.lastActiveAt,
    idleExpiresAt: found.session.idleExpiresAt,
  }
}

const refusals = () => deps.activityLog.ofType('session.refresh_proof_refused')

describe('a session bound to a key', () => {
  test('stores the thumbprint, says so in its event with nothing of the key, and carries cnf.jkt', async () => {
    const tokens = await bound()
    const jkt = await jwkThumbprint(key.publicJwk)
    expect(
      (await deps.sessions.findById(tenant.environmentId, tokens.sessionId))?.deviceThumbprint
    ).toBe(jkt)
    expect(decodeJwt(tokens.accessToken as string).cnf).toEqual({ jkt })
    const [created] = deps.activityLog.ofType('session.created')
    expect(created?.data).toMatchObject({ deviceBound: true })
    expect(JSON.stringify([deps.activityLog.entries, deps.activityLog.events])).not.toContain(jkt)
    expect(JSON.stringify([deps.activityLog.entries, deps.activityLog.events])).not.toContain(
      key.publicJwk.x
    )
  })

  test('is handed a nonce with its first tokens', async () => {
    const tokens = (await bound()) as Sessions.IssuedSession
    expect(tokens.proofNonce).toBe(await serverNonce())
  })

  test.each([
    ['a browser', { client: 'web' as const }],
    ['a stateful profile', { client: 'web' as const, profile: 'stateful' }],
  ])('is refused for %s, and nothing is created', async (_name, extra) => {
    const err = await rejection(
      Sessions.create(deps, tenant, {
        userId: USER,
        userAgent: null,
        ipAddress: null,
        deviceThumbprint: await jwkThumbprint(key.publicJwk),
        ...extra,
      })
    )
    expect(err.code).toBe('device.binding_not_supported')
    expect(deps.activityLog.ofType('session.created')).toEqual([])
  })
})

describe('refreshing a bound session', () => {
  test('with a proof of its key rotates, keeps cnf.jkt and hands out the next nonce', async () => {
    const first = await bound()
    const next = (await refresh(rt(first), await prove())) as Sessions.IssuedSession
    expect(next.sessionId).toBe(first.sessionId)
    expect(rt(next)).not.toBe(rt(first))
    expect(decodeJwt(next.accessToken as string).cnf).toEqual({
      jkt: await jwkThumbprint(key.publicJwk),
    })
    expect(next.proofNonce).toBe(await serverNonce())
    expect(refusals()).toEqual([])
    // And again, with the token it was given and a new proof.
    expect((await refresh(rt(next), await prove())).sessionId).toBe(first.sessionId)
  })

  test('the nonce of the period before is still accepted, the one before that is not', async () => {
    const first = await bound()
    const old = await serverNonce()
    deps.clock.advance(DeviceBinding.DPOP_NONCE_PERIOD_MS)
    const next = await refresh(rt(first), await prove(key, { nonce: old }))
    deps.clock.advance(DeviceBinding.DPOP_NONCE_PERIOD_MS)
    const err = await rejection(refresh(rt(next), await prove(key, { nonce: old })))
    expect(err.code).toBe('device.nonce_required')
  })

  test.each([
    ['no nonce', null],
    ['a made-up nonce', 'f'.repeat(64)],
    ['an empty nonce', ''],
  ])(
    'a right proof with %s is asked for the nonce: not counted, not recorded, nothing rotated',
    async (_name, nonce) => {
      const first = await bound()
      const before = await stateOf(rt(first))
      const err = await rejection(refresh(rt(first), await prove(key, { nonce })))
      expect(err).toBeInstanceOf(NonceRequiredError)
      expect(err.code).toBe('device.nonce_required')
      expect(err.status).toBe(400)
      expect((err as NonceRequiredError).nonce).toBe(await serverNonce())
      expect(await stateOf(rt(first))).toEqual(before)
      expect(refusals()).toEqual([])
      expect(deps.proofReplay.size).toBe(0)
      // The same token, with the nonce it was just given.
      const next = await refresh(
        rt(first),
        await prove(key, { nonce: (err as NonceRequiredError).nonce })
      )
      expect(next.sessionId).toBe(first.sessionId)
    }
  )

  test('another environment’s nonce is not this one’s', async () => {
    const first = await bound()
    const err = await rejection(
      refresh(rt(first), await prove(key, { nonce: await serverNonce(otherTenant) }))
    )
    expect(err.code).toBe('device.nonce_required')
  })

  test('a wrong key is never given a nonce, with or without one of its own', async () => {
    const first = await bound()
    for (const nonce of [null, undefined]) {
      const err = await rejection(refresh(rt(first), await prove(otherKey, { nonce })))
      expect(err.code).toBe('device.proof_invalid')
      expect(err).not.toBeInstanceOf(NonceRequiredError)
    }
  })
})

/** Every way a refresh can come without a valid proof of the session's key. */
const WITHOUT_A_PROOF: [string, string, () => Promise<DeviceBinding.ProofRequest | undefined>][] = [
  ['no proof passed at all', 'missing', async () => undefined],
  ['no DPoP header', 'missing', async () => header(undefined)],
  ['an empty header', 'invalid', async () => header('')],
  ['something that is no proof', 'invalid', async () => header('not.a.proof')],
  ['a proof of another key', 'wrong_key', () => prove(otherKey)],
  [
    'a proof for another route',
    'invalid',
    async () =>
      header(
        await proofFor(key, {
          now: deps.clock.now(),
          nonce: await serverNonce(),
          path: '/v1/client/sign-ins',
        })
      ),
  ],
  [
    'a proof for another method',
    'invalid',
    async () =>
      header(
        await proofFor(key, { now: deps.clock.now(), nonce: await serverNonce(), method: 'GET' })
      ),
  ],
  [
    'a proof made six minutes ago',
    'invalid',
    async () =>
      header(
        await proofFor(key, {
          now: new Date(deps.clock.now().getTime() - 6 * 60_000),
          nonce: await serverNonce(),
        })
      ),
  ],
  [
    'a proof from six minutes ahead',
    'invalid',
    async () =>
      header(
        await proofFor(key, {
          now: new Date(deps.clock.now().getTime() + 6 * 60_000),
          nonce: await serverNonce(),
        })
      ),
  ],
  [
    'a proof whose signature is another key’s',
    'invalid',
    async () =>
      header(
        await craftProof(
          key,
          { now: deps.clock.now(), nonce: await serverNonce() },
          { signWith: otherKey }
        )
      ),
  ],
  [
    'a proof with an algorithm off the list',
    'invalid',
    async () =>
      header(
        await craftProof(
          key,
          { now: deps.clock.now(), nonce: await serverNonce() },
          { header: { alg: 'EdDSA' } }
        )
      ),
  ],
]

describe('the order: a refresh without a valid proof changes nothing', () => {
  describe.each(WITHOUT_A_PROOF)('%s', (_name, reason, make) => {
    test('a fresh token: not rotated, not marked, session alive; then the same token works', async () => {
      const first = await bound()
      const before = await stateOf(rt(first))
      const err = await rejection(refresh(rt(first), await make()))
      expect(err.code).toBe('device.proof_invalid')
      expect(err.status).toBe(401)
      expect(await stateOf(rt(first))).toEqual(before)
      expect(deps.activityLog.ofType('session.reuse_detected')).toEqual([])
      expect(deps.activityLog.ofType('session.revoked')).toEqual([])
      expect(refusals().map((entry) => entry.data)).toEqual([
        { userId: USER, reason, suppressedInPreviousMinute: 0 },
      ])
      // The device itself, with the very same refresh token.
      const next = await refresh(rt(first), await prove())
      expect(next.sessionId).toBe(first.sessionId)
      expect(rt(next)).not.toBe(rt(first))
    })

    test('a token rotated inside the grace window: no child handed out, nothing marked', async () => {
      const first = await bound()
      const child = await refresh(rt(first), await prove())
      deps.clock.advance(GRACE - 1)
      const before = await stateOf(rt(first))
      const err = await rejection(refresh(rt(first), await make()))
      expect(err.code).toBe('device.proof_invalid')
      expect(await stateOf(rt(first))).toEqual(before)
      expect(deps.activityLog.ofType('session.reuse_detected')).toEqual([])
      // The child the device holds still works.
      expect((await refresh(rt(child), await prove())).sessionId).toBe(first.sessionId)
    })

    test('a token rotated past the grace window: the family is NOT revoked', async () => {
      const first = await bound()
      const child = await refresh(rt(first), await prove())
      deps.clock.advance(GRACE + 1000)
      const before = await stateOf(rt(first))
      const err = await rejection(refresh(rt(first), await make()))
      expect(err.code).toBe('device.proof_invalid')
      expect(await stateOf(rt(first))).toEqual(before)
      expect(before.revokedAt).toBeNull()
      expect(deps.activityLog.ofType('session.reuse_detected')).toEqual([])
      expect(await deps.revokedSessions.has(first.sessionId, deps.clock.now())).toBe(false)
      // The device is not signed out by someone who only copied a token.
      expect((await refresh(rt(child), await prove())).sessionId).toBe(first.sessionId)
    })
  })

  test('with a valid proof, a token rotated past the grace window still revokes the family', async () => {
    const first = await bound()
    const child = await refresh(rt(first), await prove())
    deps.clock.advance(GRACE + 1000)
    const err = await rejection(refresh(rt(first), await prove()))
    expect(err.code).toBe('session.reuse_detected')
    expect((await stateOf(rt(first))).revokeReason).toBe('reuse_detected')
    expect((await rejection(refresh(rt(child), await prove()))).code).toBe('session.reuse_detected')
  })

  async function bannedUser(): Promise<void> {
    await deps.users.create(
      {
        id: USER,
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        email: 'maya@northline.app',
        emailNormalized: 'maya@northline.app',
        emailVerifiedAt: deps.clock.now(),
        firstName: null,
        lastName: null,
        createdAt: deps.clock.now(),
        identityId: 'i1',
        credentialId: 'c1',
        passwordHash: 'hash',
      },
      Audit.none('fixture')
    )
    await deps.users.setBanned(
      tenant.environmentId,
      USER,
      deps.clock.now(),
      deps.clock.now(),
      Audit.none('fixture')
    )
  }

  // The proof comes before the ban is acted on: acting on it revokes the session, and that
  // is a write a request without the key must not reach (review round 1).
  test.each(WITHOUT_A_PROOF)(
    'a banned user’s session is not revoked for the ban without a proof: %s',
    async (_name, _reason, make) => {
      const first = await bound()
      await bannedUser()
      const before = await stateOf(rt(first))
      const err = await rejection(refresh(rt(first), await make()))
      expect(err.code).toBe('device.proof_invalid')
      expect(await stateOf(rt(first))).toEqual(before)
      expect(before.revokedAt).toBeNull()
      expect(deps.activityLog.ofType('session.revoked')).toEqual([])
      expect(await deps.revokedSessions.has(first.sessionId, deps.clock.now())).toBe(false)
    }
  )

  test('with a valid proof, a banned user’s refresh is refused for the ban and ends the session', async () => {
    const first = await bound()
    await bannedUser()
    const err = await rejection(refresh(rt(first), await prove()))
    expect(err.code).toBe('auth.user_banned')
    expect((await stateOf(rt(first))).revokeReason).toBe('user_banned')
    expect(await deps.revokedSessions.has(first.sessionId, deps.clock.now())).toBe(true)
  })

  // Pinned, not an oversight (ADR 0043, "Sign-out needs no proof").
  test('a sign-out needs no proof: the refresh token alone ends a bound session', async () => {
    const first = await bound()
    await Sessions.signOut(deps, tenant, rt(first), ORIGIN)
    expect((await stateOf(rt(first))).revokeReason).toBe('sign_out')
    expect(refusals()).toEqual([])
    expect((await rejection(refresh(rt(first), await prove()))).code).toBe('session.revoked')
  })

  test('what a copied token’s holder learns: unknown, ended, or bound; never more', async () => {
    const first = await bound()
    expect((await rejection(refresh('tula_rt_nope'))).code).toBe('session.invalid_token')
    expect((await rejection(refresh(rt(first)))).code).toBe('device.proof_invalid')
    await Sessions.revoke(deps, tenant, {
      userId: USER,
      sessionId: first.sessionId,
      actor: TEST_ACTOR,
    })
    // An ended session answers as it always did, proof or none: nothing is counted for it.
    const recorded = refusals().length
    expect((await rejection(refresh(rt(first)))).code).toBe('session.revoked')
    expect(refusals()).toHaveLength(recorded)
  })
})

describe('the grace window', () => {
  test('still requires a proof, and with one returns the same child', async () => {
    const first = await bound()
    const child = await refresh(rt(first), await prove())
    deps.clock.advance(GRACE - 1)
    expect((await rejection(refresh(rt(first)))).code).toBe('device.proof_invalid')
    const again = (await refresh(rt(first), await prove())) as Sessions.IssuedSession
    expect(rt(again)).toBe(rt(child))
    expect(again.proofNonce).toBe(await serverNonce())
    expect(decodeJwt(again.accessToken as string).cnf).toEqual({
      jkt: await jwkThumbprint(key.publicJwk),
    })
  })

  test('two refreshes at once, each with its own valid proof: one rotation, the same child', async () => {
    const first = await bound()
    const [a, b] = await Promise.all([
      refresh(rt(first), await prove()),
      refresh(rt(first), await prove()),
    ])
    expect(rt(a)).toBe(rt(b))
    expect((await stateOf(rt(first))).revokedAt).toBeNull()
    expect(refusals()).toEqual([])
  })

  test('two refreshes at once with ONE proof: one is refused as a replay, the session lives', async () => {
    const first = await bound()
    const one = await prove()
    const results = await Promise.allSettled([refresh(rt(first), one), refresh(rt(first), one)])
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect((await stateOf(rt(first))).revokedAt).toBeNull()
  })
})

describe('a proof is accepted once', () => {
  test('a replayed proof is refused, also for the token the first use produced', async () => {
    const first = await bound()
    const proof = await prove()
    const next = await refresh(rt(first), proof)
    const before = await stateOf(rt(next))
    const err = await rejection(refresh(rt(next), proof))
    expect(err.code).toBe('device.proof_invalid')
    expect(await stateOf(rt(next))).toEqual(before)
    expect(refusals().map((entry) => entry.data.reason)).toEqual(['replayed'])
  })

  test('the same jti under another key, and in another environment, is not a replay', async () => {
    const jti = 'one-id-used-by-two-keys'
    const mine = await bound(key)
    const theirs = await bound(otherKey)
    await refresh(rt(mine), await prove(key, { jti }))
    expect((await refresh(rt(theirs), await prove(otherKey, { jti }))).sessionId).toBe(
      theirs.sessionId
    )
    const elsewhere = await bound(key, otherTenant)
    const proof = {
      proof: await proofFor(key, {
        now: deps.clock.now(),
        nonce: await serverNonce(otherTenant),
        jti,
      }),
      method: 'POST',
      path: REFRESH_PATH,
    }
    expect((await refresh(rt(elsewhere), proof, otherTenant)).sessionId).toBe(elsewhere.sessionId)
  })

  test('an id is remembered for as long as its nonce is accepted, as a hash and never itself', async () => {
    const first = await bound()
    const remember = spyOn(deps.proofReplay, 'remember')
    const jti = 'a-recognisable-proof-id'
    await refresh(rt(first), await prove(key, { jti }))
    const [id, until] = remember.mock.calls[0] as [string, Date]
    expect(id).toMatch(/^[0-9a-f]{64}$/)
    expect(id).not.toContain(jti)
    const period = Math.floor(deps.clock.now().getTime() / DeviceBinding.DPOP_NONCE_PERIOD_MS)
    expect(until).toEqual(new Date((period + 2) * DeviceBinding.DPOP_NONCE_PERIOD_MS))
  })

  test('a refused proof is never remembered: only one that is otherwise good is', async () => {
    const first = await bound()
    await rejection(refresh(rt(first), await prove(otherKey)))
    await rejection(refresh(rt(first), header('not.a.proof')))
    await rejection(refresh(rt(first), await prove(key, { nonce: null })))
    expect(deps.proofReplay.size).toBe(0)
  })

  test('a proof bound to another session’s key refreshes neither that session’s token nor this one', async () => {
    const mine = await bound(key)
    const theirs = await bound(otherKey)
    // Their valid proof with my token, and my valid proof with theirs.
    expect((await rejection(refresh(rt(mine), await prove(otherKey)))).code).toBe(
      'device.proof_invalid'
    )
    expect((await rejection(refresh(rt(theirs), await prove(key)))).code).toBe(
      'device.proof_invalid'
    )
    expect(refusals().map((entry) => [entry.target.id, entry.data.reason])).toEqual([
      [mine.sessionId, 'wrong_key'],
      [theirs.sessionId, 'wrong_key'],
    ])
  })
})

describe('shared state fails closed', () => {
  const down = () => {
    throw new ServiceUnavailableError()
  }

  test('the store of used ids unavailable: 503, nothing rotated, nothing recorded', async () => {
    const first = await bound()
    const before = await stateOf(rt(first))
    const remember = spyOn(deps.proofReplay, 'remember').mockImplementation(down)
    const err = await rejection(refresh(rt(first), await prove()))
    expect(err.status).toBe(503)
    expect(err.code).toBe('service.unavailable')
    expect(await stateOf(rt(first))).toEqual(before)
    expect(refusals()).toEqual([])
    remember.mockRestore()
    expect((await refresh(rt(first), await prove())).sessionId).toBe(first.sessionId)
  })

  test('the limiter unavailable: a refusal is a 503, with no entry written uncounted', async () => {
    const first = await bound()
    const before = await stateOf(rt(first))
    const hit = spyOn(deps.rateLimiter, 'hit').mockImplementation(down)
    const err = await rejection(refresh(rt(first)))
    expect(err.status).toBe(503)
    expect(await stateOf(rt(first))).toEqual(before)
    expect(refusals()).toEqual([])
    // A refresh with a valid proof never asks the limiter: the device is not held up.
    expect((await refresh(rt(first), await prove())).sessionId).toBe(first.sessionId)
    hit.mockRestore()
  })
})

describe('refused proofs are counted and recorded', () => {
  test('past the limit the answer is rate_limited, the session alive and the device unaffected', async () => {
    const first = await bound()
    for (let i = 0; i < DeviceBinding.PROOF_REFUSALS_PER_MINUTE; i++) {
      expect((await rejection(refresh(rt(first)))).code).toBe('device.proof_invalid')
    }
    const before = await stateOf(rt(first))
    const err = await rejection(refresh(rt(first)))
    expect(err.code).toBe('rate_limited')
    expect(err.status).toBe(429)
    expect(await stateOf(rt(first))).toEqual(before)
    expect(before.revokedAt).toBeNull()
    // The device, with a valid proof, in the same minute.
    expect((await refresh(rt(first), await prove())).sessionId).toBe(first.sessionId)
  })

  test('one session’s refusals do not count against another', async () => {
    const [a, b] = [await bound(), await bound()]
    for (let i = 0; i <= DeviceBinding.PROOF_REFUSALS_PER_MINUTE; i++) {
      await rejection(refresh(rt(a)))
    }
    expect((await rejection(refresh(rt(b)))).code).toBe('device.proof_invalid')
  })

  test('one entry a minute, by the system, from the request’s origin, with a count of the minute before', async () => {
    // Start at the top of a minute so the windows are whole.
    const now = deps.clock.now().getTime()
    deps.clock.advance(60_000 - (now % 60_000))
    const first = await bound()
    for (let i = 0; i < 15; i++) {
      await rejection(refresh(rt(first), i === 0 ? await prove(otherKey) : undefined))
    }
    expect(refusals()).toHaveLength(1)
    expect(refusals()[0]).toMatchObject({
      type: 'session.refresh_proof_refused',
      actor: { type: 'system', id: null },
      ...ORIGIN,
      target: { type: 'session', id: first.sessionId },
      data: { userId: USER, reason: 'wrong_key', suppressedInPreviousMinute: 0 },
    })
    deps.clock.advance(60_000)
    await rejection(refresh(rt(first)))
    await rejection(refresh(rt(first)))
    expect(refusals().map((entry) => entry.data)).toEqual([
      { userId: USER, reason: 'wrong_key', suppressedInPreviousMinute: 0 },
      // Fifteen were refused in the minute before and one of them was written.
      { userId: USER, reason: 'missing', suppressedInPreviousMinute: 14 },
    ])
    // A quiet minute, then one: nothing of two minutes ago is reported.
    deps.clock.advance(120_000)
    await rejection(refresh(rt(first)))
    expect(refusals().at(-1)?.data.suppressedInPreviousMinute).toBe(0)
  })

  test('the limiter’s keys and the log line hold ids and a fixed word, nothing of the proof', async () => {
    const first = await bound()
    const hit = spyOn(deps.rateLimiter, 'hit')
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      const request = await prove(otherKey)
      await rejection(refresh(rt(first), request))
      const minute = Math.floor(deps.clock.now().getTime() / 60_000)
      expect(hit.mock.calls.map((call) => call[0])).toEqual([
        `refresh_proof_refused:${tenant.environmentId}:${first.sessionId}:${minute}`,
        `refresh_proof_refused:${tenant.environmentId}:${first.sessionId}:${minute - 1}`,
      ])
      expect(warn.mock.calls).toEqual([
        [
          'refresh of a device-bound session refused: no valid proof of its key',
          {
            environmentId: tenant.environmentId,
            sessionId: first.sessionId,
            userId: USER,
            reason: 'wrong_key',
          },
        ],
      ])
      const said = JSON.stringify([
        warn.mock.calls,
        [deps.activityLog.entries, deps.activityLog.events],
      ])
      for (const secret of [
        request.proof as string,
        rt(first),
        otherKey.publicJwk.x,
        await jwkThumbprint(otherKey.publicJwk),
        await jwkThumbprint(key.publicJwk),
      ]) {
        expect(said).not.toContain(secret)
      }
    } finally {
      hit.mockRestore()
      warn.mockRestore()
    }
  })

  test('the log line names the verifier’s finer reason', async () => {
    const first = await bound()
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      await rejection(refresh(rt(first), header('not.a.proof')))
      expect(warn.mock.calls[0]?.[1]).toMatchObject({ reason: 'malformed' })
    } finally {
      warn.mockRestore()
    }
  })
})

describe('an unbound session', () => {
  const unbound = () =>
    Sessions.create(deps, tenant, { userId: USER, client: 'ios', userAgent: null, ipAddress: null })

  test('has no thumbprint, no cnf, no deviceBound and no nonce', async () => {
    const tokens = (await unbound()) as Sessions.IssuedSession
    expect(
      (await deps.sessions.findById(tenant.environmentId, tokens.sessionId))?.deviceThumbprint
    ).toBeNull()
    expect(Object.keys(decodeJwt(tokens.accessToken as string)).sort()).toEqual(
      ['amr', 'aud', 'auth_time', 'eid', 'exp', 'iat', 'iss', 'pid', 'sid', 'sp', 'sub', 'v'].sort()
    )
    expect(deps.activityLog.ofType('session.created')[0]?.data).not.toHaveProperty('deviceBound')
    expect(tokens).not.toHaveProperty('proofNonce')
  })

  test('refreshes as before, whatever a DPoP header says: nothing is judged, counted or remembered', async () => {
    const hit = spyOn(deps.rateLimiter, 'hit')
    const first = await unbound()
    const next = (await refresh(rt(first), header('not.a.proof'))) as Sessions.IssuedSession
    expect(next).not.toHaveProperty('proofNonce')
    const third = await refresh(rt(next), await prove(otherKey))
    expect(decodeJwt(third.accessToken as string).cnf).toBeUndefined()
    expect(deps.proofReplay.size).toBe(0)
    expect(refusals()).toEqual([])
    expect(hit).not.toHaveBeenCalled()
    hit.mockRestore()
  })

  test('a replayed token past the grace window still revokes the family, as today', async () => {
    const first = await unbound()
    await refresh(rt(first))
    deps.clock.advance(GRACE + 1000)
    expect((await rejection(refresh(rt(first)))).code).toBe('session.reuse_detected')
  })
})

describe('binding at the start of an attempt', () => {
  const START = '/v1/client/sign-ins'
  const start = (proof: string | undefined, client: 'ios' | 'android' | 'web' = 'ios') =>
    DeviceBinding.atStart(deps, tenant, { proof, method: 'POST', path: START, client })
  const startProof = async (nonce?: string, signer = key) =>
    proofFor(signer, { now: deps.clock.now(), nonce, path: START })

  test('no proof means no binding, for every client kind', async () => {
    for (const client of ['ios', 'android', 'web'] as const) {
      expect(await start(undefined, client)).toBeNull()
    }
  })

  test('a valid proof with the nonce gives the key’s thumbprint and the next nonce', async () => {
    expect(await start(await startProof(await serverNonce()))).toEqual({
      thumbprint: await jwkThumbprint(key.publicJwk),
      nonce: await serverNonce(),
    })
  })

  test('a valid proof without the nonce is the challenge, and the repeat binds', async () => {
    const err = (await rejection(start(await startProof()))) as NonceRequiredError
    expect(err.code).toBe('device.nonce_required')
    expect((await start(await startProof(err.nonce)))?.thumbprint).toBe(
      await jwkThumbprint(key.publicJwk)
    )
  })

  test('a browser’s proof is refused, valid or not, before it is read', async () => {
    for (const proof of [await startProof(await serverNonce()), 'not.a.proof']) {
      expect((await rejection(start(proof, 'web'))).code).toBe('device.binding_not_supported')
    }
    expect(deps.proofReplay.size).toBe(0)
  })

  test.each([
    ['not a proof', async () => 'not.a.proof'],
    ['empty', async () => ''],
    [
      'for the refresh route',
      async () => proofFor(key, { now: deps.clock.now(), nonce: await serverNonce() }),
    ],
    [
      'signed by another key than it carries',
      async () =>
        craftProof(
          key,
          { now: deps.clock.now(), nonce: await serverNonce(), path: START },
          { signWith: otherKey }
        ),
    ],
  ])('an invalid proof (%s) is a refusal, never an unbound start', async (_name, make) => {
    const err = await rejection(start(await make()))
    expect(err.code).toBe('device.proof_invalid')
    expect(err.status).toBe(401)
  })

  test('a start’s proof is accepted once', async () => {
    const proof = await startProof(await serverNonce())
    await start(proof)
    expect((await rejection(start(proof))).code).toBe('device.proof_invalid')
  })

  test('the store of used ids unavailable: 503', async () => {
    const remember = spyOn(deps.proofReplay, 'remember').mockImplementation(() => {
      throw new ServiceUnavailableError()
    })
    expect((await rejection(start(await startProof(await serverNonce())))).status).toBe(503)
    remember.mockRestore()
  })

  test('a trailing slash on PUBLIC_URL does not change the address a proof names', async () => {
    deps = createTestDeps({ config: { ...deps.config, publicUrl: `${deps.config.publicUrl}/` } })
    expect(await start(await startProof(await serverNonce()))).not.toBeNull()
  })
})

describe('the nonce', () => {
  test('changes with the period and the environment, and is the same on every instance', async () => {
    const now = await serverNonce()
    expect(now).toMatch(/^[0-9a-f]{64}$/)
    expect(await DeviceBinding.nonce(createTestDeps({ clock: deps.clock }), tenant)).toBe(now)
    expect(await serverNonce(otherTenant)).not.toBe(now)
    deps.clock.advance(DeviceBinding.DPOP_NONCE_PERIOD_MS)
    expect(await serverNonce()).not.toBe(now)
  })
})
