import { beforeEach, describe, expect, test } from 'bun:test'
import { createApp } from '~/index'
import * as Sessions from '~/modules/session/service'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'

const SK = 'tula_sk_dev_adminsessions000000000000000000000'
const PROD_SK = 'tula_sk_prod_adminsessions00000000000000000000'
const MISSING = '00000000-0000-7000-8000-00000000dead'
const tenant = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }

let deps: TestDeps
let app: ReturnType<typeof createApp>
let adminKeyId: string

beforeEach(async () => {
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
  adminKeyId = (await seedApiKey(deps, SK)).id
  await seedApiKey(deps, PROD_SK, { environmentId: TEST_TENANT.productionEnvironmentId })
  app = createApp(deps)
})

function admin(method: string, path: string, key = SK) {
  return app.request(`/v1/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  })
}

async function user(email = 'ada@example.com'): Promise<string> {
  const res = await app.request('/v1/admin/users', {
    method: 'POST',
    headers: { authorization: `Bearer ${SK}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { id: string }).id
}

const signIn = (userId: string, client: 'web' | 'ios' = 'web') =>
  Sessions.create(deps, tenant, {
    userId,
    client,
    userAgent: 'Mozilla/5.0 (Macintosh)',
    ipAddress: '203.0.113.7',
  })

interface Listed {
  data: Array<{ id: string; client: string; current: boolean; ipAddress: string | null }>
}

describe('GET /v1/admin/users/:userId/sessions', () => {
  test('lists the user’s active sessions, most recently active first, with no token material', async () => {
    const userId = await user()
    const first = await signIn(userId, 'web')
    deps.clock.advance('1m')
    const second = await signIn(userId, 'ios')
    const someoneElse = await user('grace@example.com')
    await signIn(someoneElse)

    const res = await admin('GET', `/users/${userId}/sessions`)
    expect(res.status).toBe(200)
    // Devices and IP addresses of one user: no cache may keep them.
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as Listed
    expect(body.data.map((item) => [item.id, item.client])).toEqual([
      [second.sessionId, 'ios'],
      [first.sessionId, 'web'],
    ])
    // An admin is not one of the user's devices.
    expect(body.data.every((item) => item.current === false)).toBe(true)
    const text = JSON.stringify(body)
    for (const tokens of [first, second]) {
      expect(text).not.toContain(tokens.accessToken)
      if (tokens.refreshToken) {
        expect(text).not.toContain(tokens.refreshToken)
      }
    }
  })

  test('a revoked session is not listed', async () => {
    const userId = await user()
    const kept = await signIn(userId)
    const ended = await signIn(userId)
    expect((await admin('DELETE', `/users/${userId}/sessions/${ended.sessionId}`)).status).toBe(204)
    const body = (await (await admin('GET', `/users/${userId}/sessions`)).json()) as Listed
    expect(body.data.map((item) => item.id)).toEqual([kept.sessionId])
  })

  test('an unknown user, a malformed id and another environment’s user are refused', async () => {
    const userId = await user()
    await signIn(userId)
    expect((await admin('GET', `/users/${MISSING}/sessions`)).status).toBe(404)
    expect((await admin('GET', '/users/not-a-uuid/sessions')).status).toBe(422)
    // The production key does not see the development environment's user.
    expect((await admin('GET', `/users/${userId}/sessions`, PROD_SK)).status).toBe(404)
    expect((await app.request(`/v1/admin/users/${userId}/sessions`)).status).toBe(401)
  })
})

describe('GET /v1/admin/sessions/:sessionId', () => {
  test('one session by its id: whose it is, what kind of client, and that it is active', async () => {
    const userId = await user()
    const session = await signIn(userId, 'ios')
    const res = await admin('GET', `/sessions/${session.sessionId}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toEqual({
      id: session.sessionId,
      userId,
      active: true,
      client: 'ios',
      userAgent: 'Mozilla/5.0 (Macintosh)',
      ipAddress: '203.0.113.7',
      createdAt: deps.clock.now().toISOString(),
      lastActiveAt: deps.clock.now().toISOString(),
      expiresAt: expect.any(String),
      current: false,
      deviceBound: false,
    })
    // Never token material, and nothing of a key.
    const text = JSON.stringify(body)
    expect(text).not.toContain(session.accessToken)
    expect(text).not.toMatch(/token|thumbprint|hash/i)
  })

  test('an ended session is still read, and said as not active: revoked, and past its expiry', async () => {
    const userId = await user()
    const revoked = await signIn(userId)
    const idle = await signIn(userId)
    expect((await admin('DELETE', `/users/${userId}/sessions/${revoked.sessionId}`)).status).toBe(
      204
    )
    const read = async (id: string) =>
      (await (await admin('GET', `/sessions/${id}`)).json()) as { active: boolean; userId: string }
    expect(await read(revoked.sessionId)).toMatchObject({ active: false, userId })
    expect(await read(idle.sessionId)).toMatchObject({ active: true })
    const stored = await deps.sessions.findById(tenant.environmentId, idle.sessionId)
    deps.clock.set(new Date((stored?.idleExpiresAt.getTime() ?? 0) - 1))
    expect(await read(idle.sessionId)).toMatchObject({ active: true })
    deps.clock.set(new Date(stored?.idleExpiresAt.getTime() ?? 0))
    expect(await read(idle.sessionId)).toMatchObject({ active: false })
  })

  test('an unknown session and another environment’s are the same 404; a malformed id is refused', async () => {
    const userId = await user()
    const session = await signIn(userId)
    const unknown = await admin('GET', `/sessions/${MISSING}`)
    const foreign = await admin('GET', `/sessions/${session.sessionId}`, PROD_SK)
    expect(unknown.status).toBe(404)
    expect(foreign.status).toBe(404)
    expect(await foreign.json()).toEqual(await unknown.json())
    expect((await admin('GET', '/sessions/not-an-id')).status).toBe(422)
  })

  test('it needs a key, and changes nothing', async () => {
    const userId = await user()
    const session = await signIn(userId)
    const bare = await app.request(`/v1/admin/sessions/${session.sessionId}`)
    expect(bare.status).toBe(401)
    const before = deps.activityLog.entries.length
    const stored = await deps.sessions.findById(tenant.environmentId, session.sessionId)
    expect((await admin('GET', `/sessions/${session.sessionId}`)).status).toBe(200)
    expect(deps.activityLog.entries).toHaveLength(before)
    expect(await deps.sessions.findById(tenant.environmentId, session.sessionId)).toEqual(stored)
  })
})

describe('DELETE /v1/admin/users/:userId/sessions/:sessionId', () => {
  test('ends that one session, records it as the admin’s, and refuses its access token', async () => {
    const userId = await user()
    const kept = await signIn(userId)
    const ended = await signIn(userId)

    const res = await admin('DELETE', `/users/${userId}/sessions/${ended.sessionId}`)
    expect(res.status).toBe(204)
    const stored = await deps.sessions.findById(tenant.environmentId, ended.sessionId)
    expect(stored?.revokeReason).toBe('revoked_by_admin')
    expect(
      (await deps.sessions.findById(tenant.environmentId, kept.sessionId))?.revokedAt
    ).toBeNull()
    // The denylist stops the unexpired access token.
    expect(await deps.revokedSessions.has(ended.sessionId, deps.clock.now())).toBe(true)
    expect(await deps.revokedSessions.has(kept.sessionId, deps.clock.now())).toBe(false)

    const entries = deps.activityLog
      .ofType('session.revoked')
      .filter((entry) => entry.target.id === ended.sessionId)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      actor: { type: 'admin', id: adminKeyId },
      data: { reason: 'revoked_by_admin' },
    })

    // Idempotent: nothing more is recorded.
    expect((await admin('DELETE', `/users/${userId}/sessions/${ended.sessionId}`)).status).toBe(204)
    expect(
      deps.activityLog.ofType('session.revoked').filter((e) => e.target.id === ended.sessionId)
    ).toHaveLength(1)
  })

  test('a session of another user, an unknown one and another environment’s are the same 404', async () => {
    const userId = await user()
    const other = await user('grace@example.com')
    const theirs = await signIn(other)
    const mine = await signIn(userId)

    const answers: string[] = []
    for (const res of [
      await admin('DELETE', `/users/${userId}/sessions/${theirs.sessionId}`),
      await admin('DELETE', `/users/${userId}/sessions/${MISSING}`),
      await admin('DELETE', `/users/${MISSING}/sessions/${mine.sessionId}`),
      await admin('DELETE', `/users/${userId}/sessions/${mine.sessionId}`, PROD_SK),
    ]) {
      expect(res.status).toBe(404)
      const body = (await res.json()) as Record<string, unknown>
      answers.push(JSON.stringify({ ...body, requestId: undefined }))
    }
    expect(new Set(answers).size).toBe(1)
    // Nothing was ended.
    for (const tokens of [theirs, mine]) {
      const stored = await deps.sessions.findById(tenant.environmentId, tokens.sessionId)
      expect(stored?.revokedAt).toBeNull()
    }
    expect(deps.activityLog.ofType('session.revoked')).toEqual([])
    expect((await admin('DELETE', `/users/${userId}/sessions/nope`)).status).toBe(422)
  })
})
